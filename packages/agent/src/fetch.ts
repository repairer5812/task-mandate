import { assertSendableMandate } from "./check.js";
import { type MandateSource, resolveMandate, signRequest } from "./sign.js";

/** Sign and send. Refuses a bad mandate, a mismatched audience, or `floor(now / 1000) >= exp + 30`. Does not follow redirects. */
export async function mandatedFetch(input: string | URL, init: RequestInit | undefined, opts: { mandate: MandateSource; agentKey: JsonWebKey; now?: Date }): Promise<Response> {
  const mandate = await resolveMandate(opts.mandate);
  const now = opts.now ?? new Date();
  const request = new Request(input, init);
  await assertSendableMandate(mandate, request.url, now);
  const signed = await signRequest(request, { mandate, agentKey: opts.agentKey, now });
  return fetch(new Request(signed, { redirect: "manual" }));
}
