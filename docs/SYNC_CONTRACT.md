# Sync contract

The contract between the plugin and the **live** Canon Engine API (Module 27's
`CanonController`, route base `api/canon`, policy `CampaignApiAccess`), plus the ID /
conflict / auth strategy. **Reconciled to the shipped controller 2026-07-10** — the routes
below are the *real* ones, wired in [`HttpCanonApiClient`](../src/api/HttpCanonApiClient.ts)
through the [`CanonApiClient`](../src/api/CanonApiClient.ts) seam. Wire shapes live in
[`wire.ts`](../src/api/wire.ts); [`dtoMapping.ts`](../src/api/dtoMapping.ts) folds them into
the model (adapt there, never bend `src/model/canon.ts`).

## Directions

| Direction | What moves | Notes |
|---|---|---|
| **Pull** (app → vault) | Canon (7 types), Adventures, Sessions | Canon is authored both sides; Adventures/Sessions are app-authored (Quill-first) and read-mostly in the vault. |
| **Push** (vault → app) | Locally-edited canon notes | Only notes whose live hash ≠ stamped hash are sent. Adventures/Sessions are not pushed in v0. |

## Endpoints (real — `CanonController`)

| Method & path | Purpose | Maps to |
|---|---|---|
| `GET /api/canon/entities?type=&campaignId=&visibility=&viability=&q=&limit=&before=` | keyset-paginated card list | `ping()` + harvest fallback |
| `GET /api/canon/entities/full?…` (same filters as `/entities`) | keyset page of **FULL** detail (entity + links + appearances + secrets) in ONE call | `listCanon()` bulk path — **collapses the harvest N+1** |
| `GET /api/canon/entities/{type}/{id}` | full entity + links + appearances + secrets | `getCanon()` + the push concurrency pre-check |
| `PUT  /api/canon/{…}/{id}` | full-row update (per-type DTO) | `upsertCanon()` update — ✅ **O2 (built)** |
| `POST /api/canon/links` · `DELETE /api/canon/links/{id}` | link edges, separate from the entity body | link push — ✅ **O2 (built)** |
| `POST /api/canon/{npcs\|locations\|threads\|hooks\|lore\|rumors\|factions}` | create (per-type DTO) → returns `{id, updatedUtc}` | `upsertCanon()` create — ✅ **built** (capability-gated) |

- **No `ping`** — the connectivity/auth probe is a 1-row `GET /entities?limit=1`.
- **No `since=` delta** — the list is keyset-paginated on `created_utc` (`before`+`limit`); Harvest pages the world (delta later via `GET /api/canon/reveals?since=` — FLOWS_AND_PERSONAS fork #8).
- **Harvest uses `/entities/full`** — full detail a page at a time, so a whole-world Harvest is ~2 calls, not the old "1 list + N per-entity detail" (~99 for 97 entities). If the server predates the endpoint (404), the client transparently falls back to the card-list + per-entity-detail path, so an old and a new stack both work.
- **Adventures / Sessions** (Flow C) live in *other* controllers — not wired yet.

### Visibility — the plugin is a DM tool; the *export* does the stripping
The read endpoints run **`dmView: true`**: a `CampaignApiAccess` caller (a DM token) gets
the **full** world — dm_only entities, the NPC performance card, rumor `truth`, and the
`secrets` list. The API does **not** player-vs-DM filter on these reads. So the
player/`dm_only` split is the plugin's **client-side export strip** (drop
`visibility: dm_only` notes + everything inside the `%% dm_only %%` fence). The mock client
simulates a player token via its `dmMode` flag to test that strip.

## ID strategy

- **`taverntop_id` (GUID)** in frontmatter is the entity's identity across sync. It is
  written on pull and echoed on push; never hand-edited.
- **Filenames are labels**, not identity. A DM can rename `Kaelen.md` → `Kaelen Vondt.md`
  and sync still matches on the id. (An id→path map under `_taverntop/` lets the plugin
  find the existing note after a rename; v0 also falls back to the name-derived path.)
- **New notes authored in the vault** (no `taverntop_id`) are out of scope for v0 push —
  the app is the source of new canon. A future enhancement can mint client-side GUIDs
  and let `upsertCanon` create server-side.

## Conflict / merge stance — *detect + sidecar* (confirmed for v0)

No silent overwrites in either direction. A per-note **content hash**
(`taverntop_hash`, over frontmatter-minus-bookkeeping + body) detects local edits;
combined with the server's `updated_utc` it distinguishes the cases:

**On pull (app → vault):**
- Local note *unchanged* since last sync → overwrite with incoming (clean).
- Local note *edited* → the incoming server copy would destroy those edits, so the
  current local content is copied to `<name>.conflict.md` first, then the server copy
  is written. Default winner: **app**. The DM merges and deletes the sidecar.

**On push (vault → app) — O2, BUILT (update + links), VAULT-WINS:**
The live write endpoints are **fire-and-forget NSB** (`202 Accepted`, no body, no post-write
acknowledgement). A reliable client-side "did the app copy move under me?" check would need the
post-write server state, which the plugin can't read without racing the async handler — two
attempts at that in UAT (2026-07-12: optimistic-stamp, then poll-for-commit) both false-
conflicted. So **v0 push is vault-wins**: the DM's Obsidian edit is authoritative.
- The plugin **GETs the current server copy** — **not** a concurrency gate, but to (a) build the
  update body as **server-wire-as-base + overlay the vault-owned fields** (never nulls a NOT-NULL
  column, never drops a field the vault doesn't round-trip — **TW-2**) and (b) diff outgoing links.
- **PUT** the full row, then reconcile outgoing links: POST additions / DELETE removals by link id
  (the create-link endpoint does **not** dedupe, so only genuinely-new edges are POSTed).
- `taverntop_updated_utc` / `taverntop_created_utc` are **excluded from the content hash**
  (`noteHash.ts`), so re-stamping the server timestamp never reads as a content edit.
- **Cross-tool conflict detection is deferred** to the server "writes return their post-write
  state" change (the same change that unblocks create-from-vault). Until then, if the *same* canon
  is edited in the app **and** the vault between syncs, the vault push wins (rare for a solo DM).

**Pull (app → vault) still sidecars** (below) — the vault-wins stance is push-only, so no
Publish can silently clobber *local* work, and any *app-side* change is caught on the next Harvest.

v0 does **no automatic 3-way merge** — it guarantees no data loss and defers the merge
to the human. A future version could offer field-level merge for non-overlapping edits.

> **Structured-note caveat (validate in UAT).** A canon note is a *structured projection* of
> the entity (frontmatter + recognized sections: one-line, Description, Current state, Context,
> the `%% dm_only %%` fence). On a successful push the note is re-stamped by re-rendering from
> those fields, so **freeform prose added to a canon note outside the recognized structure is
> not round-tripped** (it can't be pushed, and the next Harvest — app-authoritative — would
> overwrite it anyway). Recognized edits (description, status, links, performance card, …)
> round-trip fully. Put freeform DM prose in a non-canon note. If UAT shows DMs want freeform
> preserved in canon notes, that's a v1 enhancement (in-place frontmatter patch + a body-merge).

### create-from-vault — ✅ built (server returns the new id)
Creating brand-new canon *from* a vault note works end-to-end. The blocker used to be that the
create endpoints server-generate the id (**TW-3**) and returned `202` with **no body**, so the
plugin couldn't learn the id to stamp the note (→ a duplicate on the next Publish). Fixed by
having the **controller pre-generate** the id + timestamps, pass them into the write, and return
them as a `CanonWriteResultDto {id, updatedUtc}`. Id generation stays **server-authoritative**
(the controller picks it; the client never does → **TW-3 respected**) — it's just *returned* now.

Flow: an id-less note carrying `taverntop_type` → `POST /api/canon/{type}` → the plugin stamps
the note with the returned id (so the next Publish is an update, not a second create) → the note's
links are pushed as additions. The client **capability-probes `/entities/full` first** and returns
`unsupported` (skips, no POST) against an un-rebuilt server, so it can never create a row it can't
stamp. Requires the server rebuild (write-result + bulk-detail ship together).

> **Update-side conflict detection stays deferred.** This pass gave *create* the id round-trip; the
> 7 UPDATE paths were left as **vault-wins** (unchanged) to keep the blast radius small. The same
> `updated_utc`-return treatment on the update side would restore cross-tool push conflict
> detection — a clean fast-follow, not done here.

## Auth

- **Paste a bearer token** (`authMode: "token"`) — for local testing before sign-in.
  Requests send `Authorization: Bearer <token>` via Obsidian's `requestUrl` (CORS/mobile-safe).
- **OAuth — Authorization Code + PKCE** (`authMode: "oauth"`), **built** (O1b-ii):
  - Public native client **`taverntop.obsidian`** (no secret; `RequirePkce`), registered in
    `InitializationService.cs`; redirect `obsidian://taverntop-sync/callback`; scope
    `openid profile email offline_access campaign`.
  - `src/auth/pkce.ts` (S256 verifier/challenge + state) + `src/auth/oauth.ts` (authorize URL,
    code exchange, refresh) + `main.ts` (protocol-handler capture, state/CSRF check, token cache,
    refresh-with-rotation). `resolveToken()` is the single token seam.
  - **`prompt=login` is sent deliberately** (auth-flow-review, TW-2/TW-3): it forces the
    interactive login → `RouteByMembershipAsync` → guild picker, so a multi-membership DM sets
    `selected_tenant_id` and the issued token carries `tenant_id` (ADR-0008 fail-closed). Without
    it, silent re-auth could skip the picker → no `tenant_id` → every `CampaignApiAccess` call 403s.
  - The **refresh token lives only in the vault's plugin data** (`data.json`), never in a note;
    it rotates on every refresh (client is `OneTimeOnly`). Access token is cached in memory only.
  - **`clientId` + `scope` are code constants** (`main.ts` `OAUTH_CLIENT_ID` / `OAUTH_SCOPE`),
    NOT settings — a stale `data.json` (which `loadData()` layers over `DEFAULT_SETTINGS`) once
    persisted the old `taverntop-obsidian` id + `canon.read/write` scopes and broke the first
    live sign-in with `Unknown client or not enabled`. Only `authorizeUrl`/`tokenUrl`/`apiBaseUrl`
    stay editable.
  - **Live UAT — PASSED 2026-07-11.** Signed in end-to-end (login → guild picker → `obsidian://`
    callback → "signed in ✓"), then Harvest returned **97 canon entities** — i.e. the issued
    token carries `tenant_id` and `CampaignApiAccess` fail-closed did not trip. Client-seeds-on-
    restart confirmed (dot-client authorize probe → `302 /Identity/Account/Login`). The
    `/auth-flow-review` CONDITIONAL is cleared **except** refresh-token rotation, which only
    proves out after the access token's ~1 h lifetime (built + reviewed; verify on a later Harvest
    after an idle gap that does *not* force a re-sign-in).

## Sync cadence (v0)

Manual only — ribbon icon + commands (**Harvest Canon**, **Publish to Canon**, **Test
connection**). Harvest is a keyset full-walk (write-only-what-changed via the note hash);
delta is a future option (fork #8). Auto-sync on interval/file-save is deferred until the
conflict UX is proven in manual use.
