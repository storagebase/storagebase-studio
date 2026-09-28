import type { ServerHeldSecrets } from "@/lib/user-connections/use-server-held-secrets";

/**
 * A `ServerHeldSecrets` for component tests that mock the connection form hooks: nothing saved,
 * nothing cleared, and no storage mode yet, so the credential notice renders nothing.
 */
export function serverHeldSecretsStub(overrides: Partial<ServerHeldSecrets> = {}): ServerHeldSecrets {
  return {
    mode: null,
    holdOnServer: false,
    isSaved: () => false,
    isCleared: () => false,
    toggleCleared: () => {},
    probe: (_connection, inline) => inline(),
    persist: async (connection) => connection,
    ...overrides,
  };
}
