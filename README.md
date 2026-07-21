# Taverntop Sync — Obsidian plugin

Two-way sync between an Obsidian vault and the **Taverntop Canon Engine**. It is the
**sync bridge, not the authoring home**: the Taverntop web app is the primary place
canon is authored; this plugin lets DMs who prefer *"markdown is king"* work in
Obsidian and stay in sync.

- **Pull** (app → vault): the canon entities — **NPC, Location, Thread, Hook, Lore,
  Rumor, Faction, Item** — plus **Adventures** (and their beats), written as markdown
  notes with YAML frontmatter and `[[wikilinks]]` that mirror the backend's typed
  `canon_link` edges.
- **Push** (vault → app): canon notes edited in Obsidian go back to the app, with
  content-hash conflict detection (a divergence writes a `.conflict.md` sidecar rather
  than silently overwriting).

> **Status: beta.** The plugin talks to the live Canon Engine over REST and signs in
> with **OAuth (PKCE)** — no token pasting. It ships and updates through **BRAT** while
> we harden it; a Community-plugin listing will follow once it's stable.

## Install (beta) via BRAT

1. In Obsidian, install and enable **BRAT** (*Obsidian41 — Beta Reviewer's Auto-update
   Tool*) from *Settings → Community plugins*.
2. BRAT → **Add beta plugin** → paste
   `Taverntop-Games-Software/taverntop-obsidian` → **Add Plugin**.
3. Enable **Taverntop Sync** in *Settings → Community plugins*. BRAT keeps it up to date
   as new releases are cut.
4. Open **Taverntop Sync** settings and **Sign in** — it defaults to the hosted app
   (`https://app.taverntop.games` / `https://id.taverntop.games`). Then run **Pull**.

> Manual install (no BRAT): download `main.js`, `manifest.json`, and `styles.css` from
> the latest [release](https://github.com/Taverntop-Games-Software/taverntop-obsidian/releases)
> into `<vault>/.obsidian/plugins/taverntop-sync/`, then enable the plugin.

## Why it exists (the design intent)

Quill-first authoring in the app, with Obsidian sync for DMs who'd rather write in
markdown. The known tension: Obsidian-first authoring tends to capture **less
structured canon** — just prose. This plugin deliberately pushes back on that by
keeping structured facets — entity type, typed links, visibility, an NPC's
`want`/`secret` — in **frontmatter and tagged callouts**, not melted into paragraphs.
So a note round-trips as *real canon*, not just text.

## Sync contract at a glance

Full detail in [`docs/SYNC_CONTRACT.md`](docs/SYNC_CONTRACT.md); the short version:

| Concern | Stance |
|---|---|
| **Identity** | `taverntop_id` (GUID) in frontmatter. Filename is a mutable label; renames are safe. |
| **Links** | Typed `canon_link` edges → `[[wikilinks]]` grouped by edge type; a `_link_ids` frontmatter array is the durable round-trip source. |
| **Visibility** | Entity-level `visibility: player \| dm_only` in frontmatter; field-level DM secrets in a `%% dm_only %%` fenced region (strippable for a player vault). |
| **Conflicts** | *Detect + sidecar.* Per-note content hash detects local edits; a divergence writes a `<name>.conflict.md` instead of silently overwriting. Pull defaults app-wins, push defaults vault-wins. |
| **Auth** | OAuth **PKCE** against the Taverntop identity server (public client `taverntop.obsidian`); the `obsidian://` callback completes sign-in. Tokens live in the plugin's local data, never in a note. |
| **Endpoints** | `GET /api/canon/entities` (+ bulk detail), per-type `POST`/`PUT`, and the adventure round-trip. See the sync contract. |

## Develop

```bash
npm install
npm run dev        # esbuild watch → main.js
npm run build      # typecheck + production bundle
npm run smoke      # headless round-trip smoke test
```

To try a dev build in Obsidian, symlink or copy this folder (with a built `main.js`)
into a vault under `.obsidian/plugins/taverntop-sync/` and enable it. Point
**API base URL** at your local server (e.g. `https://localhost:7253`) for local dev.

## Releasing

Releases are automated ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

```bash
npm version patch            # bumps package.json + syncs manifest.json/versions.json
git push --follow-tags       # the tag (== manifest version) fires the release build
```

The workflow builds and attaches `manifest.json`, `main.js`, and `styles.css` as loose
assets to a GitHub Release named for the tag — the layout BRAT and the Obsidian
community client expect. **The tag must equal `manifest.json`'s `version` exactly (no
`v` prefix)**; the workflow fails fast if they diverge.

## Layout

```
manifest.json          Obsidian plugin manifest
versions.json          plugin-version → min-Obsidian-version map
version-bump.mjs        keeps manifest/versions in lockstep with `npm version`
package.json            npm scripts + dev deps
esbuild.config.mjs      bundles src/ → main.js
.github/workflows/release.yml   tag → GitHub Release with built assets
docs/
  VAULT_MODEL.md        how every entity maps to a note (folders, frontmatter, links)
  SYNC_CONTRACT.md      endpoints, ID strategy, conflict/merge stance, auth
  FLOWS_AND_PERSONAS.md the DM workflows this serves
src/
  main.ts               plugin entry — commands, ribbon, settings wiring
  settings.ts           settings tab + model (API URL, OAuth, vault root)
  auth/                 OAuth PKCE (pkce.ts, oauth.ts)
  model/canon.ts        the canon domain model
  api/                  CanonApiClient seam + Http/Mock impls + wire DTOs
  vault/                entity ⇄ markdown note (mapper, frontmatter, wikilinks, hash)
  sync/SyncEngine.ts    pull/push orchestration + conflict → sidecar
  export/               player-vault export (DM-secret stripping)
```

## License

MIT — see [LICENSE](LICENSE).
