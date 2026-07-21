/**
 * Content hash for conflict detection (the "detect + sidecar" stance).
 *
 * On every write the plugin stamps `taverntop_hash` into frontmatter over the note's
 * *meaningful* content (frontmatter minus its own bookkeeping keys, plus the body).
 * Before a push it re-hashes: if the live hash differs from the stamped one, the
 * user edited the note locally. Combined with the server's `updatedUtc`, that gives
 * a three-way picture: local-changed? server-changed? → clean push / conflict.
 *
 * djb2 is used (not crypto) — we need change-detection, not security, and it must
 * run identically on desktop and mobile with no Node crypto dependency.
 */
import { Frontmatter } from "./frontmatter";

/**
 * Frontmatter keys that are plugin/server bookkeeping and must NOT feed the content hash.
 * The `*_utc` timestamps are server-owned and change on every write, so hashing them would
 * make a re-stamp look like a content edit (and churn conflict detection) — exclude them so
 * the hash reflects only the note's meaningful content.
 */
const IGNORED_KEYS = new Set([
  "taverntop_hash",
  "taverntop_synced_utc",
  "taverntop_updated_utc",
  "taverntop_created_utc",
]);

/**
 * Bump this whenever the hash INPUTS change (IGNORED_KEYS, body normalization, the djb2 seed, …).
 * The stamp carries the version (`h2:abcd1234`); a stamp from a different version compares as
 * `unknown` (see compareHash), so callers RE-STAMP instead of false-conflicting. That's what makes
 * a hash-algo change migrate silently on the next Harvest instead of flooding the vault with
 * `.conflict.md` sidecars — which is exactly what a bare, unversioned hash did (UAT 2026-07-13).
 */
const HASH_VERSION = "h2";

export function hashNote(frontmatter: Frontmatter, body: string): string {
  const stableFm = Object.keys(frontmatter)
    .filter((k) => !IGNORED_KEYS.has(k))
    .sort()
    .map((k) => `${k}=${JSON.stringify(frontmatter[k])}`)
    .join("\n");
  return `${HASH_VERSION}:${djb2(`${stableFm}\n::body::\n${body.trim()}`)}`;
}

/**
 * Version-stamped hash of an arbitrary string. For notes we hold VERBATIM (the adventure-plan
 * export.md, whose nested `tt-canon:` / `tt-mon:` frontmatter we don't parse), the caller strips the
 * bookkeeping lines and hashes the rest with this — so re-Harvest can tell a genuine LOCAL edit from
 * a server/format change (same versioned semantics as compareHash).
 */
export function hashText(text: string): string {
  return `${HASH_VERSION}:${djb2(text)}`;
}

/**
 * Compare a stored `taverntop_hash` stamp to a freshly computed one. Cheap: no re-hashing of the
 * baseline (the stamp IS the baseline) — one hash of the current note, then a string compare.
 *   - "unchanged": same version + identical hash → untouched since last sync.
 *   - "edited"   : same version, hashes differ → the note was locally edited.
 *   - "unknown"  : stamp missing or a DIFFERENT hash version (the algo changed) → can't tell, so
 *                  the caller re-stamps (migrates) rather than treating it as a conflict.
 */
export function compareHash(stored: string | undefined, live: string): "unchanged" | "edited" | "unknown" {
  if (!stored) return "unknown";
  if (stored.split(":", 1)[0] !== live.split(":", 1)[0]) return "unknown"; // different (or no) version
  return stored === live ? "unchanged" : "edited";
}

function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
