/**
 * The Taverntop Canon domain model, as the plugin sees it.
 *
 * This mirrors Module 27 — the Canon Engine — as specced in
 * `docs/plans/Module27_SessionPlanner_CampaignCanon.md` (§3.5 canon entities,
 * §3.6 visibility tiers, §13 the Rumor 6th element + Obsidian sync intent).
 *
 * IMPORTANT: this is the *plugin's* view of the contract, not a copy of the
 * backend's C# entities. It is deliberately transport-shaped (flat, JSON-friendly,
 * links expressed as typed edges) so it maps cleanly onto both the future HTTP API
 * and onto markdown + YAML frontmatter in the vault. The backend does not exist yet;
 * see api/CanonApiClient.ts for the seam.
 */

/**
 * The seven first-class canon entity kinds (§3.5 + §13 Rumor + M27 S5 Faction).
 * Faction became a full canon entity in Slice 5 (its own DTO + endpoints), so it is
 * a peer type here — not just a link target.
 */
export type CanonEntityType =
  | "npc"
  | "location"
  | "thread"
  | "hook"
  | "lore"
  | "rumor"
  | "faction";

/**
 * Typed relationship edges between canon entities (and to existing
 * Faction/Character). These ARE the `canon_link` rows in §3.5 and become
 * `[[wikilinks]]` grouped by edge type in frontmatter.
 */
export type CanonLinkType =
  | "member_of" // NPC → Faction
  | "found_at" // NPC → Location
  | "home_of" // Location → NPC
  | "controlled_by" // Location → Faction
  | "involves" // Thread/Hook/Rumor → NPC | Location | Faction
  | "continues" // Hook → Thread
  | "spawned_from" // Thread → Hook
  | "known_to" // NPC → Character (the player-character relationship)
  | "about" // Lore/Rumor → anything
  | "references"; // Hook → anything

/** §3.6 visibility tiers. Entity-level; individual facets can also be dm_only. */
export type Visibility = "player" | "dm_only";

/** §3.5 cross-cutting: provisional (planned) vs confirmed (seen in play). */
export type CanonStatus = "provisional" | "confirmed";

/**
 * The Door-A keep/cut axis (every entity carries it). Kept as a string because the
 * backend owns the vocabulary; render it to frontmatter and let it round-trip verbatim.
 */
export type CanonViability = string;

/** §3.5 cross-cutting: how the entity was born. */
export type CanonOrigin = "planned" | "recapped" | "imported" | "manual";

/** A single typed edge to another entity, resolved to a display name for wikilinks. */
export interface CanonLink {
  linkType: CanonLinkType;
  /** Target entity kind. `character` references an existing app Player-Character. */
  toType: CanonEntityType | "character";
  /** Stable target id (GUID). The durable half of the edge. */
  toId: string;
  /** Human label used to render the `[[wikilink]]`. May go stale; id is truth. */
  toName: string;
}

/** Fields every canon entity carries (§3.5 "cross-cutting fields" + §3.6 visibility). */
export interface CanonBase {
  id: string; // GUID — the round-trip identity key
  type: CanonEntityType;
  tenantId: string;
  campaignId: string | null; // null → guild-universal
  canonStatus: CanonStatus;
  viability: CanonViability; // Door-A keep/cut axis (frontmatter round-trip)
  origin: CanonOrigin;
  visibility: Visibility;
  name: string; // primary display name / note title
  createdUtc: string; // ISO 8601
  updatedUtc: string; // ISO 8601 — drives freshness / conflict comparison
  links: CanonLink[];
}

/**
 * A facet that is player-visible-entity but DM-only-field (§3.6 field-level secrets).
 * Rendered inside a `%% dm_only %%` fenced region so a player-vault export can strip it.
 */
export interface DmOnlyFacet {
  facet: string; // e.g. "want", "secret", "true_disposition"
  value: string;
}

export interface CanonNpc extends CanonBase {
  type: "npc";
  title?: string; // epithet
  pronouns?: string;
  imageUrl?: string;
  oneLine?: string;
  description?: string;
  lifeStatus?: "alive" | "dead" | "missing" | "unknown";
  disposition?: string;
  fromCharacterId?: string; // a retired/dead PC who became an NPC
  dmOnly: DmOnlyFacet[]; // voice / want / secret when the NPC itself is revealed
}

export interface CanonLocation extends CanonBase {
  type: "location";
  kind?: string; // settlement / dungeon / landmark / plane / building / region
  parentLocationId?: string;
  imageUrl?: string;
  referenceMapUrl?: string;
  oneLine?: string;
  description?: string;
  placeStatus?: "active" | "destroyed" | "lost" | "hidden";
  dmOnly: DmOnlyFacet[];
}

export interface CanonThread extends CanonBase {
  type: "thread";
  oneLine?: string;
  currentState?: string;
  threadStatus: "seeded" | "active" | "resolved" | "dormant" | "abandoned";
  tract?: string; // Main / Secondary
  resolution?: string;
  spawnedFromHookId?: string;
  dmOnly: DmOnlyFacet[];
}

export interface CanonHook extends CanonBase {
  type: "hook";
  oneLine?: string;
  context?: string;
  hookStatus: "open" | "claimed" | "spawned" | "retired";
  leftByUserId?: string;
  leftInAdventureId?: string;
  claimedByUserId?: string;
  spawnedAdventureId?: string;
  continuesThreadId?: string;
  heat?: string;
  dmOnly: DmOnlyFacet[];
}

export interface CanonLore extends CanonBase {
  type: "lore";
  body?: string; // markdown
  category?: string;
  tags: string[];
  dmOnly: DmOnlyFacet[];
}

/** §13 / §445 — Rumor promoted to a first-class 6th element; DM- or player-planted. */
export interface CanonRumor extends CanonBase {
  type: "rumor";
  oneLine?: string;
  body?: string;
  plantedByRole?: "dm" | "player";
  veracity?: "true" | "false" | "partial" | "unknown"; // dm-facing truth value
  dmOnly: DmOnlyFacet[];
}

/** §M27 S5 — Faction as first-class canon (own DTO + endpoints), not just a link target. */
export interface CanonFaction extends CanonBase {
  type: "faction";
  oneLine?: string;
  description?: string;
  disposition?: string;
  factionStatus: string; // active / disbanded / ... (backend-owned vocabulary)
  motto?: string;
  dmOnly: DmOnlyFacet[];
}

export type CanonEntity =
  | CanonNpc
  | CanonLocation
  | CanonThread
  | CanonHook
  | CanonLore
  | CanonRumor
  | CanonFaction;

/**
 * Adventures push DOWN to the vault (app → Obsidian). The Adventure stays THIN
 * (§3.1); the prep lives on a linked AdventurePlan (Acts → Scenes → Beats/Elements).
 * We carry just enough to render a runnable one-pager with `[[links]]` into canon.
 */
export interface AdventureBeat {
  kind: string; // "strong_start" | "scene" | "encounter" | "npc" | "secret" | ...
  title: string;
  body?: string;
  /** canon entities referenced by this beat → rendered as wikilinks */
  canonRefs: Array<{ type: CanonEntityType; id: string; name: string }>;
}

export interface AdventureAct {
  title: string;
  timebox?: string; // "15m", "45m–1hr"
  beats: AdventureBeat[];
}

export interface Adventure {
  id: string;
  tenantId: string;
  campaignId: string | null;
  title: string;
  code?: string;
  teaser?: string;
  dungeonMasterName?: string;
  sessionId?: string;
  acts: AdventureAct[];
  updatedUtc: string;
}

/** A game-night calendar event; adventures are scheduled into it. */
export interface GameSession {
  id: string;
  tenantId: string;
  campaignId: string | null;
  title: string;
  date: string; // ISO date
  adventureIds: string[];
  updatedUtc: string;
}
