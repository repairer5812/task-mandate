import type { Decision, RoutePolicy, VerifierConfig } from "@task-mandate/core";
import { CLAIM } from "@task-mandate/core/internal";
import { signRequest } from "@task-mandate/node";

interface Keys {
  agent: JsonWebKey;
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
  issue: (over?: { taskId?: string; task?: { type: string; resource?: string; params?: Record<string, unknown> } }) => Promise<string>;
  reserve: () => Request;
  dump: (req: Request) => Promise<Step["request"]>;
}

const DENY: Decision = { decision: "deny", code: "MANDATE_MALFORMED" };

function forge(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split("~")[0]!.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
  edit(claims);
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}~`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

export async function limitVectors(input: BuildInput): Promise<VectorFile[]> {
  const route = { requireTask: { type: "reserve", resource: "court-3" } };
  const config = { origin: input.site };
  const sign = (token: string) => signRequest(input.reserve(), { mandate: token, agentKey: input.keys.agent, now: input.now });
  const deny = async (name: string, token: string): Promise<VectorFile> => input.file(name, config, route, [{ request: await input.dump(await sign(token)), expected: DENY }]);

  const header = input.file("header-too-long", config, route, [{ request: await input.dump(new Request(`${input.site}/reserve`, { method: "POST", headers: { "content-type": "application/json", "agent-mandate": "x".repeat(8193) }, body: JSON.stringify({ facility: "court-3" }) })), expected: DENY }]);

  const tid = await input.withRandom("limit-tid", async () => deny("tid-too-long", await input.issue({ taskId: "t".repeat(129) })));

  const task = await input.withRandom("limit-task", async () => {
    const token = await input.issue({ task: { type: "reserve", resource: "court-3", params: { note: "n".repeat(9000) } } });
    if (byteLength(token) <= 8192) throw new Error("task info vector is below the header limit");
    return deny("header-oversize-task", token);
  });

  const jti = await input.withRandom("limit-jti", async () => {
    const token = forge(await input.issue(), (claims) => {
      claims[CLAIM.jti] = "j".repeat(129);
    });
    if (byteLength(token) > 8192) throw new Error("jti vector exceeds the header limit");
    return deny("jti-too-long", token);
  });

  const iss = await input.withRandom("limit-iss", async () => {
    const token = forge(await input.issue(), (claims) => {
      const long = "i".repeat(257);
      claims[CLAIM.iss] = long;
      claims[CLAIM.sub] = long;
    });
    if (byteLength(token) > 8192) throw new Error("iss vector exceeds the header limit");
    return deny("iss-too-long", token);
  });

  const sub = await input.withRandom("limit-sub", async () => {
    const token = forge(await input.issue(), (claims) => {
      claims[CLAIM.sub] = "s".repeat(257);
      claims[CLAIM.pa] = "p".repeat(32);
    });
    if (byteLength(token) > 8192) throw new Error("sub vector exceeds the header limit");
    return deny("sub-too-long", token);
  });

  const pa = await input.withRandom("limit-pa", async () => {
    const token = forge(await input.issue(), (claims) => {
      claims[CLAIM.pa] = "p".repeat(4097);
    });
    if (byteLength(token) > 8192) throw new Error("pa vector exceeds the header limit");
    return deny("pa-too-long", token);
  });

  return [header, tid, task, jti, iss, sub, pa];
}
