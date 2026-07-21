/**
 * Headless smoke test of the sync round-trip against the MOCK client — no backend,
 * no Obsidian runtime. Proves the vault model + conflict detection end to end:
 *
 *   PULL  : mock canon → markdown note (frontmatter + wikilinks + dm_only region)
 *   EDIT  : simulate a DM editing the note in the vault
 *   PUSH  : note → entity → mock upsert (clean)
 *   CONFLICT: stale push → mock returns conflict (the sidecar trigger)
 *   PLAYER: player-token mock hides dm_only entities + facets
 *
 * Run: npm run smoke
 */
import assert from "node:assert";
import { MockCanonApiClient } from "../src/api/MockCanonApiClient";
import { canonToNote, noteToCanon } from "../src/vault/VaultMapper";
import { buildCanonUpdateBody, diffLinks } from "../src/api/dtoMappingOut";
import { CanonEntityDetailWire, CanonLinkWire, CanonNpcWire } from "../src/api/wire";
import { CanonLink, CanonNpc } from "../src/model/canon";
import { stripNoteForPlayers } from "../src/export/playerExport";
import { parseNote } from "../src/vault/frontmatter";
import { compareHash, hashNote } from "../src/vault/noteHash";

function ok(label: string) {
  console.log(`  ✓ ${label}`);
}

async function run() {
  console.log("Taverntop Sync — smoke test\n");

  // ---- PULL ---------------------------------------------------------------
  const dm = new MockCanonApiClient(true);
  const canon = await dm.listCanon({});
  assert(canon.length === 9, `expected 9 fixture entities, got ${canon.length}`);
  ok(`pulled ${canon.length} canon entities`);

  // Regression guard (UAT 2026-07-11): the plugin passes a BLANK campaign filter as `null`
  // (not undefined). Blank must mean "all campaigns + guild-universal", not "only the
  // null-campaign entities" — otherwise Harvest silently returns just the universal hook.
  const blankFilter = await dm.listCanon({
    types: ["npc", "location", "thread", "hook", "lore", "rumor", "faction"],
    campaignId: null,
  });
  assert(blankFilter.length === 9, `blank (null) campaign filter must return all 9, got ${blankFilter.length}`);
  ok("blank campaign filter (null) returns all canon (regression guard)");

  const thoren = canon.find((e) => e.id === "npc-0001") as CanonNpc;
  const note = canonToNote(thoren, "2026-07-01T12:00:00Z");

  assert(note.includes("taverntop_id: npc-0001"), "note carries stable id");
  assert(note.includes("visibility: dm_only") || note.includes("visibility: player"), "note carries visibility");
  assert(note.includes("[[The Vault]]"), "found_at link rendered as wikilink");
  assert(note.includes('_link_ids:'), "durable link ids present");
  assert(note.includes("%% dm_only %%") && note.includes("[!secret]"), "dm_only facets fenced");
  ok("rendered NPC note (id, visibility, wikilinks, dm_only region all present)");

  // ---- EDIT + clean PUSH --------------------------------------------------
  const edited = note.replace(
    "A scholar of the Spine whose curiosity outruns his caution.",
    "A scholar of the Spine whose curiosity has clearly outrun his caution."
  );
  assert(edited !== note, "edit applied");

  const parsedBack = noteToCanon(edited);
  assert(parsedBack !== null, "note parsed back to entity");
  assert(parsedBack!.entity.id === "npc-0001", "round-tripped id");
  assert(
    (parsedBack!.entity as CanonNpc).description?.includes("clearly outrun"),
    "edited prose survived the round-trip"
  );
  assert(parsedBack!.entity.links.length === 2, "links survived the round-trip");
  ok("parsed edited note back to a canon entity (prose + links intact)");

  const push = await dm.upsertCanon(parsedBack!.entity, {
    expectedUpdatedUtc: parsedBack!.entity.updatedUtc,
  });
  assert(push.status === "ok", `expected clean push, got ${push.status}`);
  ok("clean push accepted by mock");

  // ---- stale PUSH → CONFLICT ---------------------------------------------
  const stale = await dm.upsertCanon(parsedBack!.entity, {
    expectedUpdatedUtc: "1999-01-01T00:00:00Z", // pretend the vault synced from an old copy
  });
  assert(stale.status === "conflict", `expected conflict, got ${stale.status}`);
  ok("stale push detected as conflict (would write .conflict.md sidecar)");

  // ---- PLAYER token visibility -------------------------------------------
  const player = new MockCanonApiClient(false);
  const playerCanon = await player.listCanon({});
  assert(
    !playerCanon.some((e) => e.visibility === "dm_only"),
    "player token never receives dm_only entities"
  );
  const playerThoren = playerCanon.find((e) => e.id === "npc-0001") as CanonNpc | undefined;
  assert(playerThoren && playerThoren.dmOnly.length === 0, "player token receives no dm_only facets");
  ok(`player token: ${canon.length - playerCanon.length} dm_only entities hidden, secret facets stripped`);

  // ---- O2 CREATE (vault-authored new canon) → mock mints an id ------------
  const dm2 = new MockCanonApiClient(true);
  const newNpc = {
    id: "", // id-less = create
    type: "npc",
    tenantId: "2004",
    campaignId: null,
    canonStatus: "provisional",
    viability: "live",
    origin: "imported",
    visibility: "dm_only",
    name: "Brand New NPC",
    createdUtc: "",
    updatedUtc: "",
    links: [{ linkType: "found_at", toType: "location", toId: "loc-0002", toName: "The Vault" }],
    dmOnly: [],
  } as unknown as CanonNpc;

  const create = await dm2.upsertCanon(newNpc, { expectedUpdatedUtc: null });
  if (create.status !== "ok") throw new Error(`expected create ok, got ${create.status}`);
  assert(create.created === true, "id-less entity was created (not updated)");
  assert(!!create.entity.id, "create returns a minted id to stamp the note");
  assert(create.linksAdded === 1 && create.linksRemoved === 0, "create counts its links as added");
  ok("create round-trip: id-less note → minted id, link counted");

  // Second push of the now-id'd entity must be an UPDATE — no duplicate.
  const rePush = await dm2.upsertCanon({ ...create.entity }, { expectedUpdatedUtc: create.entity.updatedUtc });
  if (rePush.status !== "ok") throw new Error(`expected re-push ok, got ${rePush.status}`);
  assert(rePush.created === false, "re-push of a created entity is an update, not a second create");
  ok("re-push of created entity is an update (no duplicate)");

  // ---- O2 LINK DIFF (add one, drop one) ----------------------------------
  const dm3 = new MockCanonApiClient(true);
  const linkBase = (await dm3.getCanon("npc", "npc-0001")) as CanonNpc;
  assert(linkBase.links.length === 2, "fixture NPC starts with 2 links");
  const desiredLinks: CanonLink[] = [
    linkBase.links[0], // keep the first
    { linkType: "about", toType: "lore", toId: "lore-9999", toName: "New Lore" }, // add
  ]; // (the second original link is dropped)
  const linkPush = await dm3.upsertCanon({ ...linkBase, links: desiredLinks }, { expectedUpdatedUtc: linkBase.updatedUtc });
  if (linkPush.status !== "ok") throw new Error(`expected link push ok, got ${linkPush.status}`);
  assert(linkPush.linksAdded === 1, `expected 1 link added, got ${linkPush.linksAdded}`);
  assert(linkPush.linksRemoved === 1, `expected 1 link removed, got ${linkPush.linksRemoved}`);
  ok("link diff: adds the new edge, removes the dropped one");

  // ---- O2 TW-2 no-clobber: overlay edits, preserve unedited NOT-NULL fields
  const serverDetail: CanonEntityDetailWire = {
    entityType: "npc",
    npc: {
      id: "npc-x",
      campaignId: null,
      visibility: "dm_only",
      canonStatus: "confirmed",
      viability: "live",
      origin: "recapped",
      name: "Server Name",
      title: "the Bold",
      pronouns: null,
      imageUrl: null,
      oneLine: "server one-line",
      description: "server description",
      speech: "clipped and precise",
      bodyLanguage: null,
      temperament: "wary",
      signaturePhrase: null,
      want: "the old map",
      lifeStatus: "alive",
      disposition: null,
      fromCharacterId: null,
      createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-02-01T00:00:00Z",
    } as CanonNpcWire,
    location: null,
    thread: null,
    hook: null,
    lore: null,
    rumor: null,
    faction: null,
    links: [],
    appearances: [],
    secrets: [],
    claims: [],
  };
  // A vault note that only edited the description (viability/speech/want NOT present on it).
  const vaultEdit = {
    id: "npc-x",
    type: "npc",
    tenantId: "2004",
    campaignId: null,
    canonStatus: "provisional",
    viability: "", // note carried no viability — must NOT clobber the server's "live"
    origin: "manual",
    visibility: "dm_only",
    name: "Server Name",
    createdUtc: "",
    updatedUtc: "2026-02-01T00:00:00Z",
    links: [],
    description: "EDITED in the vault",
    dmOnly: [], // no performance-card facets → server card must survive
  } as unknown as CanonNpc;

  const body = buildCanonUpdateBody(vaultEdit, serverDetail) as Record<string, unknown>;
  assert(body.description === "EDITED in the vault", "vault edit is applied");
  assert(body.viability === "live", "NOT-NULL viability preserved from server (no clobber, TW-2)");
  assert(body.speech === "clipped and precise", "server performance-card field preserved");
  assert(body.want === "the old map", "unedited dm_only field preserved from server");
  ok("buildCanonUpdateBody overlays edits without nulling unedited NOT-NULL fields (TW-2)");

  // ---- O2 diffLinks (pure): add new, remove dropped-by-id, keep unchanged -
  const serverLinks: CanonLinkWire[] = [
    { id: "link-A", fromType: "npc", fromId: "npc-x", linkType: "found_at", toType: "location", toId: "loc-1", createdUtc: "" },
    { id: "link-B", fromType: "npc", fromId: "npc-x", linkType: "member_of", toType: "faction", toId: "fac-1", createdUtc: "" },
  ];
  const want: CanonLink[] = [
    { linkType: "member_of", toType: "faction", toId: "fac-1", toName: "Faction" }, // keep B
    { linkType: "about", toType: "lore", toId: "lore-1", toName: "Lore" }, // add C
  ];
  const { toAdd, toRemove } = diffLinks(serverLinks, want, "npc", "npc-x");
  assert(toAdd.length === 1 && toAdd[0].toId === "lore-1", "diff adds only the genuinely-new edge");
  assert(toRemove.length === 1 && toRemove[0] === "link-A", "diff removes the dropped edge by its server id");
  ok("diffLinks: add new, remove dropped-by-id, keep unchanged");

  // ---- O4 EXPORT: dm_only strip (Player Vault) ---------------------------
  // Thoren (npc-0001) is player-visible but carries dm_only facets → its note has a %% dm_only %%
  // fence. The player export must keep the note (+ links) but drop the fence and sync bookkeeping.
  const thorenNote = canonToNote(thoren, "2026-07-01T12:00:00Z");
  const playerThorenNote = stripNoteForPlayers(thorenNote);
  if (playerThorenNote === null) throw new Error("expected Thoren to survive the player export");
  assert(!playerThorenNote.includes("%% dm_only %%"), "player export strips the dm_only fence");
  assert(!playerThorenNote.includes("[!secret]"), "player export strips secret callouts");
  assert(playerThorenNote.includes("[[The Vault]]"), "player export keeps navigable wikilinks");
  assert(!playerThorenNote.includes("taverntop_hash"), "player export drops sync bookkeeping");
  ok("export strip: player note keeps links, drops dm_only fence + bookkeeping");

  const dmOnlyEntity = canon.find((e) => e.visibility === "dm_only");
  if (!dmOnlyEntity) throw new Error("expected at least one dm_only fixture entity");
  assert(stripNoteForPlayers(canonToNote(dmOnlyEntity, "2026-07-01T12:00:00Z")) === null, "dm_only entity dropped");
  ok("export strip: dm_only entity dropped entirely from the player export");

  // ---- versioned hash: cheap stored-hash compare, migrates instead of flooding --------
  // Conflict detection hashes the note ONCE and compares to its stored stamp (fast). The stamp is
  // versioned, so a hash-algo change compares as "unknown" → migrate, not a false conflict (the
  // flood we hit). Same content across sync stamps must hash identically (timestamps excluded).
  const fpOf = (n: string) => {
    const p = parseNote(n);
    return hashNote(p.frontmatter, p.body);
  };
  const stampA = fpOf(canonToNote(thoren, "2026-07-01T00:00:00Z"));
  const stampB = fpOf(canonToNote(thoren, "2026-09-09T09:09:09Z"));
  assert(compareHash(stampA, stampB) === "unchanged", "unedited note across harvests → unchanged (no false conflict)");
  assert(compareHash(hashNote({ name: "T" }, "body one"), hashNote({ name: "T" }, "body two")) === "edited", "changed content → edited");
  assert(compareHash("deadbeef", stampA) === "unknown", "bare/old-version stamp → unknown (migrate, no flood)");
  assert(compareHash(undefined, stampA) === "unknown", "missing stamp → unknown");
  ok("versioned hash: unchanged / edited / unknown-migrate — cheap compare, no hash-migration flood");

  console.log("\nAll smoke assertions passed.");
}

run().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err);
  process.exit(1);
});
