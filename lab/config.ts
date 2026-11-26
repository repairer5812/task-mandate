// Lab constants. The verifier keeps its default clock skew.
export const IDP_ISS = "https://idp.lab";
export const IDP_SECRET = "lab-idp-secret";
export const RESOURCE = "court-3";
export const FACILITY_BODY = JSON.stringify({ facility: RESOURCE });
export const SITES = [
  { id: "alpha", origin: "https://alpha.lab" },
  { id: "beta", origin: "https://beta.lab" },
  { id: "gamma", origin: "https://gamma.lab" },
] as const;

export const DAY_MS = 86_400_000;
export const PEOPLE = positive("LAB_PEOPLE", 200);
export const SEEDS = positive("LAB_SEEDS", 20);
export const DAYS = positive("LAB_DAYS", 7);
export const WORKER_MS = positive("LAB_WORKER_MS", 150_000);
export const AGENT_SKEW_MAX = 45;

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be an integer greater than or equal to 1`);
  return value;
}
