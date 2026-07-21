/**
 * Export family — the `dm_only` STRIP (O4). "One strip, two renderers" (FLOWS_AND_PERSONAS):
 * player-vault export and the Homebrewery brew are the same operation — strip DM-only material,
 * then render. This module is the shared, renderer-agnostic strip; the Player Vault emitter lives
 * here, the Brew emitter (Homebrewery) rides the same strip as a fast-follow.
 *
 * Two kinds of DM-only material, matching how the vault stores it (see VaultMapper):
 *  1. Whole entities flagged `visibility: dm_only` in frontmatter → dropped entirely.
 *  2. Field-level secrets inside a `%% dm_only %% … %% /dm_only %%` fenced body region (the NPC
 *     performance card, rumor truth, secrets) → the fence + its contents are removed.
 *
 * Pure + dependency-light (only the frontmatter parser) so it is unit-testable headless.
 */
import { parseNote, serializeNote } from "../vault/frontmatter";

const DM_FENCE_OPEN = "%% dm_only %%";
const DM_FENCE_CLOSE = "%% /dm_only %%";

/** Plugin/sync bookkeeping a shared, read-only player vault shouldn't carry. */
const STRIP_FRONTMATTER_KEYS = [
  "taverntop_hash",
  "taverntop_synced_utc",
  "taverntop_updated_utc",
  "taverntop_created_utc",
  "_link_ids",
];

/** True when the whole note is a DM-only entity (visibility flag) → dropped from a player export. */
export function isDmOnlyNote(content: string): boolean {
  return String(parseNote(content).frontmatter.visibility ?? "") === "dm_only";
}

/**
 * Remove every `%% dm_only %% … %% /dm_only %%` fenced region from a note body. An unclosed fence
 * (defensive) strips to end-of-body — better to over-strip than leak a secret. Collapses the
 * blank runs a removal leaves behind.
 */
export function stripDmOnlyRegions(body: string): string {
  let out = body;
  for (let guard = 0; guard < 1000; guard++) {
    const open = out.indexOf(DM_FENCE_OPEN);
    if (open === -1) break;
    const close = out.indexOf(DM_FENCE_CLOSE, open);
    const end = close === -1 ? out.length : close + DM_FENCE_CLOSE.length;
    out = out.slice(0, open) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Project a harvested canon note to its player-safe form.
 *   - dm_only entity  → `null` (drop it from the export).
 *   - otherwise       → the note with dm_only fences removed + sync bookkeeping stripped.
 * Player Vault keeps the frontmatter + `[[wikilinks]]` (still a navigable Obsidian vault).
 */
export function stripNoteForPlayers(content: string): string | null {
  if (isDmOnlyNote(content)) return null;

  const { frontmatter, body } = parseNote(content);
  const clean = { ...frontmatter };
  for (const key of STRIP_FRONTMATTER_KEYS) delete clean[key];

  const strippedBody = stripDmOnlyRegions(body);
  return serializeNote(clean, strippedBody ? strippedBody + "\n" : "");
}
