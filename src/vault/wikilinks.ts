/**
 * `canon_link` edges ⇄ Obsidian `[[wikilinks]]`.
 *
 * A wikilink carries only a display name, but a `canon_link` needs (linkType, toType,
 * toId). We keep the durable half — the ids — in frontmatter and render the wikilink
 * for human navigation. Frontmatter groups links by edge type, e.g.:
 *
 *   member_of: ["[[The Faceless]]"]
 *   involves:  ["[[The Vault]]", "[[Thoren]]"]
 *   _link_ids: ["member_of|faction|fac-faceless", "involves|location|loc-0002", ...]
 *
 * The `_link_ids` array is the round-trip source of truth (survives renames); the
 * per-edge-type wikilink arrays are the human-facing, Graph-view-friendly projection.
 */
import { CanonLink, CanonLinkType } from "../model/canon";

const LINK_IDS_KEY = "_link_ids";

export function makeWikilink(name: string): string {
  return `[[${name}]]`;
}

/** Extract the display name from a `[[Name]]` or `[[Name|alias]]` token. */
export function parseWikilink(token: string): string | null {
  const m = token.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return m ? m[1].trim() : null;
}

/** Build the frontmatter fields that represent an entity's links. */
export function linksToFrontmatter(links: CanonLink[]): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  const linkIds: string[] = [];

  for (const link of links) {
    const key = link.linkType;
    (byType[key] ??= []).push(makeWikilink(link.toName));
    linkIds.push(`${link.linkType}|${link.toType}|${link.toId}|${link.toName}`);
  }

  return { ...byType, [LINK_IDS_KEY]: linkIds };
}

/**
 * Reconstruct links from frontmatter on pull-back. The `_link_ids` array is
 * authoritative for ids/types; the display name is refreshed from the matching
 * per-type wikilink if the user renamed the target note.
 */
export function linksFromFrontmatter(fm: Record<string, unknown>): CanonLink[] {
  const raw = fm[LINK_IDS_KEY];
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry): CanonLink | null => {
      const parts = String(entry).split("|");
      if (parts.length < 3) return null;
      const [linkType, toType, toId, toName] = parts;
      return {
        linkType: linkType as CanonLinkType,
        toType: toType as CanonLink["toType"],
        toId,
        toName: toName ?? toId,
      };
    })
    .filter((l): l is CanonLink => l !== null);
}

export const INTERNAL_LINK_KEY = LINK_IDS_KEY;
