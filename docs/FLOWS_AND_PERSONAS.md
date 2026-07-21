# Taverntop Obsidian Plugin — Flows & Personas

**Status:** 🟡 Design doc, under active discussion (owner + Claude, 2026-07-10). Companion to
[`VAULT_MODEL.md`](./VAULT_MODEL.md) (how an entity becomes a note) and
[`SYNC_CONTRACT.md`](./SYNC_CONTRACT.md) (the pull/push/auth contract). This doc is the *why* —
who uses the plugin, and the journeys we build around. Flesh out in place.

> **North star:** the app is "a world that fills itself from play." The plugin is the DM's
> **local-first workbench** on that world. Adventure planning is the **spine** we build around;
> pure canon-tending is the same machinery entered by a different door.

---

## The loop (vocabulary)

Everything is one small loop, themed to match the pitch (prep-as-harvest):

```
                 Connect  (OAuth → your guild/tenant, optional campaign filter)
                    │
        ┌───────────┴───────────┐
     Seed                    Harvest
  (create canon            (pull app → vault:
   in the vault)            canon + adventures + sessions)
        │                        │
        └───────────┬────────────┘
                 Enrich   (write/edit locally — prose, secrets, links)
                    │
                 Publish  (push vault → app; conflicts = sidecars, never silent loss)
                    │
                 Export   (one-way projections, dm_only stripped)
                    ├── Player Vault  (Obsidian, navigable)
                    └── Brew          (Homebrewery markdown → D&D book)
```

- **Connect** — the vault↔app link. It is your token → tenant (+ optional `campaignId`). *Not* an adventure.
- **Seed** — create new canon in the vault (`Seed an NPC`…). Mints the id; `origin: manual`, `canon_status: provisional`.
- **Harvest** — pull the app's world down as interconnected notes. The reap.
- **Enrich** — edit locally in Obsidian's nicer editor.
- **Publish** — push local work up so the Planner/Assemble/players see it.
- **Export** — generated, one-way artifacts. Two targets today (Player Vault, Brew).

---

## Mental model (the thing that dissolves "how do I link without an adventure")

- **Canon is adventure-independent.** An NPC/Location/Thread exists on its own. Adventures merely
  *reference* canon via `[[wikilinks]]`.
- **The link is auth + campaign**, established at Connect. No adventure required to create or sync canon.
- **The adventure is a *gathering context*, not a prerequisite.** When a DM preps an adventure, its
  harvested one-pager note is what pulls the relevant canon toward them and gives new Seeds a home.
- **Shared identity wires the graph for free.** Because both sides key on `taverntop_id`, a harvested
  adventure's beat `[[refs]]` auto-resolve to canon notes the moment those notes exist — no manual linking.

---

## Personas — a spectrum from author to producer

| | Center of gravity | Entry | Biggest need |
|---|---|---|---|
| **Mike** | light author, planning-first | gentle onboarding | no setup tax; blank-page rescue |
| **Lauren** | veteran author, two worlds | reconcile / adopt | merge her vault + the system without dupes or clobbering |
| **Shawn** | producer / publisher | app-first (Canon Hub, Dream Board, blank canvas) | turn the world into a beautiful book |

*Authors (Mike, Lauren) create & enrich canon. The producer (Shawn) renders it to artifacts.*
*The plugin serves the whole arc: Connect → Harvest/Seed → Enrich → Publish → Export.*

---

## User stories

Tags: **[Onboarding] [Harvest] [Planning] [Seed] [Migration] [Canon-tending] [Reconcile] [Export] [Conflict]**

### Mike — new to the vault, a few loose notes
*Runs games on Taverntop, keeps a shoebox Obsidian vault, mildly afraid of "setup."*

- **M1 · [Onboarding]** — Connect and have the plugin claim only a `Taverntop/` subtree, so my existing scribbles are untouched and I didn't have to convert anything.
- **M2 · [Harvest]** — First Harvest drops whatever canon my guild has into the vault, interconnected, so I open to a living world, not a blank page.
- **M3 · [Planning — spine]** — Open next week's adventure one-pager and click from its `[[canon refs]]` straight into the NPCs/locations it uses — prepping and reading the world are one motion.
- **M4 · [Planning → Seed]** — Invent a tavern-keeper mid-prep; Seed her in the adventure's context (auto-linked to its location) and Publish, so the app adventure can reference her.
- **M5 · [Migration]** — Turn an old loose NPC note into real canon without retyping — the plugin adopts it (stamps id + frontmatter) and Publishes.
- **M6 · [Canon-tending]** — On a no-game night, wander the graph and flesh out a rumor or two and Publish; the world grows without "planning."

### Lauren — veteran with two worlds to merge
*Years of her own Obsidian adventures in her own structure, plus ~7 adventures already live in Taverntop. Dropping in cold — she didn't grow up with the deployment. Fears: duplication, us trampling her vault, redoing work.*

- **L1 · [Onboarding / safety]** — The plugin stays strictly inside `Taverntop/`, so my existing adventures/folders are provably safe.
- **L2 · [Harvest]** — Harvest my 7 system adventures + their canon so I can SEE what the system holds next to what I have locally.
- **L3 · [Reconcile]** — My local "The Sunken Vault" is the same as one of the 7; mark them as one (adopt the system id onto my note) so my worlds converge instead of fork.
- **L4 · [Migration]** — Adopt the NPCs my local notes invented into Taverntop canon, so my published adventures can reference them and players see the safe parts.
- **L5 · [Planning — spine]** — Prepping adventure #8, pull just the relevant slice of a big canon, enrich, seed new bits — all threaded into the adventure — without drowning in the whole world.
- **L6 · [Canon-tending]** — Between arcs, a big continuity-and-secrets pass across the harvested world, Published back so the whole table benefits.
- **L7 · [Conflict]** — When my co-DM edits an NPC in the app while I edit it in the vault, I get a conflict sidecar on Publish, never a silent loss.

### Shawn — app-heart, Obsidian-hands, Homebrewery-output
*Lives in the Canon Hub + Dream/Hook Board, spins up a blank-canvas adventure, then takes the raw material into Obsidian to produce a PHB/DMG-styled book via [Homebrewery](https://homebrewery.naturalcrit.com/).*

- **S1 · [Onboarding]** — Gather in Canon Hub + Dream Board, kick off a blank-canvas adventure, then Harvest into Obsidian — the app is my on-ramp, Obsidian is my workbench.
- **S2 · [Enrich for print]** — Enrich harvested notes with book-shaped content (read-aloud boxes, sidebars, art callouts), so the vault holds publish-ready prose.
- **S3 · [Export → Brew]** — One click turns selected notes into Homebrewery-flavored markdown (page breaks, styled blocks, stat blocks, cover), so I paste into Homebrewery and get a near-finished book.
- **S4 · [Export / secrets]** — Book exports strip `%% dm_only %%`, so no secret leaks into a shared PDF.
- **S5 · [Export / compile]** — Compile a *set* of notes into one brew — an arc, "a Bestiary of C2's NPCs," "the Tethertown Gazetteer."
- **S6 · [Export / projection]** — The brew is a generated, one-way artifact — never edit-and-push-back — so canon stays authoritative and the book is a clean render.

---

## The flows and what each needs

| Flow | Story home | Machinery |
|---|---|---|
| **A — Seed & Publish** | M4, L4, L5 | `Seed [Type]` + id-mint + link-autocomplete (`EditorSuggest`) + `Publish` |
| **B — Harvest & Enrich** | M2, M6, L2, L6, S1 | Connect (OAuth) + `Harvest Canon` + edit + conflict sidecars + `Publish` |
| **C — Read at table** | M3, L5 | falls out of Harvest (adventure/session one-pagers, read-only) |
| **D — Export** | S3–S6, + player-world | `Export Player Vault` (strip) and `Export Brew` (strip + Homebrewery render) |

---

## Export family (one strip, two renderers)

Player-vault export and Shawn's brew are the same operation — strip `dm_only`, then render.

| Projection | Target | Wikilinks | Styling |
|---|---|---|---|
| **Player Vault** | Obsidian vault | kept (navigable) | plain notes |
| **Brew** | Homebrewery markdown | flattened to display names | PHB/DMG injectors |

**Brew emitter mapping (Obsidian md → Homebrewery md):**
- Structure → `\page` between entities/sections, `\column` where a two-column page wants it, a front cover.
- Callouts → injectors: one-line/read-aloud → `{{descriptive}}`, sidebar → `{{note}}`; secrets stripped.
- `[[wikilinks]]` → flat display names (a printed page can't click; "see p. X" cross-refs are a later nicety).
- Monsters (via the existing `IMonsterCatalog`/Open5e seam) → `{{monster,frame}}` stat blocks. *High-delight, higher-effort — fast-follow.*
- Images (`imageUrl`/`referenceMapUrl`) → Homebrewery image blocks; frontmatter dropped.
- No Homebrewery API integration — generate a `.brew.md` / copy to clipboard; the DM pastes it in.

---

## Cross-cutting threads

- **The sacred boundary** (M1, L1) — the plugin owns `Taverntop/`; everything else in the DM's vault is untouchable. The trust foundation.
- **Adopt / migrate** (M5, L4) — turn a pre-existing loose note into canon: an `Adopt into Canon` command that stamps id + frontmatter + Publishes.
- **Reconcile** (L3) — match a local adventure/entity to a system one: an explicit "This note is system ▸" picker (with name-match suggestions), which stamps the system id onto the local note.
- **Conflict** (L7) — detect-and-sidecar in both directions; no auto 3-way merge in v1; the human reconciles.
- **Adventure as gathering context** (M3, M4, L5) — the harvested adventure one-pager is where its canon converges and where Seeds attach.

---

## Open forks — proposed defaults (confirm / adjust)

1. **Adventure authoring stays app-side** (Quill-first Adventure Canvas). The vault *authors canon*, *reads adventures* as one-pagers, and *exports*. → keeps v1 scope sane; revisit vault-side adventure authoring later.
2. **Adventure context = the harvested one-pager note.** Seed-from-adventure attaches new canon to that note's campaign + links it. (Answers "what is an adventure context in the vault.")
3. **Adopt** = a command that stamps a loose note as canon and Publishes. **In scope** (migration slice).
4. **Reconcile** = explicit picker, name-match assisted. **In scope** (migration slice).
5. **Dashboards = native Bases** (no Dataview dependency); Dataview optional for power users.
6. **Brew export = fast-follow** riding the dm_only-strip; **stat blocks = fast-follow of that**.
7. **Client-minted id?** — TBD: does `CanonController` accept a client id on create (clean offline Seed) or assign server-side (Seed reconciles on Publish)? Verify the controller at build time.
8. **Harvest cadence** — **v1 = keyset full-Harvest** (the live `GET /api/canon/entities` is keyset-paginated on `created_utc` via `before`/`limit`; no `since=` delta). Re-Harvest re-walks the world, but the per-note content hash means only *changed* notes get rewritten. **DELTA is a wanted future option** (owner 2026-07-10): build "Harvest only what changed since last time" on top of `GET /api/canon/reveals?since=`. Keep the seam open; don't fake a `since=` the entities endpoint doesn't honor.

---

## Proposed slice breakdown (build order)

Underneath all of it: the side panel (`ItemView`), `Initialize Taverntop Vault` (folders + Bases + home note + examples), registered property types.

- **O1 — Connect + Harvest** *(Flows B + C)* — PKCE client `taverntop.obsidian` in IdentityServer (**auth-touching → `/auth-flow-review`**); reconcile `HttpCanonApiClient` against the *real* `CanonController` routes; `Connect` (OAuth) + `Harvest Canon` (canon + adventures + sessions). Payoff: sign in, harvest, browse the world.
- **O2 — Seed + Publish** *(Flow A)* — `Seed [Type]` + id-mint + link-autocomplete; `Publish to Canon` (per-type POST/PUT) + conflict sidecars; resolve fork #7.
- **O3 — Adopt + Reconcile** *(Mike M5, Lauren L3/L4)* — `Adopt into Canon` + the reconcile picker.
- **O4 — Export** *(Flow D + Shawn)* — `Export Player Vault` (strip), then `Export Brew` (Homebrewery), then monster stat blocks.

Order de-risks: Harvest proves auth + the read path before we open the write path; export rides on a proven model.

---

*Nothing here is built yet. This is the plan we flesh out and then execute on `rd-module27-slice1`.*
