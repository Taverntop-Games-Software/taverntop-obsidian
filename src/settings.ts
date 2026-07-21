import { App, PluginSettingTab, Setting } from "obsidian";
import type TaverntopSyncPlugin from "./main";

/** How the plugin reaches the Canon Engine. `mock` needs no backend. */
export type ClientMode = "mock" | "http";

/** Auth strategy. v0 ships paste-a-token; OAuth is designed-for, not built. */
export type AuthMode = "token" | "oauth";

export interface TaverntopSyncSettings {
  clientMode: ClientMode;
  apiBaseUrl: string;
  authMode: AuthMode;
  /** v0: pasted bearer token. Stored in the vault's plugin data — treat as a secret. */
  bearerToken: string;
  /** OAuth config (designed for Duende; not exercised in v0). */
  oauth: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scope: string;
    /** Filled by the (future) PKCE device/loopback flow; not hand-edited. */
    refreshToken: string;
  };
  /** Folder within the vault the plugin owns (e.g. "Taverntop"). */
  vaultRoot: string;
  /** Optional campaign filter; empty = all campaigns / guild-universal. */
  campaignId: string;
  /** DM token sees dm_only canon; mock client honors this to simulate authz. */
  dmMode: boolean;
}

export const DEFAULT_SETTINGS: TaverntopSyncSettings = {
  clientMode: "mock",
  apiBaseUrl: "https://app.taverntop.games",
  authMode: "token",
  bearerToken: "",
  oauth: {
    authorizeUrl: "https://id.taverntop.games/connect/authorize",
    tokenUrl: "https://id.taverntop.games/connect/token",
    clientId: "taverntop.obsidian",
    scope: "openid profile email offline_access campaign",
    refreshToken: "",
  },
  vaultRoot: "Taverntop",
  campaignId: "",
  dmMode: true,
};

export class TaverntopSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: TaverntopSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Scope our CSS (styles.css) to this tab so the `.tts-wide` full-width treatment
    // for long URL/token fields never leaks into Obsidian's own settings panes.
    containerEl.addClass("taverntop-sync-settings");
    const s = this.plugin.settings;

    containerEl.createEl("h2", { text: "Taverntop Sync" });

    new Setting(containerEl)
      .setName("Connection mode")
      .setDesc("Mock runs against built-in fixtures with no backend. HTTP talks to the live Canon Engine API.")
      .addDropdown((d) =>
        d
          .addOption("mock", "Mock (fixtures, no backend)")
          .addOption("http", "HTTP (Canon Engine API)")
          .setValue(s.clientMode)
          .onChange(async (v) => {
            s.clientMode = v as ClientMode;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc("Root folder inside this vault the plugin reads/writes (Canon/, Adventures/, Sessions/).")
      .addText((t) =>
        t.setValue(s.vaultRoot).onChange(async (v) => {
          s.vaultRoot = v.trim() || "Taverntop";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Campaign filter")
      .setDesc("Optional campaign id. Leave blank to sync all campaigns + guild-universal canon.")
      .addText((t) =>
        t.setPlaceholder("(all)").setValue(s.campaignId).onChange(async (v) => {
          s.campaignId = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("DM mode")
      .setDesc("On = DM token (sees dm_only canon + secret facets). Off simulates a player token.")
      .addToggle((t) =>
        t.setValue(s.dmMode).onChange(async (v) => {
          s.dmMode = v;
          await this.plugin.saveSettings();
        })
      );

    if (s.clientMode === "http") {
      containerEl.createEl("h3", { text: "API connection" });

      new Setting(containerEl)
        .setName("API base URL")
        .setDesc("Where the Canon Engine API lives. Local dev: your Taverntop server (e.g. https://localhost:7253).")
        .setClass("tts-wide")
        .addText((t) =>
          t.setValue(s.apiBaseUrl).onChange(async (v) => {
            s.apiBaseUrl = v.trim();
            await this.plugin.saveSettings();
          })
        );

      new Setting(containerEl)
        .setName("Auth method")
        .setDesc("Paste a bearer token, or sign in with OAuth (Duende PKCE — the public client taverntop.obsidian).")
        .addDropdown((d) =>
          d
            .addOption("token", "Bearer token (paste)")
            .addOption("oauth", "OAuth / Duende (sign in)")
            .setValue(s.authMode)
            .onChange(async (v) => {
              s.authMode = v as AuthMode;
              await this.plugin.saveSettings();
              this.display();
            })
        );

      if (s.authMode === "token") {
        new Setting(containerEl)
          .setName("Bearer token")
          .setDesc("Paste an access token. Stored in this vault's plugin data — treat it like a password.")
          .setClass("tts-wide")
          .addText((t) => {
            t.setPlaceholder("eyJ...").setValue(s.bearerToken).onChange(async (v) => {
              s.bearerToken = v.trim();
              await this.plugin.saveSettings();
            });
            t.inputEl.type = "password";
          });
      } else {
        new Setting(containerEl)
          .setName("Authorize URL")
          .setDesc("IdentityServer authorize endpoint. Local dev: point at your local Identity Server.")
          .setClass("tts-wide")
          .addText((t) =>
            t.setValue(s.oauth.authorizeUrl).onChange(async (v) => {
              s.oauth.authorizeUrl = v.trim();
              await this.plugin.saveSettings();
            })
          );
        new Setting(containerEl)
          .setName("Token URL")
          .setDesc("IdentityServer token endpoint. Usually the same host as the authorize URL.")
          .setClass("tts-wide")
          .addText((t) =>
            t.setValue(s.oauth.tokenUrl).onChange(async (v) => {
              s.oauth.tokenUrl = v.trim();
              await this.plugin.saveSettings();
            })
          );
        new Setting(containerEl)
          .setName(this.plugin.isSignedIn() ? "Signed in ✓" : "Not signed in")
          .setDesc(
            "Authorization Code + PKCE against IdentityServer (public client taverntop.obsidian). " +
              "The refresh token is stored in this vault's plugin data — never written into a note."
          )
          .addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => this.plugin.startSignIn()))
          .addButton((b) =>
            b.setButtonText("Sign out").onClick(async () => {
              await this.plugin.signOut();
              this.display();
            })
          );
      }

      new Setting(containerEl)
        .setName("Test connection")
        .addButton((b) =>
          b.setButtonText("Ping").onClick(async () => {
            await this.plugin.testConnection();
          })
        );
    }

    containerEl.createEl("h3", { text: "Sync" });
    new Setting(containerEl)
      .setName("Harvest Canon")
      .setDesc("Pull canon + adventures + sessions → vault notes.")
      .addButton((b) => b.setButtonText("Harvest").setCta().onClick(() => this.plugin.runPull()));
    new Setting(containerEl)
      .setName("Publish to Canon")
      .setDesc("Push locally-edited canon notes → app (vault-wins). Or right-click a canon note to publish just it.")
      .addButton((b) => b.setButtonText("Publish").onClick(() => this.plugin.runPush()));
    new Setting(containerEl)
      .setName("Export Player Vault")
      .setDesc("Write a player-safe copy of canon (dm_only entities + secret fences stripped) to _export/PlayerVault/.")
      .addButton((b) => b.setButtonText("Export").onClick(() => this.plugin.runExportPlayerVault()));
  }
}
