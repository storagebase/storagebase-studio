import * as client from "openid-client";
import { SignJWT, jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/config/auth-env";
import type { EntraConfig } from "./config";

/**
 * The Entra side of the OIDC engine (StorageBase fork). The Authorization Code + PKCE exchange is
 * the upstream engine's own (`generateAuthUrl`, `exchangeCode` in src/lib/oidc.ts); two pieces are
 * the adapter's because the upstream ones cannot be shared without editing them:
 *
 * - DISCOVERY: `discoverProvider` in src/lib/oidc.ts keeps ONE cached configuration per process,
 *   whatever issuer asked, so a deployment with generic OIDC and Entra both configured would be
 *   handed one provider's endpoints for the other. This cache is keyed by issuer and client.
 * - STATE: the upstream state cookie carries the three PKCE values only. Entra's also carries
 *   where the flow returns to and whether it is an administrator's "test sign-in", which must never
 *   create a session.
 */

const DISCOVERY_TTL_MS = 5 * 60 * 1000;

let cached: { key: string; configuration: client.Configuration; expiresAt: number } | null = null;

export function resetEntraDiscoveryCache(): void {
  cached = null;
}

export async function discoverEntra(config: EntraConfig): Promise<client.Configuration> {
  const key = `${config.issuer}\u0000${config.clientId}`;
  const now = Date.now();
  if (cached && cached.key === key && now < cached.expiresAt) return cached.configuration;
  const configuration = await client.discovery(
    new URL(config.issuer),
    config.clientId,
    config.clientSecret,
    client.ClientSecretPost(config.clientSecret),
  );
  cached = { key, configuration, expiresAt: now + DISCOVERY_TTL_MS };
  return configuration;
}

export const ENTRA_STATE_COOKIE = "entra-state";

export interface EntraFlowState {
  code_verifier: string;
  state: string;
  nonce: string;
  /** The redirect URI the authorization request named; the token request must name the same one. */
  redirectUri: string;
  /** `test`: an administrator checking the configuration — the claims are recorded, no session is made. */
  mode: "login" | "test";
  /** Who started a test sign-in. */
  actor?: string;
}

// Hoisted single-line message, the upstream state secret's rule: no dev fallback for flow state.
const ENTRA_STATE_SECRET_MISSING_MESSAGE = "JWT_SECRET is required for Entra sign-in state";

function stateSecret(): Uint8Array {
  return getJwtSecret({ allowDevFallback: false, missingMessage: ENTRA_STATE_SECRET_MISSING_MESSAGE });
}

export async function sealEntraState(state: EntraFlowState): Promise<string> {
  return await new SignJWT({ ...state })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(stateSecret());
}

export async function openEntraState(token: string): Promise<EntraFlowState> {
  const { payload } = await jwtVerify(token, stateSecret());
  return {
    code_verifier: String(payload.code_verifier),
    state: String(payload.state),
    nonce: String(payload.nonce),
    redirectUri: String(payload.redirectUri),
    mode: payload.mode === "test" ? "test" : "login",
    ...(typeof payload.actor === "string" ? { actor: payload.actor } : {}),
  };
}
