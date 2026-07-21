/**
 * Model → wire mapping for PUSH (vault → app). The inverse of `dtoMapping.ts`.
 *
 * The Canon Engine write endpoints (`POST/PUT /api/canon/{type}`) take the SAME per-type
 * DTO the reads return (see `CanonController` + `CanonDtos.cs`), and — critically — they do a
 * **full-row UPDATE** (TW-2): every column is written from the DTO, and the update controller
 * does NOT re-default omitted vocab fields. So a naive "note → DTO → PUT" would null out
 * NOT-NULL columns (viability/visibility/…) and silently drop any field the vault doesn't
 * round-trip.
 *
 * The safe update therefore is **server-wire-as-base + overlay the vault-owned fields**:
 * start from the entity the server currently holds (fetched for the concurrency pre-check),
 * overlay only what the DM legitimately edits in the note, and PUT the whole. Structural /
 * lifecycle / relational fields (canon_status, origin, campaign_id, parent ids, board state)
 * stay server-authoritative — the vault is a prose+status editor, not their owner.
 *
 * This module is deliberately free of any `obsidian` import so it is unit-testable headless.
 */
import { CanonEntity, CanonEntityType, CanonLink, DmOnlyFacet } from "../model/canon";
import {
  CanonEntityDetailWire,
  CanonFactionWire,
  CanonHookWire,
  CanonLinkWire,
  CanonLocationWire,
  CanonLoreWire,
  CanonNpcWire,
  CanonRumorWire,
  CanonThreadWire,
} from "./wire";

/** Body posted to `POST /api/canon/links`. Id + createdUtc are server-owned. */
export interface LinkCreateWire {
  fromType: string;
  fromId: string;
  linkType: string;
  toType: string;
  toId: string;
}

/** The per-type write route segment. Everything is pluralized except `lore`. */
const ROUTE_SEGMENT: Record<CanonEntityType, string> = {
  npc: "npcs",
  location: "locations",
  thread: "threads",
  hook: "hooks",
  lore: "lore",
  rumor: "rumors",
  faction: "factions",
};

export function routeSegment(type: CanonEntityType): string {
  return ROUTE_SEGMENT[type];
}

/** Stable identity of a link for diffing (target + kind; the display name is not identity). */
export function linkKey(l: { linkType: string; toType: string; toId: string }): string {
  return `${l.linkType}|${l.toType}|${l.toId}`;
}

// ── update: server payload as base, overlay vault-owned fields ───────────────

/**
 * Build the PUT body for an existing entity. `detail` is the server's current copy
 * (from the concurrency pre-check GET); we clone the matching per-type payload and overlay
 * only the fields the vault owns, so no NOT-NULL column is ever nulled (TW-2).
 * Returns `null` if the detail has no payload for the entity's type (shouldn't happen).
 */
export function buildCanonUpdateBody(entity: CanonEntity, detail: CanonEntityDetailWire): object | null {
  const common = (base: { visibility: string; viability: string }) => {
    base.visibility = entity.visibility || base.visibility;
    base.viability = entity.viability || base.viability;
  };

  switch (entity.type) {
    case "npc": {
      const w = detail.npc;
      if (!w) return null;
      const body: CanonNpcWire = { ...w };
      common(body);
      body.name = entity.name || body.name;
      body.title = orKeep(entity.title, body.title);
      body.pronouns = orKeep(entity.pronouns, body.pronouns);
      body.oneLine = orKeep(entity.oneLine, body.oneLine);
      body.description = orKeep(entity.description, body.description);
      body.imageUrl = orKeep(entity.imageUrl, body.imageUrl);
      body.lifeStatus = entity.lifeStatus || body.lifeStatus;
      body.disposition = orKeep(entity.disposition, body.disposition);
      // The performance card round-trips through the note's %% dm_only %% facets.
      body.speech = facet(entity.dmOnly, "speech") ?? body.speech;
      body.bodyLanguage = facet(entity.dmOnly, "body language") ?? body.bodyLanguage;
      body.temperament = facet(entity.dmOnly, "temperament") ?? body.temperament;
      body.signaturePhrase = facet(entity.dmOnly, "signature phrase") ?? body.signaturePhrase;
      body.want = facet(entity.dmOnly, "want") ?? body.want;
      return body;
    }
    case "location": {
      const w = detail.location;
      if (!w) return null;
      const body: CanonLocationWire = { ...w };
      common(body);
      body.name = entity.name || body.name;
      body.kind = orKeep(entity.kind, body.kind);
      body.oneLine = orKeep(entity.oneLine, body.oneLine);
      body.description = orKeep(entity.description, body.description);
      body.imageUrl = orKeep(entity.imageUrl, body.imageUrl);
      body.referenceMapUrl = orKeep(entity.referenceMapUrl, body.referenceMapUrl);
      body.placeStatus = (entity.placeStatus as string) || body.placeStatus;
      return body;
    }
    case "thread": {
      const w = detail.thread;
      if (!w) return null;
      const body: CanonThreadWire = { ...w };
      common(body);
      body.title = entity.name || body.title;
      body.oneLine = orKeep(entity.oneLine, body.oneLine);
      body.currentState = orKeep(entity.currentState, body.currentState);
      body.status = (entity.threadStatus as string) || body.status;
      body.tract = orKeep(entity.tract, body.tract);
      body.resolution = orKeep(entity.resolution, body.resolution);
      return body;
    }
    case "hook": {
      const w = detail.hook;
      if (!w) return null;
      const body: CanonHookWire = { ...w };
      common(body);
      body.title = entity.name || body.title;
      body.oneLine = orKeep(entity.oneLine, body.oneLine);
      body.context = orKeep(entity.context, body.context);
      body.status = (entity.hookStatus as string) || body.status;
      return body;
    }
    case "lore": {
      const w = detail.lore;
      if (!w) return null;
      const body: CanonLoreWire = { ...w };
      common(body);
      body.title = entity.name || body.title;
      body.body = orKeep(entity.body, body.body);
      body.category = orKeep(entity.category, body.category);
      body.tags = entity.tags?.length ? entity.tags : body.tags;
      return body;
    }
    case "rumor": {
      const w = detail.rumor;
      if (!w) return null;
      const body: CanonRumorWire = { ...w };
      common(body);
      body.text = entity.body || entity.oneLine || body.text;
      body.truth = facet(entity.dmOnly, "truth") ?? body.truth;
      if (entity.plantedByRole) body.authorKind = entity.plantedByRole;
      return body;
    }
    case "faction": {
      const w = detail.faction;
      if (!w) return null;
      const body: CanonFactionWire = { ...w };
      common(body);
      body.name = entity.name || body.name;
      body.oneLine = orKeep(entity.oneLine, body.oneLine);
      body.description = orKeep(entity.description, body.description);
      body.disposition = orKeep(entity.disposition, body.disposition);
      body.status = entity.factionStatus || body.status;
      body.motto = orKeep(entity.motto, body.motto);
      return body;
    }
  }
}

// ── create: build the per-type body from scratch (vault-authored canon) ──────

/**
 * Build the POST body for a brand-new (id-less) vault note. No server base, so vocab
 * fields fall back to the create-defaults the controller would apply anyway; `origin` is
 * stamped `imported` to mark canon born in the vault. Used only once the id-return server
 * change lands (see SYNC_CONTRACT "create-from-vault"); until then the HTTP client gates
 * create and this is exercised by the mock + unit tests.
 */
export function buildCanonCreateBody(entity: CanonEntity): object {
  const base = {
    campaignId: entity.campaignId ?? null,
    visibility: entity.visibility || "dm_only",
    canonStatus: entity.canonStatus || "provisional",
    viability: entity.viability || "live",
    origin: entity.origin || "imported",
  };
  switch (entity.type) {
    case "npc":
      return {
        ...base,
        name: entity.name,
        title: entity.title ?? null,
        pronouns: entity.pronouns ?? null,
        imageUrl: entity.imageUrl ?? null,
        oneLine: entity.oneLine ?? null,
        description: entity.description ?? null,
        speech: facet(entity.dmOnly, "speech") ?? null,
        bodyLanguage: facet(entity.dmOnly, "body language") ?? null,
        temperament: facet(entity.dmOnly, "temperament") ?? null,
        signaturePhrase: facet(entity.dmOnly, "signature phrase") ?? null,
        want: facet(entity.dmOnly, "want") ?? null,
        lifeStatus: entity.lifeStatus ?? "alive",
        disposition: entity.disposition ?? null,
      };
    case "location":
      return {
        ...base,
        name: entity.name,
        kind: entity.kind ?? null,
        oneLine: entity.oneLine ?? null,
        description: entity.description ?? null,
        imageUrl: entity.imageUrl ?? null,
        referenceMapUrl: entity.referenceMapUrl ?? null,
        placeStatus: entity.placeStatus ?? "active",
      };
    case "thread":
      return {
        ...base,
        title: entity.name,
        oneLine: entity.oneLine ?? null,
        currentState: entity.currentState ?? null,
        status: entity.threadStatus ?? "seeded",
        tract: entity.tract ?? null,
        resolution: entity.resolution ?? null,
      };
    case "hook":
      return {
        ...base,
        title: entity.name,
        oneLine: entity.oneLine ?? null,
        context: entity.context ?? null,
        status: entity.hookStatus ?? "open",
      };
    case "lore":
      return {
        ...base,
        title: entity.name,
        body: entity.body ?? null,
        category: entity.category ?? null,
        tags: entity.tags ?? [],
      };
    case "rumor":
      return {
        ...base,
        text: entity.body || entity.oneLine || entity.name,
        truth: facet(entity.dmOnly, "truth") ?? "unknown",
        status: "circulating",
        authorKind: entity.plantedByRole ?? "dm",
      };
    case "faction":
      return {
        ...base,
        name: entity.name,
        oneLine: entity.oneLine ?? null,
        description: entity.description ?? null,
        disposition: entity.disposition ?? null,
        status: entity.factionStatus || "active",
        motto: entity.motto ?? null,
      };
  }
}

// ── link diff ────────────────────────────────────────────────────────────────

/**
 * Diff the entity's desired outgoing links against what the server currently holds.
 * Additions are POSTed; removals are DELETEd by the server link's id. Matching is by
 * (linkType, toType, toId) — the link's own id is server-owned and only exists on removals.
 * The create endpoint does NOT dedupe, so we only ever POST genuinely-new edges.
 */
export function diffLinks(
  serverLinks: CanonLinkWire[],
  desired: CanonLink[],
  fromType: string,
  fromId: string
): { toAdd: LinkCreateWire[]; toRemove: string[] } {
  const serverOutgoing = serverLinks.filter((l) => l.fromId === fromId);
  const serverByKey = new Map(serverOutgoing.map((l) => [linkKey(l), l]));
  const desiredKeys = new Set(desired.map(linkKey));

  const toAdd: LinkCreateWire[] = desired
    .filter((l) => !serverByKey.has(linkKey(l)))
    .map((l) => ({ fromType, fromId, linkType: l.linkType, toType: l.toType, toId: l.toId }));

  const toRemove: string[] = serverOutgoing
    .filter((l) => !desiredKeys.has(linkKey(l)))
    .map((l) => l.id);

  return { toAdd, toRemove };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A vault edit overlays the server value only when the DM actually set something. */
function orKeep(vaultValue: string | undefined, serverValue: string | null | undefined): string | null {
  if (vaultValue === undefined) return serverValue ?? null;
  return vaultValue;
}

/** Find a dm_only facet value by its (lowercased) label; undefined if absent. */
function facet(facets: DmOnlyFacet[] | undefined, name: string): string | undefined {
  const hit = facets?.find((f) => f.facet.toLowerCase() === name);
  return hit ? hit.value : undefined;
}
