import { DEFAULT_CLOCK_SKEW_SEC, TaskMandateError } from "@task-mandate/core";
import { openMandate, unixSeconds } from "@task-mandate/core/internal";

// Refuse to send from second exp + 30 on, the boundary a verifier with the default skew uses.
export async function assertSendableMandate(mandate: string, requestUrl: string, now: Date): Promise<void> {
  const opened = await openMandate(mandate);
  if (!opened.ok) throw new TaskMandateError("INPUT_INVALID", "mandate signature or structure is invalid");
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    throw new TaskMandateError("INPUT_INVALID", "request URL is invalid");
  }
  if (opened.mandate.aud !== origin) {
    throw new TaskMandateError("INPUT_INVALID", "mandate audience does not match the request origin");
  }
  if (unixSeconds(now) >= opened.mandate.exp + DEFAULT_CLOCK_SKEW_SEC) {
    throw new TaskMandateError("INPUT_INVALID", "mandate is at or after exp plus 30 seconds");
  }
}
