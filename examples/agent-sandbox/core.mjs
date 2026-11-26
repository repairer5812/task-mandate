export async function newKeyPair() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return { publicKey: await crypto.subtle.exportKey("jwk", publicKey), privateKey: await crypto.subtle.exportKey("jwk", privateKey) };
}

export function checkResults(first, receipt, second, refusal) {
  if (first !== 200 || typeof receipt.receiptNo !== "string" || !/^MO-[A-Z0-9]{8}$/.test(receipt.receiptNo)) {
    throw new Error("The first mock application did not return a receipt");
  }
  if (second !== 403 || refusal.code !== "LIMIT_EXCEEDED") {
    throw new Error("The second mock application did not reach the one-action limit");
  }
}
