import { Adventure, CanonEntity, CanonEntityType, GameSession } from "../model/canon";

/** Lightweight summary of an adventure PLAN (the Canvas prep doc) — a Harvest list row. */
export interface AdventurePlanSummary {
  id: string;
  title: string;
  campaignId: string | null;
  updatedUtc: string;
}

/**
 * The sync contract, as an interface. Everything the plugin does goes through it, so
 * `MockCanonApiClient` (fixtures, no backend) and `HttpCanonApiClient` (the live Module 27
 * `CanonController`, reconciled 2026-07-10) are drop-in interchangeable.
 *
 * Direction convention:
 *   - PULL  = app → vault : list/fetch canon + monsters/characters to write as notes.
 *   - PUSH  = vault → app : send back edits made in Obsidian.
 *   - Adventures/Sessions are fetched (pull) to render one-pagers; they are authored
 *     app-side ("Quill-first"), so the plugin pushes only their prose edits back.
 */
export interface CanonApiClient {
  /** Cheap connectivity + auth probe for the settings "Test connection" button. */
  ping(): Promise<{ ok: boolean; tenantId?: string; message?: string }>;

  // ---- PULL (app → vault) ------------------------------------------------

  /**
   * List canon entities changed since `sinceUtc` (null = full sync). The plugin
   * only ever receives entities the caller is authorized to see; `dm_only`
   * entities/facets are included only for DM tokens (visibility enforced server-side).
   */
  listCanon(params: {
    types?: CanonEntityType[];
    campaignId?: string | null;
    sinceUtc?: string | null;
  }): Promise<CanonEntity[]>;

  getCanon(type: CanonEntityType, id: string): Promise<CanonEntity | null>;

  /** Adventures to render as vault one-pagers (with `[[wikilinks]]` into canon). */
  listAdventures(params: { campaignId?: string | null; sinceUtc?: string | null }): Promise<Adventure[]>;

  getAdventure(id: string): Promise<Adventure | null>;

  /** Sessions (game-night events) to render, linking their adventures. */
  listSessions(params: { campaignId?: string | null; sinceUtc?: string | null }): Promise<GameSession[]>;

  // ---- Adventure plans (the DM's prep docs — the PROSE round-trip) --------
  // Unlike canon (shared world) these are the caller's PRIVATE prep. The plugin is pure transport
  // here: it fetches the server's canonical markdown verbatim and posts edits straight back, so the
  // app's AdventurePlanMarkdown owns the format (one source of truth, no second serializer).

  /** The caller's OWN adventure plans (GET /adventure-plans/mine) — the Harvest source. */
  listMyAdventurePlans(): Promise<AdventurePlanSummary[]>;

  /** One plan as Obsidian-flavored markdown (GET /adventure-plans/{id}/export.md). null if gone. */
  getAdventurePlanMarkdown(id: string): Promise<string | null>;

  /** Apply an edited note back (POST /adventure-plans/{id}/import/apply — file-wins). */
  applyAdventurePlanMarkdown(id: string, markdown: string): Promise<{ ok: boolean; message?: string }>;

  // ---- PUSH (vault → app) ------------------------------------------------

  /**
   * Push a vault-edited (or vault-authored) canon entity back to the app, links included.
   *
   *  - Empty `entity.id` → **create** (vault-authored new canon).
   *  - Non-empty `entity.id` → **update** the existing row + reconcile its outgoing links.
   *
   * `expectedUpdatedUtc` is the value the vault note was last synced from. The live server is
   * fire-and-forget (writes return 202, no optimistic-concurrency gate), so the HTTP client
   * enforces concurrency with a pre-check GET: if the app copy is newer it returns `conflict`
   * rather than clobbering (the sidecar trigger — see SYNC_CONTRACT.md). The mock enforces the
   * same check in-memory. A client that cannot create (the live server can't return a new id
   * yet) returns `unsupported` for the create case.
   */
  upsertCanon(
    entity: CanonEntity,
    opts: { expectedUpdatedUtc?: string | null }
  ): Promise<UpsertResult>;
}

export type UpsertResult =
  /** Written. `created` distinguishes POST-create from PUT-update; link counts are the diff applied. */
  | { status: "ok"; entity: CanonEntity; created: boolean; linksAdded: number; linksRemoved: number }
  /** The app copy moved on since the vault synced — caller writes a `.conflict.md` sidecar. */
  | { status: "conflict"; serverEntity: CanonEntity }
  /** This client can't perform the requested write (e.g. create against the live server). */
  | { status: "unsupported"; message: string }
  | { status: "error"; message: string };
