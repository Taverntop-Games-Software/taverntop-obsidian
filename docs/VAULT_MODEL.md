# The vault canon model

How every Taverntop entity becomes an Obsidian note. This is the human-readable
companion to [`src/vault/VaultMapper.ts`](../src/vault/VaultMapper.ts), which is the
executable source of truth.

## Folder layout

One folder per canon type, one note per entity. Adventures and Sessions get their own
top-level folders. A `_taverntop/` folder holds plugin sync state (not hand-edited).

```
<vaultRoot>/                      (default "Taverntop"; set in plugin settings)
  _taverntop/                     sync bookkeeping (id→path map, cursors) — plugin-owned
  Canon/
    NPCs/         <Name>.md
    Locations/    <Name>.md
    Threads/      <Name>.md
    Hooks/        <Name>.md
    Lore/         <Name>.md
    Rumors/       <Name>.md
    Factions/     <Name>.md
  Adventures/     <Code> - <Title>.md
  Sessions/       <Date> - <Title>.md
```

Filenames are sanitized (OS/Obsidian-illegal characters stripped) and are **display
labels only** — identity lives in frontmatter, so renaming a note never breaks sync.

## Frontmatter — the structured layer

Every canon note carries the cross-cutting fields from spec §3.5/§3.6, plus
type-specific fields, plus its links. Bookkeeping keys are `taverntop_*`.

```yaml
---
taverntop_id: npc-0002            # GUID — the round-trip identity key (never hand-edit)
taverntop_type: npc               # npc | location | thread | hook | lore | rumor | faction
tenant_id: "2004"
campaign_id: c2                   # null → guild-universal
canon_status: confirmed           # provisional | confirmed
viability: live                   # live | archived | dead | not_in_use  (Door-A keep/cut)
origin: recapped                  # planned | recapped | imported | manual
visibility: dm_only               # player | dm_only  (entity-level tier)
name: The Faceless Broker
title: Trader in Stolen Faces     # type-specific (NPC epithet)
pronouns: they/them
life_status: alive
disposition: varies
member_of: ["[[The Faceless]]"]   # canon_link edges, grouped by link_type →
involves: ["[[Who Is Tearing Pieces Out of Tethertown]]"]   #   rendered as wikilinks
_link_ids:                        # durable round-trip source for the edges above
  - "member_of|faction|fac-faceless|The Faceless"
  - "involves|thread|thr-0002|Who Is Tearing Pieces Out of Tethertown"
taverntop_updated_utc: 2026-06-27T18:00:00Z   # server's last-modified (concurrency)
taverntop_synced_utc: 2026-07-01T12:00:00Z    # when the plugin last wrote this note
taverntop_hash: 1a2b3c4d          # content hash at last sync (conflict detection)
---
```

### Links → wikilinks

Typed `canon_link` edges `(from, link_type, to)` become `[[wikilinks]]` **grouped by
`link_type`** so the Graph view and human reading both work. Because a wikilink only
carries a name, the durable half — `(link_type, to_type, to_id, to_name)` — is stored
in the `_link_ids` array; that array is authoritative on push-back, while the wikilink
name is refreshed if the target note was renamed.

Link types mirror the spec: `member_of`, `found_at`, `home_of`, `controlled_by`,
`involves`, `continues`, `spawned_from`, `known_to`, `about`, `references`. The
"spider-web traversal / Wikipedia game" the DMs asked for (spec §445) is just Obsidian's
native backlink/graph navigation over these edges.

## Body — prose + the DM-only region

The note body carries the readable content and a **fenced DM-only region** for
field-level secrets (spec §3.6 — an entity can be player-visible while specific facets
stay DM-only):

```markdown
> [!info] One-line
> A Faceless agent who deals in identities torn from Tethertown.

## Description
...player-visible longform...

%% dm_only %%
> [!secret] Secret
> Is itself a fragment Morosyth once devoured; fears the Vanguard holds another.

> [!secret] Want
> To recover the fragment the Vanguard holds.
%% /dm_only %%
```

`%% … %%` is Obsidian comment syntax, so the region is invisible in reading view but
present in the file. A future **player-vault export** strips everything between
`%% dm_only %%` and `%% /dm_only %%` (and drops entity-level `visibility: dm_only`
notes entirely) — mechanical, no prose parsing. This is the concrete answer to the
"Obsidian captures less structure" rub: secrets stay first-class and separable.

**All DM-only content lives in this fence — never in frontmatter** (frontmatter is *not*
stripped on export). That includes the scalar facets the API returns to a DM: rumor
`truth`, and the NPC performance card (speech / body-language / temperament /
signature-phrase / want). `dtoMapping.ts` routes them here as `> [!secret]` callouts;
frontmatter carries only non-secret fields.

## Adventures & Sessions (push-down, read-mostly)

Adventures are authored app-side (Quill-first), so they render as clean one-pagers for
at-table reference. Acts → `##` headings (with timeboxes), beats → `###` headings
tagged with the beat kind, and canon references become `[[wikilinks]]`:

```markdown
## Act 1 — Setup  _(15m)_
### Introduce the NPCs  `npc`
Thoren is back from the Vault and fixated on Malrik's cloak.
_Canon:_ [[Thoren]]
```

Sessions link their adventures. Neither is a push target in v0 (prose edits could be
enabled later); they are projections of app data.

## What round-trips, and what doesn't

| Layer | Pull (app→vault) | Push (vault→app) |
|---|---|---|
| Frontmatter identity/type/tenant | written | read, sent as-is |
| Typed links (`_link_ids`) | written | read, sent (durable) |
| Visibility (entity + `%% dm_only %%`) | written | read, preserved |
| Prose (one-line, description, current-state, context, lore/rumor body) | written | **editable → pushed** |
| Server-owned fields (`updated_utc`, `canon_status`) | written | not authored client-side; server merges |
| Adventures / Sessions | written | read-only in v0 |
