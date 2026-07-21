import { Editor, MarkdownFileInfo, MarkdownView, Menu, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { CanonApiClient } from "./api/CanonApiClient";
import { HttpCanonApiClient } from "./api/HttpCanonApiClient";
import { MockCanonApiClient } from "./api/MockCanonApiClient";
import { PLAYER_EXPORT_FOLDER, SyncEngine, SyncSummary } from "./sync/SyncEngine";
import { ADVENTURES_FOLDER } from "./vault/VaultMapper";
import { DEFAULT_SETTINGS, TaverntopSyncSettingTab, TaverntopSyncSettings } from "./settings";
import { createPkce, randomUrlSafe } from "./auth/pkce";
import { OAuthConfig, buildAuthorizeUrl, exchangeCode, refreshTokens } from "./auth/oauth";

/** The custom-protocol redirect the `taverntop.obsidian` IdentityServer client is registered with. */
const REDIRECT_URI = "obsidian://taverntop-sync/callback";
/** The Obsidian protocol action (everything after `obsidian://`) — must equal REDIRECT_URI's path. */
const PROTOCOL_ACTION = "taverntop-sync/callback";
/** App → Obsidian handoff: `obsidian://taverntop-sync/adventure?id=<planId>` (the "Open in Obsidian" button). */
const PROTOCOL_ACTION_ADVENTURE = "taverntop-sync/adventure";
/** Refresh the access token this many seconds before it actually expires. */
const TOKEN_REFRESH_SKEW_SEC = 60;
/**
 * Fixed OAuth contract values — the registered public client + the scopes it's allowed.
 * These are NOT user settings, so a stale `data.json` can never override them (an earlier
 * scaffold persisted `taverntop-obsidian` + `canon.read/write`, which broke the first UAT).
 */
const OAUTH_CLIENT_ID = "taverntop.obsidian";
const OAUTH_SCOPE = "openid profile email offline_access campaign";

export default class TaverntopSyncPlugin extends Plugin {
  settings!: TaverntopSyncSettings;

  /** In-flight sign-in (PKCE verifier + CSRF state); held only between authorize and callback. */
  private pendingAuth: { verifier: string; state: string } | null = null;
  /** Cached access token — memory only, NEVER persisted. */
  private accessToken: { value: string; expiresAt: number } | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new TaverntopSyncSettingTab(this.app, this));

    // OAuth redirect capture: IdentityServer sends the browser back to
    // obsidian://taverntop-sync/callback?code=…&state=… → this handler.
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void this.handleAuthCallback(params as Record<string, string>);
    });

    // App → Obsidian handoff: obsidian://taverntop-sync/adventure?id=… → pull that plan + open it.
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION_ADVENTURE, (params) => {
      void this.openAdventurePlan((params as Record<string, string>).id);
    });

    this.addRibbonIcon("swords", "Taverntop: Harvest Canon", () => this.runPull());
    this.addRibbonIcon("upload-cloud", "Taverntop: Publish changed canon", () => this.runPush());

    // Per-note publish: right-click a canon note (in the editor or the file list) → push just it.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, _editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const file = info.file;
        if (file instanceof TFile && this.isCanonNote(file)) {
          menu.addItem((item) =>
            item.setTitle("Publish this note to Canon").setIcon("upload-cloud").onClick(() => this.publishFile(file))
          );
        }
        if (file instanceof TFile && this.isAdventureNote(file)) {
          menu.addItem((item) =>
            item.setTitle("Publish adventure to Taverntop").setIcon("upload-cloud").onClick(() => this.publishAdventureFile(file))
          );
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (file instanceof TFile && this.isCanonNote(file)) {
          menu.addItem((item) =>
            item.setTitle("Publish to Canon").setIcon("upload-cloud").onClick(() => this.publishFile(file))
          );
        }
        if (file instanceof TFile && this.isAdventureNote(file)) {
          menu.addItem((item) =>
            item.setTitle("Publish adventure to Taverntop").setIcon("upload-cloud").onClick(() => this.publishAdventureFile(file))
          );
        }
      })
    );

    this.addCommand({
      id: "taverntop-harvest",
      name: "Harvest Canon (canon, adventures & sessions → vault)",
      callback: () => this.runPull(),
    });
    this.addCommand({
      id: "taverntop-publish",
      name: "Publish to Canon (locally-edited canon notes → app)",
      callback: () => this.runPush(),
    });
    this.addCommand({
      id: "taverntop-publish-adventure",
      name: "Publish adventure to Taverntop (active note → app)",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const ok = file instanceof TFile && this.isAdventureNote(file);
        if (ok && !checking) void this.publishAdventureFile(file as TFile);
        return ok;
      },
    });
    this.addCommand({
      id: "taverntop-export-player-vault",
      name: "Export Player Vault (strip dm_only → shareable folder)",
      callback: () => this.runExportPlayerVault(),
    });
    this.addCommand({
      id: "taverntop-clear-conflicts",
      name: "Clear conflict sidecars (delete *.conflict.md)",
      callback: () => this.runClearConflicts(),
    });
    this.addCommand({
      id: "taverntop-sign-in",
      name: "Sign in to Taverntop (OAuth)",
      callback: () => this.startSignIn(),
    });
    this.addCommand({
      id: "taverntop-test-connection",
      name: "Test connection",
      callback: () => this.testConnection(),
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- API client ---------------------------------------------------------

  /** Build the API client for the current settings — the one place mock vs http is chosen. */
  private buildClient(): CanonApiClient {
    if (this.settings.clientMode === "mock") {
      return new MockCanonApiClient(this.settings.dmMode);
    }
    return new HttpCanonApiClient(this.settings.apiBaseUrl, () => this.resolveToken());
  }

  private buildEngine(): SyncEngine {
    return new SyncEngine(
      this.app,
      this.buildClient(),
      this.settings.vaultRoot,
      this.settings.campaignId || null
    );
  }

  // ---- auth (Authorization Code + PKCE) -----------------------------------

  private oauthConfig(): OAuthConfig {
    const o = this.settings.oauth;
    return {
      authorizeUrl: o.authorizeUrl,
      tokenUrl: o.tokenUrl,
      clientId: OAUTH_CLIENT_ID, // fixed contract value — ignore any stale settings.oauth.clientId
      redirectUri: REDIRECT_URI,
      scope: OAUTH_SCOPE,        // fixed — the client is registered for exactly these scopes
    };
  }

  /** True once a refresh token is stored — used by the settings UI to show signed-in state. */
  isSignedIn(): boolean {
    return this.settings.authMode === "oauth" && !!this.settings.oauth.refreshToken;
  }

  /** Kick off sign-in: open the system browser to IdentityServer's authorize endpoint. */
  async startSignIn(): Promise<void> {
    try {
      const pkce = await createPkce();
      const state = randomUrlSafe(16);
      this.pendingAuth = { verifier: pkce.verifier, state };
      window.open(buildAuthorizeUrl(this.oauthConfig(), pkce.challenge, state));
      new Notice("Taverntop: opening your browser to sign in…");
    } catch (err) {
      new Notice(`Taverntop: sign-in could not start — ${String(err)}`);
    }
  }

  /** obsidian://taverntop-sync/callback handler: validate state, exchange the code for tokens. */
  private async handleAuthCallback(params: Record<string, string>): Promise<void> {
    const pending = this.pendingAuth;
    this.pendingAuth = null;

    if (params.error) {
      new Notice(`Taverntop: sign-in denied — ${params.error_description ?? params.error}`);
      return;
    }
    if (!pending || !params.code || params.state !== pending.state) {
      // A missing/mismatched state means this callback isn't the one we started (CSRF guard).
      new Notice("Taverntop: sign-in response didn't match this request — please try again.");
      return;
    }
    try {
      const tokens = await exchangeCode(this.oauthConfig(), params.code, pending.verifier);
      this.cacheAccessToken(tokens.accessToken, tokens.expiresInSec);
      if (tokens.refreshToken) {
        this.settings.oauth.refreshToken = tokens.refreshToken;
        await this.saveSettings();
      }
      new Notice("Taverntop: signed in ✓");
    } catch (err) {
      new Notice(`Taverntop: sign-in failed — ${String(err)}`);
    }
  }

  async signOut(): Promise<void> {
    this.accessToken = null;
    this.settings.oauth.refreshToken = "";
    await this.saveSettings();
    new Notice("Taverntop: signed out.");
  }

  private cacheAccessToken(value: string, expiresInSec: number): void {
    this.accessToken = { value, expiresAt: Date.now() + expiresInSec * 1000 };
  }

  /**
   * Resolve a bearer token for HTTP requests. Token mode → the pasted token. OAuth mode →
   * a cached access token while valid, else a refresh-token exchange (rotating the stored
   * refresh token, since the client is OneTimeOnly). The refresh token lives only in plugin
   * data, never in a note. Callers only ever await a string | null, so this is the single seam.
   */
  private async resolveToken(): Promise<string | null> {
    if (this.settings.authMode === "token") {
      return this.settings.bearerToken || null;
    }

    if (this.accessToken && this.accessToken.expiresAt - TOKEN_REFRESH_SKEW_SEC * 1000 > Date.now()) {
      return this.accessToken.value;
    }

    const refresh = this.settings.oauth.refreshToken;
    if (!refresh) return null; // not signed in

    try {
      const tokens = await refreshTokens(this.oauthConfig(), refresh);
      this.cacheAccessToken(tokens.accessToken, tokens.expiresInSec);
      if (tokens.refreshToken && tokens.refreshToken !== refresh) {
        this.settings.oauth.refreshToken = tokens.refreshToken;
        await this.saveSettings();
      }
      return tokens.accessToken;
    } catch (err) {
      // Refresh failed (expired/revoked/rotated-away) → force a fresh sign-in.
      this.accessToken = null;
      this.settings.oauth.refreshToken = "";
      await this.saveSettings();
      new Notice(`Taverntop: session expired — please sign in again. (${String(err)})`);
      return null;
    }
  }

  // ---- commands -----------------------------------------------------------

  async testConnection(): Promise<void> {
    const res = await this.buildClient().ping();
    new Notice(
      res.ok
        ? `Taverntop: connected${res.tenantId ? ` (tenant ${res.tenantId})` : ""}${res.message ? ` — ${res.message}` : ""}`
        : `Taverntop: connection failed — ${res.message ?? "unknown error"}`
    );
  }

  async runPull(): Promise<void> {
    new Notice("Taverntop: harvesting…");
    const summary = await this.buildEngine().pullAll();
    this.reportSummary("Harvest", summary);
  }

  async runPush(): Promise<void> {
    new Notice("Taverntop: publishing…");
    const summary = await this.buildEngine().pushAll();
    this.reportSummary("Publish", summary);
  }

  /** Export a player-safe projection of canon (dm_only stripped) into a folder under the vault root. */
  async runExportPlayerVault(): Promise<void> {
    new Notice("Taverntop: exporting player vault…");
    const summary = await this.buildEngine().exportPlayerVault();
    const bits = [
      summary.exported ? `${summary.exported} notes` : "",
      summary.droppedDmOnly ? `${summary.droppedDmOnly} dm_only dropped` : "",
    ].filter(Boolean);
    new Notice(
      `Taverntop Player Vault: ${bits.length ? bits.join(", ") : "nothing to export"} → ${this.settings.vaultRoot}/${PLAYER_EXPORT_FOLDER}`
    );
    if (summary.errors.length) {
      console.error("[Taverntop Sync] export errors:", summary.errors);
      new Notice(`Taverntop export: ${summary.errors.length} error(s) — see console`);
    }
  }

  /** Delete the plugin's .conflict.md sidecars (recovers from the one-time hash-algo re-stamp flood). */
  async runClearConflicts(): Promise<void> {
    const n = await this.buildEngine().clearConflictSidecars();
    new Notice(n ? `Taverntop: cleared ${n} conflict sidecar${n === 1 ? "" : "s"}.` : "Taverntop: no conflict sidecars found.");
  }

  /** Publish a single canon note — the per-note right-click action. Fires immediately (no modal). */
  async publishFile(file: TFile): Promise<void> {
    new Notice(`Taverntop: publishing ${file.basename}…`);
    const summary = await this.buildEngine().pushOne(file);
    this.reportSummary("Publish", summary);
  }

  /** Publish a single adventure note back to the app (the per-note right-click / command action). */
  async publishAdventureFile(file: TFile): Promise<void> {
    new Notice(`Taverntop: publishing ${file.basename}…`);
    const res = await this.buildEngine().publishAdventurePlan(file);
    new Notice(res.ok ? `Taverntop: published ${file.basename} ✓` : `Taverntop: publish failed — ${res.message ?? "unknown error"}`);
  }

  /** "Open in Obsidian" deep-link target: pull the adventure (if not already local) + open its note. */
  async openAdventurePlan(id: string | undefined): Promise<void> {
    if (!id) {
      new Notice("Taverntop: no adventure id in the link.");
      return;
    }
    new Notice("Taverntop: opening adventure…");
    const res = await this.buildEngine().ensureAdventurePlanNote(id);
    if ("error" in res) {
      new Notice(`Taverntop: ${res.error}`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(res.path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice(`Taverntop: wrote ${res.path} but couldn't open it.`);
  }

  /** True for a markdown note under the plugin's `<vaultRoot>/Canon` tree (gates the right-click item). */
  private isCanonNote(file: TFile): boolean {
    if (file.extension !== "md") return false;
    const prefix = normalizePath(`${this.settings.vaultRoot}/Canon`) + "/";
    return file.path.startsWith(prefix);
  }

  /** True for a markdown note under the plugin's `<vaultRoot>/Adventures` tree (an adventure plan note). */
  private isAdventureNote(file: TFile): boolean {
    if (file.extension !== "md" || file.path.endsWith(".conflict.md")) return false;
    const prefix = normalizePath(`${this.settings.vaultRoot}/${ADVENTURES_FOLDER}`) + "/";
    return file.path.startsWith(prefix);
  }

  private reportSummary(label: string, s: SyncSummary): void {
    const bits = [
      s.pulledCanon ? `${s.pulledCanon} canon` : "",
      s.pulledAdventures ? `${s.pulledAdventures} adventures` : "",
      s.pulledSessions ? `${s.pulledSessions} sessions` : "",
      s.pushed ? `${s.pushed} updated` : "",
      s.created ? `${s.created} created` : "",
      s.linksAdded || s.linksRemoved ? `${s.linksAdded}+/${s.linksRemoved}− links` : "",
      s.conflicts ? `${s.conflicts} conflicts` : "",
      s.skipped ? `${s.skipped} skipped` : "",
    ].filter(Boolean);
    const msg = bits.length ? bits.join(", ") : "nothing to do";
    new Notice(`Taverntop ${label}: ${msg}`);
    if (s.errors.length) {
      console.error("[Taverntop Sync] errors:", s.errors);
      new Notice(`Taverntop ${label}: ${s.errors.length} error(s) — see console`);
    }
  }
}
