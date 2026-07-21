/**
 * The vault canon model: how each Taverntop entity becomes a markdown note.
 *
 * Layout (folders per type, one note per entity):
 *   <root>/Canon/NPCs|Locations|Threads|Hooks|Lore|Rumors/<Name>.md
 *   <root>/Adventures/<Code> - <Title>.md
 *   <root>/Sessions/<Date> - <Title>.md
 *
 * Contract rules honored here:
 *  - `taverntop_id` (GUID) in frontmatter is the identity; the filename is a mutable
 *    human label. Renames are tolerated because sync keys off the id, not the path.
 *  - Typed `canon_link` edges render as `[[wikilinks]]` grouped by edge type, with a
 *    `_link_ids` array as the durable round-trip source (see wikilinks.ts).
 *  - Field-level `dm_only` facets live in a fenced `%% dm_only %%` region so a future
 *    player-vault export can strip them mechanically. Entity-level `visibility` is a
 *    frontmatter flag.
 */
import { normalizePath } from "obsidian";
import {
  Adventure,
  CanonEntity,
  CanonEntityType,
  CanonLore,
  DmOnlyFacet,
  GameSession,
} from "../model/canon";
import { Frontmatter, ParsedNote, parseNote, serializeNote } from "./frontmatter";
import { linksFromFrontmatter, linksToFrontmatter } from "./wikilinks";
import { hashNote } from "./noteHash";

const TYPE_FOLDER: Record<CanonEntityType, string> = {
  npc: "Canon/NPCs",
  location: "Canon/Locations",
  thread: "Canon/Threads",
  hook: "Canon/Hooks",
  lore: "Canon/Lore",
  rumor: "Canon/Rumors",
  faction: "Canon/Factions",
};

export const ADVENTURES_FOLDER = "Adventures";
export const SESSIONS_FOLDER = "Sessions";
export const PLUGIN_STATE_FOLDER = "_taverntop";

const DM_FENCE_OPEN = "%% dm_only %%";
const DM_FENCE_CLOSE = "%% /dm_only %%";

/** Characters Obsidian/OSes disallow in filenames. */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim() || "Untitled";
}

export function canonNotePath(root: string, type: CanonEntityType, name: string): string {
  return normalizePath(`${root}/${TYPE_FOLDER[type]}/${sanitizeFileName(name)}.md`);
}

export function adventureNotePath(root: string, adv: Adventure): string {
  const label = adv.code ? `${adv.code} - ${adv.title}` : adv.title;
  return normalizePath(`${root}/${ADVENTURES_FOLDER}/${sanitizeFileName(label)}.md`);
}

/**
 * Adventure PLANS (the Canvas prep docs) get a FOLDER each — `Adventures/<Title>/<Title>.md` — so
 * the DM can drop maps, handouts, and side-notes alongside the prose (the Obsidian "project" layout).
 */
export function adventurePlanNotePath(root: string, title: string): string {
  const safe = sanitizeFileName(title);
  return normalizePath(`${root}/${ADVENTURES_FOLDER}/${safe}/${safe}.md`);
}

export function sessionNotePath(root: string, s: GameSession): string {
  return normalizePath(`${root}/${SESSIONS_FOLDER}/${sanitizeFileName(`${s.date} - ${s.title}`)}.md`);
}

// ---- canon entity → note --------------------------------------------------

/** Serialize a canon entity to a full note string (frontmatter + body + hash stamp). */
export function canonToNote(entity: CanonEntity, syncedUtc: string): string {
  const fm: Frontmatter = {
    taverntop_id: entity.id,
    taverntop_type: entity.type,
    tenant_id: entity.tenantId,
    campaign_id: entity.campaignId,
    canon_status: entity.canonStatus,
    viability: entity.viability,
    origin: entity.origin,
    visibility: entity.visibility,
    name: entity.name,
    ...typeSpecificFrontmatter(entity),
    ...linksToFrontmatter(entity.links),
    taverntop_updated_utc: entity.updatedUtc,
    taverntop_synced_utc: syncedUtc,
  };

  const body = renderBody(entity);
  // Stamp the content hash last, over everything except bookkeeping keys.
  fm.taverntop_hash = hashNote(fm, body);
  return serializeNote(fm, body);
}

function typeSpecificFrontmatter(entity: CanonEntity): Frontmatter {
  switch (entity.type) {
    case "npc":
      return dropUndefined({
        title: entity.title,
        pronouns: entity.pronouns,
        life_status: entity.lifeStatus,
        disposition: entity.disposition,
        image_url: entity.imageUrl,
        from_character_id: entity.fromCharacterId,
      });
    case "location":
      return dropUndefined({
        kind: entity.kind,
        place_status: entity.placeStatus,
        parent_location_id: entity.parentLocationId,
        image_url: entity.imageUrl,
        reference_map_url: entity.referenceMapUrl,
      });
    case "thread":
      return dropUndefined({
        thread_status: entity.threadStatus,
        tract: entity.tract,
        resolution: entity.resolution,
        spawned_from_hook_id: entity.spawnedFromHookId,
      });
    case "hook":
      return dropUndefined({
        hook_status: entity.hookStatus,
        heat: entity.heat,
        left_by_user_id: entity.leftByUserId,
        left_in_adventure_id: entity.leftInAdventureId,
        claimed_by_user_id: entity.claimedByUserId,
        continues_thread_id: entity.continuesThreadId,
        spawned_adventure_id: entity.spawnedAdventureId,
      });
    case "lore":
      return dropUndefined({ category: entity.category, tags: entity.tags });
    case "rumor":
      // veracity (the DM truth value) is DM-only → it lives in the %% dm_only %% body region
      // as a "truth" facet, NEVER in frontmatter (frontmatter isn't stripped on export).
      return dropUndefined({ planted_by_role: entity.plantedByRole });
    case "faction":
      return dropUndefined({
        faction_status: entity.factionStatus,
        disposition: entity.disposition,
        motto: entity.motto,
      });
  }
}

function renderBody(entity: CanonEntity): string {
  const parts: string[] = [];

  const oneLine = (entity as { oneLine?: string }).oneLine;
  if (oneLine) parts.push(`> [!info] One-line\n> ${oneLine}\n`);

  const description = (entity as { description?: string }).description;
  if (description) parts.push(`## Description\n${description}\n`);

  if (entity.type === "thread" && entity.currentState) {
    parts.push(`## Current state\n${entity.currentState}\n`);
  }
  if (entity.type === "hook" && entity.context) {
    parts.push(`## Context\n${entity.context}\n`);
  }
  if (entity.type === "lore" && (entity as CanonLore).body) {
    parts.push(`${(entity as CanonLore).body}\n`);
  }
  if (entity.type === "rumor" && entity.body) {
    parts.push(`${entity.body}\n`);
  }

  const dmOnly = (entity as { dmOnly?: DmOnlyFacet[] }).dmOnly ?? [];
  if (dmOnly.length) {
    const facets = dmOnly
      .map((f) => `> [!secret] ${titleCase(f.facet)}\n> ${f.value}`)
      .join("\n\n");
    parts.push(`${DM_FENCE_OPEN}\n${facets}\n${DM_FENCE_CLOSE}\n`);
  }

  return parts.join("\n");
}

// ---- note → canon entity (pull-back on push) ------------------------------

/**
 * Parse a vault note back into a partial canon entity for push. We reconstruct the
 * durable fields (id, type, links, visibility, editable prose + dm_only facets). The
 * server remains the authority on server-owned fields (updatedUtc, canon_status).
 */
export function noteToCanon(content: string): { entity: CanonEntity; liveHash: string } | null {
  const parsed = parseNote(content);
  const fm = parsed.frontmatter;
  // A note with a `taverntop_type` but no `taverntop_id` is vault-authored NEW canon (push =
  // create); id stays "" as the create signal. `type` is required — without it we can't route.
  const id = str(fm.taverntop_id) ?? "";
  const type = str(fm.taverntop_type) as CanonEntityType | undefined;
  if (!type) return null;

  const liveHash = hashNote(fm, parsed.body);
  const base = {
    id,
    type,
    tenantId: str(fm.tenant_id) ?? "",
    campaignId: fm.campaign_id === null ? null : str(fm.campaign_id) ?? null,
    canonStatus: (str(fm.canon_status) ?? "provisional") as CanonEntity["canonStatus"],
    viability: (str(fm.viability) ?? "") as CanonEntity["viability"],
    origin: (str(fm.origin) ?? "manual") as CanonEntity["origin"],
    visibility: (str(fm.visibility) ?? "dm_only") as CanonEntity["visibility"],
    name: str(fm.name) ?? "Untitled",
    createdUtc: str(fm.taverntop_created_utc) ?? "",
    updatedUtc: str(fm.taverntop_updated_utc) ?? "",
    links: linksFromFrontmatter(fm),
  };

  const { description, sections, dmOnly } = extractBody(parsed);
  const oneLine = extractOneLine(parsed.body);

  // Assemble a type-correct entity. Fields absent from the note fall back to sane
  // defaults; the server merges against its stored copy.
  const entity = {
    ...base,
    oneLine,
    description,
    dmOnly,
    ...typeSpecificFromFrontmatter(fm, sections),
  } as unknown as CanonEntity;

  return { entity, liveHash };
}

function typeSpecificFromFrontmatter(fm: Frontmatter, sections: Record<string, string>) {
  return dropUndefined({
    title: str(fm.title),
    pronouns: str(fm.pronouns),
    lifeStatus: str(fm.life_status),
    disposition: str(fm.disposition),
    imageUrl: str(fm.image_url),
    kind: str(fm.kind),
    placeStatus: str(fm.place_status),
    parentLocationId: str(fm.parent_location_id),
    threadStatus: str(fm.thread_status),
    tract: str(fm.tract),
    currentState: sections["Current state"],
    context: sections["Context"],
    resolution: str(fm.resolution),
    hookStatus: str(fm.hook_status),
    heat: str(fm.heat),
    category: str(fm.category),
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : undefined,
    plantedByRole: str(fm.planted_by_role),
    veracity: str(fm.veracity),
  });
}

// ---- adventure / session → note (push down) -------------------------------

export function adventureToNote(adv: Adventure, syncedUtc: string): string {
  const fm: Frontmatter = {
    taverntop_id: adv.id,
    taverntop_type: "adventure",
    tenant_id: adv.tenantId,
    campaign_id: adv.campaignId,
    title: adv.title,
    code: adv.code ?? null,
    dungeon_master: adv.dungeonMasterName ?? null,
    session_id: adv.sessionId ?? null,
    taverntop_updated_utc: adv.updatedUtc,
    taverntop_synced_utc: syncedUtc,
  };

  const parts: string[] = [];
  if (adv.teaser) parts.push(`> [!quote] Teaser\n> ${adv.teaser}\n`);
  for (const act of adv.acts) {
    parts.push(`## ${act.title}${act.timebox ? `  _(${act.timebox})_` : ""}`);
    for (const beat of act.beats) {
      parts.push(`### ${beat.title}  \`${beat.kind}\``);
      if (beat.body) parts.push(beat.body);
      if (beat.canonRefs.length) {
        const refs = beat.canonRefs.map((r) => `[[${r.name}]]`).join(" · ");
        parts.push(`_Canon:_ ${refs}`);
      }
      parts.push("");
    }
  }
  const body = parts.join("\n");
  fm.taverntop_hash = hashNote(fm, body);
  return serializeNote(fm, body);
}

export function sessionToNote(s: GameSession, adventures: Adventure[], syncedUtc: string): string {
  const fm: Frontmatter = {
    taverntop_id: s.id,
    taverntop_type: "session",
    tenant_id: s.tenantId,
    campaign_id: s.campaignId,
    title: s.title,
    date: s.date,
    taverntop_updated_utc: s.updatedUtc,
    taverntop_synced_utc: syncedUtc,
  };
  const advLinks = adventures
    .filter((a) => s.adventureIds.includes(a.id))
    .map((a) => `- [[${a.code ? `${a.code} - ${a.title}` : a.title}]]`)
    .join("\n");
  const body = `## Adventures\n${advLinks || "_none linked_"}\n`;
  fm.taverntop_hash = hashNote(fm, body);
  return serializeNote(fm, body);
}

// ---- helpers --------------------------------------------------------------

function extractOneLine(body: string): string | undefined {
  const m = body.match(/> \[!info\] One-line\n> (.+)/);
  return m ? m[1].trim() : undefined;
}

function extractBody(parsed: ParsedNote): {
  description?: string;
  sections: Record<string, string>;
  dmOnly: DmOnlyFacet[];
} {
  const sections: Record<string, string> = {};
  const dmOnly: DmOnlyFacet[] = [];

  // Pull the dm_only fenced region out first.
  const openIdx = parsed.body.indexOf(DM_FENCE_OPEN);
  let visibleBody = parsed.body;
  if (openIdx !== -1) {
    const closeIdx = parsed.body.indexOf(DM_FENCE_CLOSE, openIdx);
    const region = parsed.body.slice(openIdx + DM_FENCE_OPEN.length, closeIdx === -1 ? undefined : closeIdx);
    visibleBody = parsed.body.slice(0, openIdx);
    for (const m of region.matchAll(/> \[!secret\] (.+)\n> (.+)/g)) {
      dmOnly.push({ facet: m[1].trim().toLowerCase(), value: m[2].trim() });
    }
  }

  // Split remaining visible body into `## Heading` sections.
  const headingRe = /^## (.+)$/gm;
  const matches = [...visibleBody.matchAll(headingRe)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : visibleBody.length;
    sections[name] = visibleBody.slice(start, end).trim();
  }

  return { description: sections["Description"], sections, dmOnly };
}

function dropUndefined<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]: Exclude<T[K], undefined> } {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj as { [K in keyof T]: Exclude<T[K], undefined> };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : v == null ? undefined : String(v);
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
