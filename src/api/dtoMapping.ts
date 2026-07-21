/**
 * Wire → model mapping. Turns a `CanonEntityDetailWire` (what the live API returns) into
 * the plugin's `CanonEntity`. This is the ONE place the real-API shape meets the vault model:
 *
 *  - field renames: `title` → name (thread/hook/lore), rumor `text` → name+body,
 *    `status` → the type-specific status, hook `heat` int → string.
 *  - DM-only fold: the NPC performance card (speech/body-language/temperament/signature/want),
 *    the rumor `truth`, and every `secrets[]` row become `DmOnlyFacet`s → rendered in the
 *    note's `%% dm_only %%` body region (NEVER frontmatter — that isn't stripped on export).
 *  - links: only OUTGOING edges (fromId === this entity) are carried; incoming edges surface
 *    naturally as Obsidian backlinks. Link targets are resolved to display names via the
 *    roster the caller collected from the entity cards; unknown targets fall back to the id.
 */
import {
  CanonBase,
  CanonEntity,
  CanonEntityType,
  CanonLink,
  CanonLinkType,
  CanonOrigin,
  CanonStatus,
  CanonViability,
  DmOnlyFacet,
  Visibility,
} from "../model/canon";
import {
  CanonEntityDetailWire,
  CanonLinkWire,
  CanonNpcWire,
  CanonRumorWire,
  CanonSecretWire,
} from "./wire";

/** Resolve a target entity to its display name, for rendering `[[wikilinks]]`. */
export type NameResolver = (entityType: string, id: string) => string | undefined;

/** Fields shared by every wire payload (the CanonBase source columns). */
interface CommonWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  createdUtc: string;
  updatedUtc: string;
}

export function mapDetailToCanon(
  detail: CanonEntityDetailWire,
  resolveName: NameResolver,
  tenantId: string
): CanonEntity | null {
  const outgoing = (w: CommonWire): CanonLink[] =>
    detail.links.filter((l) => l.fromId === w.id).map((l) => mapLink(l, resolveName));

  const secretFacets: DmOnlyFacet[] = detail.secrets.map((s: CanonSecretWire) => ({
    facet: s.facet,
    value: s.body ?? "",
  }));

  const base = (w: CommonWire, type: CanonEntityType, name: string): CanonBase => ({
    id: w.id,
    type,
    tenantId,
    campaignId: w.campaignId ?? null,
    canonStatus: w.canonStatus as CanonStatus,
    viability: w.viability as CanonViability,
    origin: w.origin as CanonOrigin,
    visibility: w.visibility as Visibility,
    name,
    createdUtc: w.createdUtc,
    updatedUtc: w.updatedUtc,
    links: outgoing(w),
  });

  switch (detail.entityType) {
    case "npc": {
      const w = detail.npc;
      if (!w) return null;
      return {
        ...base(w, "npc", w.name),
        title: opt(w.title),
        pronouns: opt(w.pronouns),
        imageUrl: opt(w.imageUrl),
        oneLine: opt(w.oneLine),
        description: opt(w.description),
        lifeStatus: (w.lifeStatus as CanonNpcWire["lifeStatus"]) as never,
        disposition: opt(w.disposition),
        fromCharacterId: opt(w.fromCharacterId),
        dmOnly: [...performanceCard(w), ...secretFacets],
      } as CanonEntity;
    }
    case "location": {
      const w = detail.location;
      if (!w) return null;
      return {
        ...base(w, "location", w.name),
        kind: opt(w.kind),
        parentLocationId: opt(w.parentLocationId),
        imageUrl: opt(w.imageUrl),
        referenceMapUrl: opt(w.referenceMapUrl),
        oneLine: opt(w.oneLine),
        description: opt(w.description),
        placeStatus: opt(w.placeStatus) as never,
        dmOnly: secretFacets,
      } as CanonEntity;
    }
    case "thread": {
      const w = detail.thread;
      if (!w) return null;
      return {
        ...base(w, "thread", w.title),
        oneLine: opt(w.oneLine),
        currentState: opt(w.currentState),
        threadStatus: w.status as never,
        tract: opt(w.tract),
        resolution: opt(w.resolution),
        spawnedFromHookId: opt(w.spawnedFromHookId),
        dmOnly: secretFacets,
      } as CanonEntity;
    }
    case "hook": {
      const w = detail.hook;
      if (!w) return null;
      return {
        ...base(w, "hook", w.title),
        oneLine: opt(w.oneLine),
        context: opt(w.context),
        hookStatus: w.status as never,
        leftByUserId: opt(w.leftByUserId),
        leftInAdventureId: opt(w.leftInAdventureId),
        spawnedAdventureId: opt(w.spawnedAdventureId),
        continuesThreadId: opt(w.continuesThreadId),
        heat: w.heat != null ? String(w.heat) : undefined,
        dmOnly: secretFacets,
      } as CanonEntity;
    }
    case "lore": {
      const w = detail.lore;
      if (!w) return null;
      return {
        ...base(w, "lore", w.title),
        body: opt(w.body),
        category: opt(w.category),
        tags: w.tags ?? [],
        dmOnly: secretFacets,
      } as CanonEntity;
    }
    case "rumor": {
      const w = detail.rumor;
      if (!w) return null;
      // Rumor has no name — use a truncated label; the truth is DM-only → dm_only facet.
      const truthFacet: DmOnlyFacet[] =
        w.truth && w.truth.toLowerCase() !== "unknown" ? [{ facet: "truth", value: w.truth }] : [];
      return {
        ...base(w, "rumor", labelFrom(w.text)),
        oneLine: opt(w.text),
        body: opt(w.text),
        plantedByRole: (w.authorKind as CanonRumorWire["authorKind"]) as never,
        dmOnly: [...truthFacet, ...secretFacets],
      } as CanonEntity;
    }
    case "faction": {
      const w = detail.faction;
      if (!w) return null;
      return {
        ...base(w, "faction", w.name),
        oneLine: opt(w.oneLine),
        description: opt(w.description),
        disposition: opt(w.disposition),
        factionStatus: w.status,
        motto: opt(w.motto),
        dmOnly: secretFacets,
      } as CanonEntity;
    }
    default:
      return null;
  }
}

function mapLink(l: CanonLinkWire, resolveName: NameResolver): CanonLink {
  return {
    linkType: l.linkType as CanonLinkType,
    toType: l.toType as CanonEntityType | "character",
    toId: l.toId,
    toName: resolveName(l.toType, l.toId) ?? l.toId,
  };
}

/** The NPC performance card → DM-only facets (only the ones actually set). */
function performanceCard(w: CanonNpcWire): DmOnlyFacet[] {
  const out: DmOnlyFacet[] = [];
  if (w.speech) out.push({ facet: "speech", value: w.speech });
  if (w.bodyLanguage) out.push({ facet: "body language", value: w.bodyLanguage });
  if (w.temperament) out.push({ facet: "temperament", value: w.temperament });
  if (w.signaturePhrase) out.push({ facet: "signature phrase", value: w.signaturePhrase });
  if (w.want) out.push({ facet: "want", value: w.want });
  return out;
}

function labelFrom(text: string): string {
  const t = (text ?? "").trim();
  return t.length <= 60 ? t || "Untitled rumor" : t.slice(0, 57).trimEnd() + "…";
}

function opt(v: string | null | undefined): string | undefined {
  return v == null || v === "" ? undefined : v;
}
