// Wire names (claims, header, vct, JOSE values, signature components) live only in this file.

/** Credential type and the HTTP header that carries a mandate. */
export const PROFILE = { vct: "urn:task-mandate:v0", header: "agent-mandate" } as const;

/** Claim names inside a mandate. */
export const CLAIM = { vct: "vct", iss: "iss", sub: "sub", aud: "aud", cnf: "cnf", jwk: "jwk", task: "task", type: "type", resource: "resource", params: "params", limits: "limits", maxActions: "maxActions", iat: "iat", nbf: "nbf", exp: "exp", jti: "jti", tid: "tid", tend: "tend", pa: "pa", tbeg: "tbeg" } as const;

/** JOSE header names and the required `typ` and `alg` values. */
export const JOSE = { typ: "typ", alg: "alg", kid: "kid", jwk: "jwk", typValue: "dc+sd-jwt", algValue: "EdDSA" } as const;

/** `typ` of a person attestation. */
export const PERSON = { typ: "person-attestation+jwt" } as const;

/** Signature component names a request must cover. */
export const COMPONENT = { method: "@method", authority: "@authority", path: "@path", query: "@query", mandate: PROFILE.header, contentDigest: "content-digest" } as const;

/** Prefix of `iss`. The rest is the principal key thumbprint. */
export const ISSUER_PREFIX = "urn:jwk-thumbprint:sha-256:";

/** Signature tag required on agent requests. */
export const SIGNATURE_TAG = "web-bot-auth";

/** Maximum signature age, in seconds. */
export const SIGNATURE_MAX_AGE_SEC = 300;
