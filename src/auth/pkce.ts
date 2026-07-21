/**
 * PKCE (RFC 7636) + state primitives for the Authorization Code flow. Uses the Web Crypto
 * APIs Obsidian exposes (Chromium): crypto.getRandomValues + crypto.subtle.digest. No deps.
 *
 * The verifier is a high-entropy random string; the challenge is its base64url-encoded
 * SHA-256 (method S256). The verifier stays in memory on the plugin instance until the
 * redirect returns with the code, then it's sent to the token endpoint to prove we started
 * the flow. It is NEVER persisted to a note or to disk.
 */

export interface Pkce {
  verifier: string;
  challenge: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(len: number): Uint8Array {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return a;
}

/** A URL-safe random token (base64url of `byteLen` random bytes). Used for `state`. */
export function randomUrlSafe(byteLen = 32): string {
  return base64UrlEncode(randomBytes(byteLen));
}

/** Fresh PKCE pair. 32 random bytes → a 43-char base64url verifier (spec: 43–128 chars). */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomUrlSafe(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}
