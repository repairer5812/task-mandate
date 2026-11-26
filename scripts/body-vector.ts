import type { Decision, RoutePolicy, VerifierConfig } from "@task-mandate/core";
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
  issue: () => Promise<string>;
  dump: (req: Request) => Promise<Step["request"]>;
}

export function bodyTooLargeVector(input: BuildInput): Promise<VectorFile> {
  const route = { requireTask: { type: "reserve", resource: "court-3" } };
  return input.withRandom("body-too-large", async () => {
    const token = await input.issue();
    const req = await signRequest(new Request(`${input.site}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(32) }), { mandate: token, agentKey: input.keys.agent, now: input.now });
    return input.file("body-too-large", { origin: input.site, maxBodyBytes: 16 }, route, [{ request: await input.dump(req), expected: { decision: "deny", code: "BODY_TOO_LARGE" } }]);
  });
}
