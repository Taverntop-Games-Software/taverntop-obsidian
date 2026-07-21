/**
 * OAuth 2.0 Authorization Code + PKCE against IdentityServer (Duende), for the public
 * native client `taverntop.obsidian`. Pure functions over Obsidian's `requestUrl`
 * (CORS/mobile-safe) — no client secret (public client). The orchestration (opening the
 * browser, holding the pending verifier/state, caching + refreshing the access token,
 * persisting the refresh token) lives in main.ts; this module is just the wire calls.
 */
import { requestUrl } from "obsidian";

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export interface TokenSet {
  accessToken: string;
  /** Rotated on every refresh (client is RefreshTokenUsage.OneTimeOnly) — persist the new one. */
  refreshToken: string | null;
  expiresInSec: number;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, challenge: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // Force interactive login every connect. This is deliberate (auth-flow-review, TW-2/TW-3):
    // it prevents silent re-auth from skipping Login.cshtml → RouteByMembershipAsync → the guild
    // picker. A multi-membership DM MUST pass the picker so `selected_tenant_id` is set and the
    // issued token carries `tenant_id` (ADR-0008 fail-closed) — else every CampaignApiAccess call 403s.
    prompt: "login",
  });
  return `${cfg.authorizeUrl}?${qs.toString()}`;
}

/** Exchange the authorization code + PKCE verifier for tokens. */
export function exchangeCode(cfg: OAuthConfig, code: string, verifier: string): Promise<TokenSet> {
  return tokenRequest(cfg.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
}

/** Redeem a refresh token for a fresh access token (+ a rotated refresh token). */
export function refreshTokens(cfg: OAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(cfg.tokenUrl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    scope: cfg.scope,
  });
}

async function tokenRequest(url: string, form: Record<string, string>): Promise<TokenSet> {
  const res = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) {
    const detail = res.json?.error_description ?? res.json?.error ?? `HTTP ${res.status}`;
    throw new Error(String(detail));
  }
  const j = res.json ?? {};
  if (!j.access_token) throw new Error("token endpoint returned no access_token");
  return {
    accessToken: j.access_token as string,
    refreshToken: (j.refresh_token as string) ?? null,
    expiresInSec: (j.expires_in as number) ?? 3600,
  };
}
