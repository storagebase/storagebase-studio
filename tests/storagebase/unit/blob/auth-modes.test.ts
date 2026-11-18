import { describe, test, expect } from "bun:test";
import { ResourceConfigError } from "@/storagebase/resources/errors";
import type { AzureBlobConnection } from "@/storagebase/resources/providers/blob/azure-blob";

/**
 * The azure-blob auth-mode resolution, unit-level and SDK-free: the mode
 * matrix is a pure function of the connection record
 * (`resolveAzureBlobAuthMode`) plus the SAS URL parser
 * (`parseAzureBlobSasUrl`), so every arm is testable without loading an SDK
 * or opening a socket. The integration test covers what these decisions DO
 * once handed to the SDKs; this file pins which decision is made.
 *
 * Sealed-field discipline is pinned here too: `accountKey`, `connectionString`
 * and `sasUrl` are credentials (the fork store seals the first two; `sasUrl`
 * joins them with this phase — see the report note), so no refusal sentence
 * may echo one — an operator reading a 400 must not learn the token.
 */

const { AZURE_BLOB_AUTH_MODES, AzureBlobProvider, parseAzureBlobSasUrl, resolveAzureBlobAuthMode } = await import(
  "@/storagebase/resources/providers/blob/azure-blob"
);

const base: AzureBlobConnection = {
  id: "res-auth",
  name: "auth",
  type: "azure-blob",
  createdAt: "2026-01-01T00:00:00.000Z",
  endpoint: "https://myaccount.blob.core.windows.net",
};

const entraTriple = { tenantId: "tenant", clientId: "client", clientSecret: "secret" };

describe("resolveAzureBlobAuthMode", () => {
  test("explicit authMode wins, and every mode's required fields are validated", () => {
    expect(resolveAzureBlobAuthMode({ ...base, accountKey: "k", authMode: "account-key" })).toMatchObject({
      mode: "account-key",
      accountKey: "k",
    });
    expect(
      resolveAzureBlobAuthMode({
        ...base,
        connectionString: "AccountEndpoint=https://x;AccountKey=y",
        authMode: "connection-string",
      }),
    ).toMatchObject({ mode: "connection-string", connectionString: "AccountEndpoint=https://x;AccountKey=y" });
    expect(
      resolveAzureBlobAuthMode({
        ...base,
        sasUrl: "https://myaccount.blob.core.windows.net/?sig=t",
        authMode: "sas-url",
      }),
    ).toMatchObject({ mode: "sas-url" });
    expect(resolveAzureBlobAuthMode({ ...base, ...entraTriple, authMode: "client-secret" })).toMatchObject({
      mode: "client-secret",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
    });
    expect(resolveAzureBlobAuthMode({ ...base, authMode: "managed-identity" })).toEqual({
      mode: "managed-identity",
      clientId: null,
      sas: null,
    });
    expect(resolveAzureBlobAuthMode({ ...base, clientId: "identity", authMode: "managed-identity" })).toEqual({
      mode: "managed-identity",
      clientId: "identity",
      sas: null,
    });
    expect(resolveAzureBlobAuthMode({ ...base, ...entraTriple, authMode: "workload-identity" })).toEqual({
      mode: "workload-identity",
      tenantId: "tenant",
      clientId: "client",
      sas: null,
    });
  });

  test("an explicit authMode whose fields are missing is refused", () => {
    expect(() => resolveAzureBlobAuthMode({ ...base, authMode: "account-key" })).toThrow(ResourceConfigError);
    expect(() => resolveAzureBlobAuthMode({ ...base, authMode: "connection-string" })).toThrow(ResourceConfigError);
    expect(() => resolveAzureBlobAuthMode({ ...base, authMode: "sas-url" })).toThrow(ResourceConfigError);
    expect(() =>
      resolveAzureBlobAuthMode({ ...base, ...entraTriple, clientSecret: undefined, authMode: "client-secret" }),
    ).toThrow(ResourceConfigError);
    expect(() =>
      resolveAzureBlobAuthMode({ ...base, ...entraTriple, clientId: undefined, authMode: "client-secret" }),
    ).toThrow(ResourceConfigError);
    expect(() =>
      resolveAzureBlobAuthMode({ ...base, ...entraTriple, tenantId: undefined, authMode: "client-secret" }),
    ).toThrow(ResourceConfigError);
  });

  test("an unknown authMode is refused with the valid list, never echoed", () => {
    let message = "";
    try {
      resolveAzureBlobAuthMode({ ...base, authMode: "magic" as AzureBlobConnection["authMode"] });
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toContain('Unknown "authMode"');
    for (const mode of AZURE_BLOB_AUTH_MODES) {
      expect(message).toContain(mode);
    }
    expect(message).not.toContain("magic");
  });

  test("implicit precedence: accountKey > connectionString > sasUrl > client secret > workload identity", () => {
    const all: AzureBlobConnection = {
      ...base,
      ...entraTriple,
      accountKey: "key",
      connectionString: "AccountEndpoint=https://x;AccountKey=y",
      sasUrl: "https://myaccount.blob.core.windows.net/?sig=t",
    };
    expect(resolveAzureBlobAuthMode(all).mode).toBe("account-key");
    expect(resolveAzureBlobAuthMode({ ...all, accountKey: undefined }).mode).toBe("connection-string");
    expect(resolveAzureBlobAuthMode({ ...all, accountKey: undefined, connectionString: undefined }).mode).toBe(
      "sas-url",
    );
    expect(
      resolveAzureBlobAuthMode({ ...all, accountKey: undefined, connectionString: undefined, sasUrl: undefined }).mode,
    ).toBe("client-secret");
    expect(
      resolveAzureBlobAuthMode({
        ...all,
        accountKey: undefined,
        connectionString: undefined,
        sasUrl: undefined,
        clientSecret: undefined,
      }),
    ).toEqual({ mode: "workload-identity", tenantId: "tenant", clientId: "client", sas: null });
  });

  test("no credential at all resolves to workload identity, the in-cluster default", () => {
    expect(resolveAzureBlobAuthMode(base)).toEqual({
      mode: "workload-identity",
      tenantId: null,
      clientId: null,
      sas: null,
    });
  });

  test("tenant and client without a secret read as workload-identity hints, not a broken client-secret", () => {
    expect(resolveAzureBlobAuthMode({ ...base, tenantId: "tenant", clientId: "client" })).toEqual({
      mode: "workload-identity",
      tenantId: "tenant",
      clientId: "client",
      sas: null,
    });
  });
});

describe("validate: the addressing each mode needs", () => {
  test("the account-endpoint modes refuse a record with no endpoint or vaultName", () => {
    expect(() => new AzureBlobProvider({ ...base, endpoint: undefined, accountKey: "k" })).toThrow(ResourceConfigError);
    expect(() => new AzureBlobProvider({ ...base, endpoint: undefined, ...entraTriple })).toThrow(ResourceConfigError);
    expect(() => new AzureBlobProvider({ ...base, endpoint: undefined, authMode: "managed-identity" })).toThrow(
      ResourceConfigError,
    );
    expect(() => new AzureBlobProvider({ ...base, endpoint: undefined, authMode: "workload-identity" })).toThrow(
      ResourceConfigError,
    );
  });

  test("the self-addressed modes carry their own account and need neither", () => {
    expect(
      () =>
        new AzureBlobProvider({
          id: "res-cs",
          name: "cs",
          type: "azure-blob",
          createdAt: "2026-01-01T00:00:00.000Z",
          connectionString: "AccountEndpoint=https://x;AccountKey=y",
        }),
    ).not.toThrow();
    expect(
      () =>
        new AzureBlobProvider({
          id: "res-sas",
          name: "sas",
          type: "azure-blob",
          createdAt: "2026-01-01T00:00:00.000Z",
          sasUrl: "https://myaccount.blob.core.windows.net/data?sig=t",
        }),
    ).not.toThrow();
  });
});

describe("parseAzureBlobSasUrl", () => {
  test("account, container, blob and Azurite spellings resolve their scope", () => {
    expect(parseAzureBlobSasUrl("https://myaccount.blob.core.windows.net/?sig=t")).toEqual({
      accountUrl: "https://myaccount.blob.core.windows.net/?sig=t",
      container: null,
    });
    expect(parseAzureBlobSasUrl("https://myaccount.blob.core.windows.net?sig=t")).toEqual({
      accountUrl: "https://myaccount.blob.core.windows.net?sig=t",
      container: null,
    });
    expect(parseAzureBlobSasUrl("https://myaccount.blob.core.windows.net/data?sig=t")).toEqual({
      accountUrl: "https://myaccount.blob.core.windows.net/?sig=t",
      container: "data",
    });
    expect(parseAzureBlobSasUrl("https://myaccount.blob.core.windows.net/data/report.parquet?sig=t")).toEqual({
      accountUrl: "https://myaccount.blob.core.windows.net/?sig=t",
      container: "data",
    });
    expect(parseAzureBlobSasUrl("http://127.0.0.1:10000/devstoreaccount1/fixture?sig=t")).toEqual({
      accountUrl: "http://127.0.0.1:10000/devstoreaccount1/?sig=t",
      container: "fixture",
    });
    expect(parseAzureBlobSasUrl("http://127.0.0.1:10000/devstoreaccount1?sig=t")).toEqual({
      accountUrl: "http://127.0.0.1:10000/devstoreaccount1?sig=t",
      container: null,
    });
  });

  test("every refusal names the rule, never the URL", () => {
    const refusals = [
      "not a url",
      "ftp://myaccount.blob.core.windows.net/?sig=token",
      "https://myaccount.blob.core.windows.net/",
      "https://myaccount.blob.core.windows.net/data",
    ];
    for (const sasUrl of refusals) {
      let message = "";
      try {
        parseAzureBlobSasUrl(sasUrl);
      } catch (caught) {
        message = (caught as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(sasUrl);
      expect(message).not.toContain("sig=token");
    }
  });
});
