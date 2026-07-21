import { requestUrl } from "obsidian";
import { Adventure, CanonEntity, CanonEntityType, GameSession } from "../model/canon";
import { AdventurePlanSummary, CanonApiClient, UpsertResult } from "./CanonApiClient";
import { CanonCardWire, CanonEntityDetailWire } from "./wire";
import { mapDetailToCanon, NameResolver } from "./dtoMapping";
import { buildCanonCreateBody, buildCanonUpdateBody, diffLinks, routeSegment } from "./dtoMappingOut";

/**
 * Real HTTP implementation against the live Canon Engine API (Module 27's `CanonController`,
 * route base `api/canon`, policy `CampaignApiAccess`).
 *
 * Reconciled to the shipped controller (2026-07-10):
 *  - LIST  = `GET /entities` — lightweight cards, **keyset-paginated** on `created_utc`
 *            via `before`/`limit` (NOT a `since=` delta; see FLOWS_AND_PERSONAS fork #8).
 *  - DETAIL= `GET /entities/{type}/{id}` — full entity + links + appearances + secrets.
 *  - Reads run `dmView: true`, so a DM token gets the whole world; the player/dm_only split
 *    is our client-side export strip, not the API's.
 *  - There is no `ping`; the connectivity/auth probe is a 1-row `GET /entities`.
 *  - WRITE is per-type (`POST/PUT /{npcs|locations|…}`) + separate `/links` — wired in O2.
 *
 * A Harvest is therefore: page all cards → build an id→name roster → fetch detail per card →
 * map to the vault model. Requests go through Obsidian's `requestUrl` (CORS/mobile-safe).
 */
export class HttpCanonApiClient implements CanonApiClient {
  private static readonly PAGE_SIZE = 60;

  constructor(
    private readonly baseUrl: string,
    private readonly getBearerToken: () => Promise<string | null>,
    /** The connected guild id — stamped into note frontmatter. Supplied by Connect (O1b); "" until then. */
    private readonly tenantId: string = ""
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getBearerToken();
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Connectivity + auth probe. No dedicated ping endpoint — a 1-row list stands in. */
  async ping(): Promise<{ ok: boolean; tenantId?: string; message?: string }> {
    try {
      const res = await requestUrl({
        url: this.url("/api/canon/entities?limit=1"),
        method: "GET",
        headers: await this.headers(),
        throw: false,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, tenantId: this.tenantId || undefined };
      if (res.status === 401 || res.status === 403) return { ok: false, message: `Not authorized (HTTP ${res.status}) — check the token/scope.` };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  // ---- PULL ---------------------------------------------------------------

  async listCanon(params: {
    types?: CanonEntityType[];
    campaignId?: string | null;
    sinceUtc?: string | null; // ignored — the entities endpoint is keyset, not delta (fork #8)
  }): Promise<CanonEntity[]> {
    const details = await this.allDetails(params);

    // Roster: resolve link targets to display names when we write `[[wikilinks]]` (built
    // straight from the details we already have — no extra calls).
    const nameMap = new Map<string, string>();
    for (const d of details) {
      const idn = detailIdentity(d);
      if (idn) nameMap.set(`${idn.type}:${idn.id}`, idn.name);
    }
    const resolveName: NameResolver = (t, id) => nameMap.get(`${t}:${id}`);

    const entities: CanonEntity[] = [];
    for (const d of details) {
      const mapped = mapDetailToCanon(d, resolveName, this.tenantId);
      if (mapped) entities.push(mapped);
    }
    return entities;
  }

  /**
   * All entity details for a Harvest. Prefers the bulk endpoint (`GET /entities/full` — ONE
   * request per keyset page, killing the old 1-list + N-detail flood). If the server is older
   * and 404s, transparently falls back to the card-list + per-entity path so the plugin works
   * against either server (no restart coordination needed).
   */
  private async allDetails(params: { types?: CanonEntityType[]; campaignId?: string | null }): Promise<CanonEntityDetailWire[]> {
    const bulk = await this.allDetailsBulk(params);
    if (bulk !== null) return bulk;

    console.info("[taverntop] /entities/full unavailable (older server) — falling back to per-entity detail fetch.");
    const cards = await this.allCards(params);
    const out: CanonEntityDetailWire[] = [];
    for (const c of cards) {
      const detail = await this.fetchDetail(c.entityType, c.id);
      if (detail) out.push(detail);
    }
    return out;
  }

  /** Page `GET /entities/full`. Returns null (not []) on 404 so the caller falls back to the old path. */
  private async allDetailsBulk(params: { types?: CanonEntityType[]; campaignId?: string | null }): Promise<CanonEntityDetailWire[] | null> {
    const singleType = params.types?.length === 1 ? params.types[0] : undefined;
    const out: CanonEntityDetailWire[] = [];
    let before: string | undefined;

    for (let guard = 0; guard < 1000; guard++) {
      const qs = new URLSearchParams();
      if (singleType) qs.set("type", singleType);
      if (params.campaignId) qs.set("campaignId", params.campaignId);
      qs.set("limit", String(HttpCanonApiClient.PAGE_SIZE));
      if (before) qs.set("before", before);

      const res = await requestUrl({
        url: this.url(`/api/canon/entities/full?${qs.toString()}`),
        method: "GET",
        headers: await this.headers(),
        throw: false,
      });
      if (res.status === 404) return null; // endpoint absent → signal fallback
      if (res.status < 200 || res.status >= 300) throw new Error(`GET /entities/full failed — HTTP ${res.status}`);

      const page = (res.json as CanonEntityDetailWire[]) ?? [];
      out.push(...page);
      if (page.length < HttpCanonApiClient.PAGE_SIZE) break;
      const cursor = detailCreatedUtc(page[page.length - 1]);
      if (!cursor) break; // no cursor → stop rather than loop forever
      before = cursor;
    }

    // Multi-type request → filter client-side (the endpoint takes a single `type`).
    if (params.types && params.types.length > 1) {
      const wanted = new Set<string>(params.types);
      return out.filter((d) => wanted.has(d.entityType));
    }
    return out;
  }

  async getCanon(type: CanonEntityType, id: string): Promise<CanonEntity | null> {
    const detail = await this.fetchDetail(type, id);
    if (!detail) return null;
    // Single fetch has no roster, so link labels fall back to ids until the next full Harvest.
    return mapDetailToCanon(detail, () => undefined, this.tenantId);
  }

  /** Page the keyset list until a short/empty page. Cursor = oldest `created_utc` seen. */
  private async allCards(params: { types?: CanonEntityType[]; campaignId?: string | null }): Promise<CanonCardWire[]> {
    const singleType = params.types?.length === 1 ? params.types[0] : undefined;
    const out: CanonCardWire[] = [];
    let before: string | undefined;

    for (let guard = 0; guard < 1000; guard++) {
      const qs = new URLSearchParams();
      if (singleType) qs.set("type", singleType);
      if (params.campaignId) qs.set("campaignId", params.campaignId);
      qs.set("limit", String(HttpCanonApiClient.PAGE_SIZE));
      if (before) qs.set("before", before);

      const res = await requestUrl({
        url: this.url(`/api/canon/entities?${qs.toString()}`),
        method: "GET",
        headers: await this.headers(),
      });
      const page = (res.json as CanonCardWire[]) ?? [];
      out.push(...page);
      if (page.length < HttpCanonApiClient.PAGE_SIZE) break;
      before = page[page.length - 1].createdUtc; // keyset assumes created_utc DESC
    }

    // Multi-type request → filter client-side (the endpoint takes a single `type`).
    if (params.types && params.types.length > 1) {
      const wanted = new Set<string>(params.types);
      return out.filter((c) => wanted.has(c.entityType));
    }
    return out;
  }

  private async fetchDetail(type: string, id: string): Promise<CanonEntityDetailWire | null> {
    const res = await requestUrl({
      url: this.url(`/api/canon/entities/${type}/${id}`),
      method: "GET",
      headers: await this.headers(),
      throw: false,
    });
    return res.status === 200 ? (res.json as CanonEntityDetailWire) : null;
  }

  // ---- Adventures / Sessions (Flow C) — different controllers, wired next ----

  async listAdventures(_params: { campaignId?: string | null; sinceUtc?: string | null }): Promise<Adventure[]> {
    console.warn("[taverntop] Adventure harvest not wired to the live API yet (Flow C — separate controller).");
    return [];
  }

  async getAdventure(_id: string): Promise<Adventure | null> {
    return null;
  }

  async listSessions(_params: { campaignId?: string | null; sinceUtc?: string | null }): Promise<GameSession[]> {
    // Sessions are calendar events, not something you author in Obsidian — intentionally not synced.
    return [];
  }

  // ---- Adventure plans (the DM's prep docs — the prose round-trip) --------

  async listMyAdventurePlans(): Promise<AdventurePlanSummary[]> {
    const res = await requestUrl({
      url: this.url("/api/adventure-plans/mine"),
      method: "GET",
      headers: await this.headers(),
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      console.warn(`[taverntop] list my adventure plans failed — HTTP ${res.status}`);
      return [];
    }
    const rows = (res.json as Array<{ id: string; title?: string; campaignId?: string | null; updatedUtc?: string }>) ?? [];
    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? "Untitled adventure",
      campaignId: r.campaignId ?? null,
      updatedUtc: r.updatedUtc ?? "",
    }));
  }

  async getAdventurePlanMarkdown(id: string): Promise<string | null> {
    const res = await requestUrl({
      url: this.url(`/api/adventure-plans/${id}/export.md`),
      method: "GET",
      headers: await this.headers(),
      throw: false,
    });
    return res.status === 200 ? res.text : null;
  }

  async applyAdventurePlanMarkdown(id: string, markdown: string): Promise<{ ok: boolean; message?: string }> {
    // import/apply is a fire-and-forget NSB write (202); the server owns parse+file-wins apply.
    const res = await this.write("POST", `/api/adventure-plans/${id}/import/apply`, { markdown });
    return res.ok ? { ok: true } : { ok: false, message: res.message };
  }

  // ---- PUSH (O2 — Seed & Publish) -----------------------------------------

  /**
   * Push a vault edit (or a vault-authored new note) back to the live API.
   *
   *  - Empty id → CREATE: the server returns the new id (controller-generated, TW-3), so we POST,
   *    stamp the note with the returned id, and push the note's links as additions. Guarded by a
   *    capability probe so we never POST against an un-rebuilt server (which would create a row
   *    without returning its id → a duplicate on the next Publish).
   *  - Non-empty id → UPDATE: **vault-wins**. Writes are fire-and-forget (202, async), so a
   *    reliable "did the app copy move?" check isn't possible; the DM's Obsidian edit is the
   *    authority. We still GET the server copy to build a full-row body (no NOT-NULL clobber,
   *    TW-2) + diff outgoing links.
   */
  async upsertCanon(entity: CanonEntity, opts: { expectedUpdatedUtc?: string | null }): Promise<UpsertResult> {
    void opts; // update is vault-wins; expectedUpdatedUtc is unused (see above)

    if (!entity.id) {
      if (!(await this.serverSupportsWriteResult())) {
        return {
          status: "unsupported",
          message: `Creating "${entity.name}" needs the rebuilt server (it must return the new id). Rebuild your local stack, then retry.`,
        };
      }
      const createRes = await this.write("POST", `/api/canon/${routeSegment(entity.type)}`, buildCanonCreateBody(entity));
      if (!createRes.ok) return { status: "error", message: `create failed — ${createRes.message}` };
      const written = createRes.json as { id?: string; updatedUtc?: string } | undefined;
      if (!written?.id) {
        return { status: "error", message: `create of "${entity.name}" returned no id — the server may predate the write-result change.` };
      }
      let linksAdded = 0;
      for (const link of entity.links) {
        const res = await this.write("POST", `/api/canon/links`, {
          fromType: entity.type, fromId: written.id, linkType: link.linkType, toType: link.toType, toId: link.toId,
        });
        if (!res.ok) return { status: "error", message: `link add failed — ${res.message}` };
        linksAdded++;
      }
      const created: CanonEntity = { ...entity, id: written.id, updatedUtc: written.updatedUtc ?? new Date().toISOString() };
      return { status: "ok", entity: created, created: true, linksAdded, linksRemoved: 0 };
    }

    const type = entity.type;
    const detail = await this.fetchDetail(type, entity.id);
    if (!detail) {
      return {
        status: "error",
        message: `"${entity.name}" (${type} ${entity.id}) no longer exists in the app — it may have been deleted. The note was left untouched.`,
      };
    }

    const body = buildCanonUpdateBody(entity, detail);
    if (!body) return { status: "error", message: `Could not build an update body for ${type} ${entity.id}.` };

    const put = await this.write("PUT", `/api/canon/${routeSegment(type)}/${entity.id}`, body);
    if (!put.ok) return { status: "error", message: `PUT ${type} failed — ${put.message}` };

    const { linksAdded, linksRemoved, linkError } = await this.reconcileLinks(entity, detail);
    if (linkError) return { status: "error", message: linkError };

    // vault-wins: re-stamp from what we pushed. taverntop_updated_utc is informational only (it is
    // excluded from the content hash), so a client-side timestamp here cannot cause a false conflict.
    const echoed: CanonEntity = { ...entity, updatedUtc: new Date().toISOString() };
    return { status: "ok", entity: echoed, created: false, linksAdded, linksRemoved };
  }

  /** Apply the outgoing-link diff: POST genuinely-new edges, DELETE ones the vault dropped. */
  private async reconcileLinks(
    entity: CanonEntity,
    detail: CanonEntityDetailWire
  ): Promise<{ linksAdded: number; linksRemoved: number; linkError?: string }> {
    const { toAdd, toRemove } = diffLinks(detail.links, entity.links, entity.type, entity.id);
    let linksAdded = 0;
    let linksRemoved = 0;

    for (const link of toAdd) {
      const res = await this.write("POST", `/api/canon/links`, link);
      if (!res.ok) return { linksAdded, linksRemoved, linkError: `link add failed — ${res.message}` };
      linksAdded++;
    }
    for (const linkId of toRemove) {
      const res = await this.write("DELETE", `/api/canon/links/${linkId}`);
      if (!res.ok) return { linksAdded, linksRemoved, linkError: `link remove failed — ${res.message}` };
      linksRemoved++;
    }
    return { linksAdded, linksRemoved };
  }

  /**
   * A write request (POST/PUT/DELETE). Create/update return 202 + a small `CanonWriteResultDto`
   * body ({id, updatedUtc}); link/delete writes return 202 with no body.
   */
  private async write(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: object
  ): Promise<{ ok: boolean; message?: string; json?: unknown }> {
    try {
      const res = await requestUrl({
        url: this.url(path),
        method,
        headers: await this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        throw: false,
      });
      if (res.status >= 200 && res.status < 300) {
        let json: unknown;
        try {
          json = res.json;
        } catch {
          json = undefined; // no/empty body (e.g. a link write)
        }
        return { ok: true, json };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, message: `not authorized (HTTP ${res.status})` };
      if (res.status === 409) return { ok: false, message: `conflict (HTTP 409)` };
      return { ok: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  /**
   * Does this server return the new id on create? The write-result and `/entities/full` endpoints
   * ship together, so a live `/entities/full` is a reliable proxy — and probing it BEFORE a create
   * POST guards against an un-rebuilt server, which would create a row without returning its id
   * (→ a duplicate on the next Publish).
   */
  private async serverSupportsWriteResult(): Promise<boolean> {
    const res = await requestUrl({
      url: this.url("/api/canon/entities/full?limit=1"),
      method: "GET",
      headers: await this.headers(),
      throw: false,
    });
    return res.status !== 404;
  }
}

/** id + display name from whichever per-type payload the detail carries (for the wikilink roster). */
function detailIdentity(d: CanonEntityDetailWire): { type: string; id: string; name: string } | null {
  if (d.npc) return { type: "npc", id: d.npc.id, name: d.npc.name };
  if (d.location) return { type: "location", id: d.location.id, name: d.location.name };
  if (d.thread) return { type: "thread", id: d.thread.id, name: d.thread.title };
  if (d.hook) return { type: "hook", id: d.hook.id, name: d.hook.title };
  if (d.lore) return { type: "lore", id: d.lore.id, name: d.lore.title };
  if (d.rumor) return { type: "rumor", id: d.rumor.id, name: d.rumor.text };
  if (d.faction) return { type: "faction", id: d.faction.id, name: d.faction.name };
  return null;
}

/** The `created_utc` of whichever payload the detail carries — the keyset page cursor. */
function detailCreatedUtc(d: CanonEntityDetailWire): string | undefined {
  return (
    d.npc?.createdUtc ??
    d.location?.createdUtc ??
    d.thread?.createdUtc ??
    d.hook?.createdUtc ??
    d.lore?.createdUtc ??
    d.rumor?.createdUtc ??
    d.faction?.createdUtc
  );
}
