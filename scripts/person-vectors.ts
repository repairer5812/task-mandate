import { type Decision, issuePersonAttestation, normalizePublicJwk, type RoutePolicy, type VerifierConfig } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";

const IDP = "https://idp.example";
const SECRET = "vector-only-pairwise-secret";
const OTHER = "https://other.example";

interface Keys {
  principal: JsonWebKey;
  agent: JsonWebKey;
  idp: JsonWebKey;
  agentKeyId: string;
}

interface Step {
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  expected: Decision;
}

interface VectorFile {
  name: string;
  now: string;
  config: VerifierConfig;
  route: RoutePolicy;
  steps: Step[];
}

interface BuildInput {
  keys: Keys;
  site: string;
  now: Date;
  withRandom: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  file: (name: string, config: VerifierConfig, route: RoutePolicy, steps: Step[]) => VectorFile;
  issue: (over?: { personAttestation?: string; taskId?: string; taskBegin?: Date }) => Promise<string>;
  reserve: () => Request;
  dump: (req: Request) => Promise<Step["request"]>;
  expectedAllow: (token: string, agentKeyId: string, route: RoutePolicy) => Decision;
}

async function attest(input: BuildInput, audience: string): Promise<string> {
  return issuePersonAttestation({ idpKey: input.keys.idp, idpIssuer: IDP, secret: SECRET, personId: "person-1", audience, principalPublicKey: input.keys.principal, durationSec: 86_400, now: input.now });
}

export async function personVectors(input: BuildInput): Promise<VectorFile[]> {
  const route = { requireTask: { type: "reserve", resource: "court-3" } };
  const issuers = [{ iss: IDP, jwks: [normalizePublicJwk(input.keys.idp)] }];
  const sign = (token: string) => signRequest(input.reserve(), { mandate: token, agentKey: input.keys.agent, now: input.now });

  const required = await input.withRandom("person-required", async () => {
    const token = await input.issue();
    return input.file("person-required", { origin: input.site, requirePerson: true, personIssuers: issuers }, route, [{ request: await input.dump(await sign(token)), expected: { decision: "deny", code: "PERSON_REQUIRED" } }]);
  });

  const invalid = await input.withRandom("person-invalid", async () => {
    const token = await input.issue({ personAttestation: await attest(input, OTHER) });
    return input.file("person-invalid", { origin: input.site, personIssuers: issuers }, route, [{ request: await input.dump(await sign(token)), expected: { decision: "deny", code: "PERSON_INVALID" } }]);
  });

  const superseded = await input.withRandom("superseded", async () => {
    const pa = await attest(input, input.site);
    const first = await input.issue({ personAttestation: pa, taskId: "task-a", taskBegin: input.now });
    const second = await input.issue({ personAttestation: pa, taskId: "task-b", taskBegin: input.now });
    const config = { origin: input.site, requirePerson: true, onePerPerson: true, personIssuers: issuers, minSwitchSec: 600 };
    return input.file("superseded", config, route, [
      { request: await input.dump(await sign(first)), expected: input.expectedAllow(first, input.keys.agentKeyId, route) },
      { request: await input.dump(await sign(second)), expected: { decision: "deny", code: "SUPERSEDED" } },
    ]);
  });

  const missingBegin = await input.withRandom("tid-without-tbeg", async () => {
    const token = await input.issue({ taskId: "task-1" });
    const [header, payload, signature] = token.split("~")[0]!.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { task: { resource: string } };
    claims.task.resource = "court-9";
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}~`;
    const config = { origin: input.site, requirePerson: true, onePerPerson: true, personIssuers: issuers, minSwitchSec: 600 };
    return input.file("tid-without-tbeg", config, route, [{ request: await input.dump(await sign(forged)), expected: { decision: "deny", code: "MANDATE_MALFORMED" } }]);
  });

  return [required, invalid, superseded, missingBegin];
}
