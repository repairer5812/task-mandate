import type { MandateStore } from "./store";

export interface Env {
  MANDATE_STORE: DurableObjectNamespace<MandateStore>;
  ASSETS: Fetcher;
  ORIGIN: string;
  SEATS: string;
  PERSON_ISSUERS?: string;
  REQUIRE_PERSON?: string;
  ONE_PER_PERSON?: string;
  MIN_SWITCH_SEC?: string;
  MAX_LIFETIME_SEC?: string;
  MAX_TASK_SEC?: string;
  SEAT_RESET_SEC?: string;
  RESET_TOKEN?: string;
  FACTCHAT_API_KEY?: string;
  SIM_IDP_JWK?: string;
  SIM_PRESENTER_CODE?: string;
}
