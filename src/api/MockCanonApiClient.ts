import { Adventure, CanonEntity, CanonEntityType, CanonLink, GameSession } from "../model/canon";
import { AdventurePlanSummary, CanonApiClient, UpsertResult } from "./CanonApiClient";
import { linkKey } from "./dtoMappingOut";
import { FIXTURE_ADVENTURES, FIXTURE_CANON, FIXTURE_SESSIONS } from "./fixtures";

/**
 * In-memory implementation of the sync contract, seeded from the spec's reference
 * fixtures. This is what the plugin runs against until the Canon Engine HTTP API
 * exists — it lets push+pull, wikilinks, dm_only handling, and conflict detection
 * all be exercised end-to-end with no backend.
 *
 * It models one detail the real server will enforce: a DM token sees `dm_only`
 * entities/facets; a player token does not. Toggle via `dmMode`.
 */
export class MockCanonApiClient implements CanonApiClient {
  private canon: Map<string, CanonEntity> = new Map();
  private adventures: Map<string, Adventure> = new Map();
  private sessions: Map<string, GameSession> = new Map();
  private idCounter = 0;

  constructor(private readonly dmMode: boolean = true) {
    for (const e of FIXTURE_CANON) this.canon.set(e.id, structuredClone(e));
    for (const a of FIXTURE_ADVENTURES) this.adventures.set(a.id, structuredClone(a));
    for (const s of FIXTURE_SESSIONS) this.sessions.set(s.id, structuredClone(s));
  }

  async ping(): Promise<{ ok: boolean; tenantId?: string; message?: string }> {
    return { ok: true, tenantId: "2004", message: "mock client — no backend" };
  }

  async listCanon(params: {
    types?: CanonEntityType[];
    campaignId?: string | null;
    sinceUtc?: string | null;
  }): Promise<CanonEntity[]> {
    return [...this.canon.values()]
      .filter((e) => this.visibleToCaller(e))
      .filter((e) => !params.types || params.types.includes(e.type))
      .filter((e) => this.matchesCampaign(e.campaignId, params.campaignId))
      .filter((e) => !params.sinceUtc || e.updatedUtc > params.sinceUtc)
      .map((e) => this.redact(e));
  }

  async getCanon(type: CanonEntityType, id: string): Promise<CanonEntity | null> {
    const e = this.canon.get(id);
    if (!e || e.type !== type || !this.visibleToCaller(e)) return null;
    return this.redact(e);
  }

  async listAdventures(params: { campaignId?: string | null; sinceUtc?: string | null }): Promise<Adventure[]> {
    return [...this.adventures.values()]
      .filter((a) => this.matchesCampaign(a.campaignId, params.campaignId))
      .filter((a) => !params.sinceUtc || a.updatedUtc > params.sinceUtc)
      .map((a) => structuredClone(a));
  }

  async getAdventure(id: string): Promise<Adventure | null> {
    const a = this.adventures.get(id);
    return a ? structuredClone(a) : null;
  }

  async listSessions(params: { campaignId?: string | null; sinceUtc?: string | null }): Promise<GameSession[]> {
    return [...this.sessions.values()]
      .filter((s) => this.matchesCampaign(s.campaignId, params.campaignId))
      .filter((s) => !params.sinceUtc || s.updatedUtc > params.sinceUtc)
      .map((s) => structuredClone(s));
  }

  // ---- Adventure plans (mock — synthesize a round-trippable note from the fixtures) -------

  async listMyAdventurePlans(): Promise<AdventurePlanSummary[]> {
    return [...this.adventures.values()].map((a) => ({
      id: a.id,
      title: a.title,
      campaignId: a.campaignId,
      updatedUtc: a.updatedUtc,
    }));
  }

  async getAdventurePlanMarkdown(id: string): Promise<string | null> {
    const a = this.adventures.get(id);
    if (!a) return null;
    // A minimal but fence-valid note so the folder/publish flow is exercisable with no backend.
    return [
      "---",
      `tt-plan-id: ${a.id}`,
      `tt-campaign-id: ${a.campaignId ?? ""}`,
      "tt-skeleton: blank-canvas",
      "tt-prep-status: idea",
      "---",
      "",
      `# ${a.title}`,
      a.teaser ? `> ${a.teaser}` : "",
      "",
      "%% tt:prose %%",
      a.teaser ?? "Write the prep here.",
      "%% /tt:prose %%",
      "",
    ].join("\n");
  }

  async applyAdventurePlanMarkdown(_id: string, _markdown: string): Promise<{ ok: boolean; message?: string }> {
    return { ok: true }; // mock accepts the push (no server to parse against)
  }

  async upsertCanon(
    entity: CanonEntity,
    opts: { expectedUpdatedUtc?: string | null }
  ): Promise<UpsertResult> {
    // Create: an id-less note → mint an id + store. The mock CAN hand back the new id, so it
    // exercises the full create round-trip the live server can't yet (SYNC_CONTRACT
    // "create-from-vault"); this is what the create tests run against.
    if (!entity.id) {
      const saved: CanonEntity = structuredClone(entity);
      saved.id = `mock-${entity.type}-${++this.idCounter}`;
      saved.updatedUtc = this.nextTimestamp();
      this.canon.set(saved.id, saved);
      return { status: "ok", entity: this.redact(saved), created: true, linksAdded: saved.links.length, linksRemoved: 0 };
    }

    const existing = this.canon.get(entity.id);
    if (!existing) return { status: "error", message: `no canon entity ${entity.id} to update` };

    // Optimistic concurrency: reject if the server copy moved on since the vault synced.
    if (opts.expectedUpdatedUtc && existing.updatedUtc !== opts.expectedUpdatedUtc) {
      return { status: "conflict", serverEntity: this.redact(existing) };
    }

    const { linksAdded, linksRemoved } = countLinkDiff(existing.links, entity.links);
    // The mock stamps a monotonic-ish updatedUtc. (Real server owns this timestamp.)
    const saved: CanonEntity = structuredClone(entity);
    saved.updatedUtc = this.nextTimestamp(existing.updatedUtc);
    this.canon.set(saved.id, saved);
    return { status: "ok", entity: this.redact(saved), created: false, linksAdded, linksRemoved };
  }

  // ---- visibility enforcement (a stand-in for server-side authz) ----------

  /**
   * Campaign filter semantics (mirrors the settings copy "blank = all campaigns +
   * guild-universal"): a blank filter (null/undefined) returns everything; a specific
   * campaign returns that campaign's canon PLUS guild-universal (campaignId null) canon.
   */
  private matchesCampaign(entityCampaign: string | null, filter: string | null | undefined): boolean {
    if (filter == null) return true;
    return entityCampaign === filter || entityCampaign == null;
  }

  private visibleToCaller(e: CanonEntity): boolean {
    return this.dmMode || e.visibility === "player";
  }

  /** Strip dm_only facets for player tokens, mirroring server field-level authz. */
  private redact(e: CanonEntity): CanonEntity {
    const clone = structuredClone(e);
    if (!this.dmMode) clone.dmOnly = [];
    return clone;
  }

  private nextTimestamp(prev?: string): string {
    // Date.now() is intentionally avoided (unavailable in some sandboxes); derive a
    // deterministic bump from the previous stamp so tests are reproducible.
    const base = prev ? new Date(prev).getTime() : new Date("2026-07-01T00:00:00Z").getTime();
    return new Date(base + 1000).toISOString();
  }
}

/** Count-only link diff for the mock (the HTTP client does the id-aware POST/DELETE version). */
function countLinkDiff(server: CanonLink[], desired: CanonLink[]): { linksAdded: number; linksRemoved: number } {
  const serverKeys = new Set(server.map(linkKey));
  const desiredKeys = new Set(desired.map(linkKey));
  const linksAdded = desired.filter((l) => !serverKeys.has(linkKey(l))).length;
  const linksRemoved = server.filter((l) => !desiredKeys.has(linkKey(l))).length;
  return { linksAdded, linksRemoved };
}
