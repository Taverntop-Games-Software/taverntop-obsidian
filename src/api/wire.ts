/**
 * Wire shapes — the JSON the live Canon Engine API actually returns, mirroring
 * `Taverntop.Core.Server.Client/Models/CanonDtos.cs`. These are DELIBERATELY separate
 * from `src/model/canon.ts` (the plugin's model): the HTTP client receives *these*, and
 * `dtoMapping.ts` folds them into the model. Keeping the two apart means the vault model
 * never bends to a wire quirk (field renames, flat DM-only fields, name-less links) — the
 * mapping layer absorbs it (per SYNC_CONTRACT.md: "adapt inside the client").
 *
 * ⚠️ Casing: ASP.NET Core's default serializer is camelCase, so keys are camelCase here.
 * If the shipped API is configured PascalCase, flip keys in this one file — confirm at the
 * first live pull.
 *
 * DM-only note: the read endpoints run `dmView: true`, so a DM token receives the NPC
 * performance card (speech/want/…), rumor `truth`, and the `secrets` list. The mapper
 * routes all of those into the note's `%% dm_only %%` body region — never frontmatter.
 */

/** Lightweight index row from `GET /api/canon/entities` (keyset-paginated). */
export interface CanonCardWire {
  entityType: string;
  id: string;
  name: string;
  oneLine?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  lifecycleStatus?: string | null;
  campaignId?: string | null;
  imageUrl?: string | null;
  createdUtc: string;
  appearsInCount: number;
  firstSeenUtc?: string | null;
  lastSeenUtc?: string | null;
}

export interface CanonNpcWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  name: string;
  title?: string | null;
  pronouns?: string | null;
  imageUrl?: string | null;
  oneLine?: string | null;
  description?: string | null;
  // The performance card — DM-only facets.
  speech?: string | null;
  bodyLanguage?: string | null;
  temperament?: string | null;
  signaturePhrase?: string | null;
  want?: string | null;
  lifeStatus: string;
  disposition?: string | null;
  fromCharacterId?: string | null;
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonLocationWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  name: string;
  kind?: string | null;
  parentLocationId?: string | null;
  imageUrl?: string | null;
  referenceMapUrl?: string | null;
  oneLine?: string | null;
  description?: string | null;
  placeStatus: string;
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonThreadWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  title: string;
  oneLine?: string | null;
  currentState?: string | null;
  status: string;
  tract?: string | null;
  arcId?: string | null;
  phaseId?: string | null;
  isPinned: boolean;
  resolution?: string | null;
  spawnedFromHookId?: string | null;
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonHookWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  title: string;
  oneLine?: string | null;
  context?: string | null;
  status: string;
  leftByUserId?: string | null;
  leftInAdventureId?: string | null;
  spawnedAdventureId?: string | null;
  continuesThreadId?: string | null;
  heat?: number | null;
  isClaimable: boolean;
  maxClaimants?: number | null;
  postedToBoard: boolean;
  boardBlurb?: string | null;
  expiresAfterSessions?: number | null;
  expiresUtc?: string | null;
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonLoreWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  title: string;
  body?: string | null;
  category?: string | null;
  tags: string[];
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonRumorWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  text: string;
  truth: string; // DM-only (player path carries "unknown")
  status: string;
  authorKind: string;
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonFactionWire {
  id: string;
  campaignId?: string | null;
  visibility: string;
  canonStatus: string;
  viability: string;
  origin: string;
  name: string;
  oneLine?: string | null;
  description?: string | null;
  disposition?: string | null;
  status: string;
  motto?: string | null;
  createdUtc: string;
  updatedUtc: string;
}

export interface CanonLinkWire {
  id: string;
  fromType: string;
  fromId: string;
  linkType: string;
  toType: string;
  toId: string;
  createdUtc: string;
}

export interface CanonSecretWire {
  id: string;
  entityType: string;
  entityId: string;
  facet: string;
  body?: string | null;
  createdUtc: string;
}

export interface CanonAppearanceWire {
  id: string;
  entityType: string;
  entityId: string;
  sourceType: string;
  sourceId: string;
  contextNote?: string | null;
  statVariationNote?: string | null;
  isFirst: boolean;
  appearedUtc: string;
}

export interface CanonHookClaimWire {
  id: string;
  canonHookId: string;
  claimedByUserId: string;
  claimedUtc: string;
}

/** `GET /api/canon/entities/{type}/{id}` — one payload set + relationship web + history + secrets. */
export interface CanonEntityDetailWire {
  entityType: string;
  npc?: CanonNpcWire | null;
  location?: CanonLocationWire | null;
  thread?: CanonThreadWire | null;
  hook?: CanonHookWire | null;
  lore?: CanonLoreWire | null;
  rumor?: CanonRumorWire | null;
  faction?: CanonFactionWire | null;
  links: CanonLinkWire[];
  appearances: CanonAppearanceWire[];
  secrets: CanonSecretWire[];
  claims: CanonHookClaimWire[];
}
