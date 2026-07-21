/**
 * Orchestrates push + pull between the Canon Engine and the vault, implementing the
 * "detect + sidecar" conflict stance confirmed for v0:
 *
 *  PULL  (app → vault): app is the default winner. If the local note was edited
 *        since last sync (live hash ≠ stamped hash) AND the server copy also moved,
 *        we do NOT overwrite silently — we write the incoming version and drop the
 *        prior local content into a `<name>.conflict.md` sidecar for the DM to merge.
 *
 *  PUSH  (vault → app): vault is the default winner. We send the note back with the
 *        `updatedUtc` it was synced from; if the server's copy is newer it returns a
 *        conflict, and we write the server version into a sidecar instead of clobbering.
 *
 * Both directions never destroy data without leaving a trace.
 */
import { App, Notice, TFile, normalizePath } from "obsidian";
import { AdventurePlanSummary, CanonApiClient } from "../api/CanonApiClient";
import { CanonEntity, CanonEntityType } from "../model/canon";
import { parseNote } from "../vault/frontmatter";
import { compareHash, hashNote, hashText } from "../vault/noteHash";
import {
  ADVENTURES_FOLDER,
  PLUGIN_STATE_FOLDER,
  SESSIONS_FOLDER,
  adventurePlanNotePath,
  canonNotePath,
  canonToNote,
  noteToCanon,
} from "../vault/VaultMapper";
import { stripNoteForPlayers } from "../export/playerExport";

const CANON_TYPES: CanonEntityType[] = ["npc", "location", "thread", "hook", "lore", "rumor", "faction"];

/** Where `Export Player Vault` writes its dm_only-stripped projection (under the vault root). */
export const PLAYER_EXPORT_FOLDER = "_export/PlayerVault";

export interface SyncSummary {
  pulledCanon: number;
  pulledAdventures: number;
  pulledSessions: number;
  pushed: number; // existing canon updated
  created: number; // vault-authored canon created in the app
  linksAdded: number;
  linksRemoved: number;
  skipped: number; // writes this client can't do yet (e.g. create against the live server)
  conflicts: number;
  errors: string[];
}

export interface ExportSummary {
  exported: number;
  droppedDmOnly: number;
  errors: string[];
}

export class SyncEngine {
  constructor(
    private readonly app: App,
    private readonly api: CanonApiClient,
    private readonly vaultRoot: string,
    private readonly campaignId: string | null
  ) {}

  private syncStamp(): string {
    // Real deployments stamp wall-clock; kept isolated so it is trivial to control in tests.
    return new Date().toISOString();
  }

  // ---- PULL ---------------------------------------------------------------

  async pullAll(): Promise<SyncSummary> {
    const summary = blankSummary();
    const stamp = this.syncStamp();

    try {
      const canon = await this.api.listCanon({ types: CANON_TYPES, campaignId: this.campaignId });
      for (const entity of canon) {
        await this.pullOne(entity, stamp, summary);
      }
      summary.pulledCanon = canon.length;

      // Adventures = the DM's OWN prep plans → one folder per adventure, the server's canonical
      // markdown written verbatim (the prose round-trip's vault side). Sessions are not synced
      // (a session is a calendar event, not something you author in Obsidian).
      const plans = (await this.api.listMyAdventurePlans()).filter(
        (p) => !this.campaignId || p.campaignId === this.campaignId
      );
      for (const p of plans) await this.pullAdventurePlan(p, summary);
      summary.pulledAdventures = plans.length;
    } catch (err) {
      summary.errors.push(`pull failed: ${String(err)}`);
    }

    return summary;
  }

  private async pullOne(entity: CanonEntity, stamp: string, summary: SyncSummary): Promise<void> {
    const path = canonNotePath(this.vaultRoot, entity.type, entity.name);
    const existing = this.app.vault.getAbstractFileByPath(path);

    const incoming = canonToNote(entity, stamp);

    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      const parsed = parseNote(current);
      const stored = typeof parsed.frontmatter.taverntop_hash === "string" ? parsed.frontmatter.taverntop_hash : undefined;
      // Cheap + correct: hash the local note ONCE, compare to its stored stamp. Sidecar only on a
      // genuine local edit (same hash version, content differs). A stamp from an older hash version
      // → "unknown" → we migrate silently (the overwrite below re-stamps), never flooding on a
      // hash-algo change. This does NOT false-conflict on server-side-only changes (the stamp is the
      // last-synced baseline, not the incoming copy).
      if (compareHash(stored, hashNote(parsed.frontmatter, parsed.body)) === "edited") {
        await this.writeSidecar(path, current, "local-edits-overwritten-by-pull", summary);
        summary.conflicts++;
      }
    }

    await this.writeNote(path, incoming, summary);
  }

  // ---- PUSH ---------------------------------------------------------------

  /** Push every locally-edited canon note back to the app. */
  async pushAll(): Promise<SyncSummary> {
    const summary = blankSummary();
    for (const file of this.canonFiles()) {
      await this.pushFile(file, summary);
    }
    return summary;
  }

  /** Push a single canon note — the right-click / per-note "Publish this note" action. */
  async pushOne(file: TFile): Promise<SyncSummary> {
    const summary = blankSummary();
    await this.pushFile(file, summary);
    return summary;
  }

  /** Push one file back to the app, folding the outcome into `summary`. An untouched note no-ops. */
  private async pushFile(file: TFile, summary: SyncSummary): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const parsed = parseNote(content);
      const parsedBack = noteToCanon(content);
      if (!parsedBack) return;

      const isNew = !parsedBack.entity.id; // vault-authored, no taverntop_id yet → create
      const stored = typeof parsed.frontmatter.taverntop_hash === "string" ? parsed.frontmatter.taverntop_hash : undefined;
      // Skip only when provably untouched (same hash version + identical hash). "edited" pushes;
      // "unknown" (older hash version) also pushes — never silently drop an edit, and a redundant
      // push is a harmless no-op under vault-wins.
      if (!isNew && compareHash(stored, parsedBack.liveHash) === "unchanged") return;

      const result = await this.api.upsertCanon(parsedBack.entity, {
        expectedUpdatedUtc: isNew ? null : parsedBack.entity.updatedUtc || null,
      });

      if (result.status === "ok") {
        // Re-stamp the note with what landed so hashes reconcile; for a create this also
        // writes the new taverntop_id, so the next Publish updates instead of re-creating.
        await this.app.vault.modify(file, canonToNote(result.entity, this.syncStamp()));
        if (result.created) summary.created++;
        else summary.pushed++;
        summary.linksAdded += result.linksAdded;
        summary.linksRemoved += result.linksRemoved;
      } else if (result.status === "conflict") {
        await this.writeSidecar(
          file.path,
          canonToNote(result.serverEntity, this.syncStamp()),
          "server-newer-than-your-push",
          summary
        );
        summary.conflicts++;
      } else if (result.status === "unsupported") {
        // Not an error — a write this client can't do yet (create against the live server).
        // Leave the note untouched; it'll be retried on the next Publish once enabled.
        summary.skipped++;
        console.info(`[Taverntop Sync] skipped ${file.path}: ${result.message}`);
      } else {
        summary.errors.push(`${file.path}: ${result.message}`);
      }
    } catch (err) {
      summary.errors.push(`${file.path}: ${String(err)}`);
    }
  }

  // ---- ADVENTURE PLANS (the prose round-trip: folder-per-adventure) -------

  /** Harvest one plan: fetch the server's export.md and write it verbatim to
   *  `Adventures/<Title>/<Title>.md`. If a local copy exists and differs, the old text is preserved
   *  in a `.conflict.md` sidecar before overwriting (app-wins, never destructive). */
  private async pullAdventurePlan(p: AdventurePlanSummary, summary: SyncSummary): Promise<void> {
    const md = await this.api.getAdventurePlanMarkdown(p.id);
    if (md === null) {
      summary.errors.push(`adventure "${p.title}": export failed`);
      return;
    }
    const path = adventurePlanNotePath(this.vaultRoot, p.title || "Adventure");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      // Sidecar ONLY on a genuine LOCAL edit (the note's stamped hash vs its current content hash).
      // A pure server/format change → stored matches current → NOT "edited" → silent overwrite, no
      // conflict. An un-stamped/old note → "unknown" → silent migrate. This is the canon stance —
      // it's what stops a Harvest flooding the vault with .conflict files after any server change.
      if (compareHash(extractAdvHash(current), hashText(stripAdvBookkeeping(current))) === "edited") {
        await this.writeSidecar(path, current, "adventure-edited-locally-overwritten-by-harvest", summary);
        summary.conflicts++;
      }
    }
    await this.writeNote(path, stampAdvHash(md), summary);
  }

  /** Publish one adventure note back to the app (POST import/apply — file-wins). On success the note
   *  is refreshed to the server's canonical form so the next Harvest sees no spurious diff. */
  async publishAdventurePlan(file: TFile): Promise<{ ok: boolean; message?: string }> {
    const content = await this.app.vault.read(file);
    const id = extractPlanId(content);
    if (!id) return { ok: false, message: "no tt-plan-id in the note — is this a Taverntop adventure?" };
    const res = await this.api.applyAdventurePlanMarkdown(id, content);
    if (res.ok) {
      const fresh = await this.api.getAdventurePlanMarkdown(id);
      if (fresh !== null) await this.app.vault.modify(file, stampAdvHash(fresh));
    }
    return res;
  }

  /** Deep-link target ("Open in Obsidian"): ensure the adventure note exists locally (create it from
   *  export.md if missing — never clobber a local copy), return its path for the caller to open. */
  async ensureAdventurePlanNote(id: string): Promise<{ path: string } | { error: string }> {
    const md = await this.api.getAdventurePlanMarkdown(id);
    if (md === null) return { error: "adventure not found (or you're not signed in)" };
    const path = adventurePlanNotePath(this.vaultRoot, extractTitle(md) ?? "Adventure");
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
      const summary = blankSummary();
      await this.writeNote(path, stampAdvHash(md), summary);
      if (summary.errors.length) return { error: summary.errors[0] };
    }
    return { path };
  }

  // ---- EXPORT (O4 — player-safe projection) -------------------------------

  /**
   * Export the harvested canon as a player-safe Obsidian folder under
   * `<root>/PLAYER_EXPORT_FOLDER`: drops dm_only entities and strips the `%% dm_only %%` fences,
   * keeping `[[wikilinks]]` navigable. A one-way projection — never synced back. (The Brew /
   * Homebrewery renderer rides the same strip as a fast-follow.)
   */
  async exportPlayerVault(): Promise<ExportSummary> {
    const summary: ExportSummary = { exported: 0, droppedDmOnly: 0, errors: [] };
    const vaultPrefix = this.vaultRoot ? `${this.vaultRoot}/` : "";
    const outRoot = normalizePath(`${this.vaultRoot}/${PLAYER_EXPORT_FOLDER}`);

    for (const file of this.canonFiles()) {
      try {
        const content = await this.app.vault.read(file);
        const stripped = stripNoteForPlayers(content);
        if (stripped === null) {
          summary.droppedDmOnly++;
          continue;
        }
        const rel = file.path.startsWith(vaultPrefix) ? file.path.slice(vaultPrefix.length) : file.path;
        const outPath = normalizePath(`${outRoot}/${rel}`);
        await this.ensureFolder(outPath);
        const existing = this.app.vault.getAbstractFileByPath(outPath);
        if (existing instanceof TFile) await this.app.vault.modify(existing, stripped);
        else await this.app.vault.create(outPath, stripped);
        summary.exported++;
      } catch (err) {
        summary.errors.push(`${file.path}: ${String(err)}`);
      }
    }
    return summary;
  }

  private canonFiles(): TFile[] {
    const prefix = normalizePath(`${this.vaultRoot}/Canon`);
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix + "/") && !f.path.endsWith(".conflict.md"));
  }

  /** Delete the plugin's `.conflict.md` sidecars under the managed folders (recoverable — to trash). */
  async clearConflictSidecars(): Promise<number> {
    const roots = SyncEngine.managedFolders(this.vaultRoot).map((r) => normalizePath(r) + "/");
    let cleared = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.endsWith(".conflict.md")) continue;
      if (!roots.some((r) => file.path.startsWith(r))) continue;
      await this.app.fileManager.trashFile(file);
      cleared++;
    }
    return cleared;
  }

  // ---- vault write helpers ------------------------------------------------

  private async writeNote(path: string, content: string, summary: SyncSummary): Promise<void> {
    try {
      await this.ensureFolder(path);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(path, content);
      }
    } catch (err) {
      summary.errors.push(`write ${path}: ${String(err)}`);
    }
  }

  private async writeSidecar(
    originalPath: string,
    content: string,
    reason: string,
    summary: SyncSummary
  ): Promise<void> {
    const sidecar = originalPath.replace(/\.md$/, `.conflict.md`);
    const banner = `> [!warning] Sync conflict — ${reason}\n> Reconcile this against the live note, then delete this file.\n\n`;
    await this.writeNote(sidecar, banner + content, summary);
    new Notice(`Taverntop: sync conflict → ${sidecar}`);
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (!dir) return;
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {
        /* folder may have been created concurrently — ignore */
      });
    }
  }

  /** Folders the plugin owns, surfaced for the settings UI. */
  static managedFolders(root: string): string[] {
    return [
      `${root}/Canon`,
      `${root}/${ADVENTURES_FOLDER}`,
      `${root}/${SESSIONS_FOLDER}`,
      `${root}/${PLUGIN_STATE_FOLDER}`,
    ];
  }
}

function blankSummary(): SyncSummary {
  return {
    pulledCanon: 0,
    pulledAdventures: 0,
    pulledSessions: 0,
    pushed: 0,
    created: 0,
    linksAdded: 0,
    linksRemoved: 0,
    skipped: 0,
    conflicts: 0,
    errors: [],
  };
}

/** The adventure plan id from an export.md's `tt-plan-id:` frontmatter line (the Publish key). */
function extractPlanId(md: string): string | null {
  const m = md.match(/^tt-plan-id:\s*([0-9a-fA-F-]+)\s*$/m);
  return m ? m[1] : null;
}

/** The plan title from the note's first `# ` heading (for the folder/file name on open). */
function extractTitle(md: string): string | null {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

// ---- adventure-note change detection (verbatim server md + a hash stamp) ----
// We keep the note as the server's export.md verbatim, plus one bookkeeping frontmatter line
// (taverntop_hash) so re-Harvest can distinguish a local edit from a server change without parsing
// the nested tt-canon / tt-mon frontmatter.

/** The note's content minus bookkeeping lines — the thing we hash. */
function stripAdvBookkeeping(md: string): string {
  return md
    .split("\n")
    .filter((l) => !/^\s*taverntop_(hash|synced_utc)\s*:/.test(l))
    .join("\n")
    .trim();
}

/** The stamped hash from a note's frontmatter, if any. */
function extractAdvHash(md: string): string | undefined {
  const m = md.match(/^\s*taverntop_hash\s*:\s*(\S+)\s*$/m);
  return m ? m[1] : undefined;
}

/** Stamp `taverntop_hash` as the first frontmatter key (harmless to the server — not a tt-* key). */
function stampAdvHash(md: string): string {
  const clean = md.replace(/^\s*taverntop_hash\s*:.*\n?/m, "");
  const hash = hashText(stripAdvBookkeeping(clean));
  return /^---\s*\n/.test(clean)
    ? clean.replace(/^---\s*\n/, `---\ntaverntop_hash: ${hash}\n`)
    : `---\ntaverntop_hash: ${hash}\n---\n\n${clean}`;
}
