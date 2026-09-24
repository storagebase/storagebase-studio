import { mockGlobalFetch, type MockFetchResponse } from "../../../helpers/mock-fetch";
import type { ResourceConnection } from "@/lib/resources/types";

/**
 * A routed fake of the vault workbench's server side for component tests:
 * /api/resources/meta (the flags), /api/resources/vault/* and the admin
 * exclusion API. Answers on exact routes (`mockGlobalFetch` matches by
 * substring, which cannot tell `deleted` from `deleted/purge`).
 */

export const connection: ResourceConnection = {
  id: "res-v",
  name: "vault",
  type: "azure-key-vault",
  createdAt: "2026-01-01T00:00:00.000Z",
  vaultName: "example",
};

export const ALL_FLAGS = [
  "vault.secrets",
  "vault.keys",
  "vault.certificates",
  "vault.secret.reveal",
  "vault.secret.write",
  "vault.secret.metadata",
  "vault.key.write",
  "vault.certificate.write",
  "vault.delete",
  "vault.soft-delete",
];

export type Handler = (body: Record<string, unknown>, method: string) => MockFetchResponse;

function summary(type: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    name,
    enabled: true,
    createdOn: "2026-01-01T00:00:00.000Z",
    updatedOn: "2026-01-02T00:00:00.000Z",
    expiresOn: null,
    notBefore: null,
    tags: {},
    contentType: null,
    keyType: null,
    keySize: null,
    curve: null,
    subject: null,
    issuer: null,
    thumbprint: null,
    ...extra,
  };
}

export const LISTINGS: Record<string, unknown[]> = {
  secret: [
    summary("secret", "db-password", {
      contentType: "text/plain",
      tags: { team: "platform" },
      expiresOn: "2027-01-01T00:00:00.000Z",
    }),
    summary("secret", "api-token", { enabled: false }),
    summary("secret", "legacy", { enabled: null }),
  ],
  key: [
    summary("key", "signing", { keyType: "RSA", keySize: 2048 }),
    summary("key", "ec-key", { keyType: "EC", curve: "P-256" }),
  ],
  certificate: [
    summary("certificate", "site-cert", { subject: "CN=example.test", issuer: "Self", thumbprint: "AB01" }),
  ],
};

export const defaultHandlers: Record<string, Handler> = {
  meta: () => ({ json: { category: "vault", capabilities: { operations: ALL_FLAGS }, labels: {} } }),
  objects: (body) => ({ json: { objects: LISTINGS[body.type as string], truncated: false } }),
  object: (body) => ({
    json: {
      ...((LISTINGS[body.type as string] as Array<{ name: string }>).find((entry) => entry.name === body.name) ??
        summary(body.type as string, body.name as string)),
      version: "v2",
      recoveryLevel: "Recoverable",
      keyOperations: body.type === "key" ? ["sign", "verify"] : [],
      versions: [
        { version: "v2", enabled: true, createdOn: "2026-02-01T00:00:00.000Z", updatedOn: null, expiresOn: null },
        {
          version: "v1",
          enabled: false,
          createdOn: "2026-01-01T00:00:00.000Z",
          updatedOn: null,
          expiresOn: "2026-06-01T00:00:00.000Z",
        },
      ],
      versionsTruncated: false,
    },
  }),
  "secret/reveal": (body) => ({ json: { name: body.name, value: "revealed-value", version: "v2" } }),
  "secret/save": () => ({ json: { saved: true } }),
  "key/create": () => ({ json: { created: true } }),
  "certificate/import": () => ({ json: { imported: true } }),
  "object/delete": () => ({ json: { deleted: true } }),
  deleted: () => ({
    json: {
      deleted: [
        {
          type: "secret",
          name: "old-secret",
          deletedOn: "2026-09-01T00:00:00.000Z",
          scheduledPurgeDate: "2026-12-01T00:00:00.000Z",
        },
      ],
    },
  }),
  "deleted/recover": () => ({ json: { recovered: true } }),
  "deleted/purge": () => ({ json: { purged: true } }),
  exclusions: () => ({ json: { rules: [{ pattern: "hidden-*", kind: "glob", objectType: "any", note: "" }] } }),
  "exclusions/preview": () => ({ json: { counts: { secret: { total: 3, hidden: 1 } } } }),
};

export interface VaultCall {
  route: string;
  method: string;
  body: Record<string, unknown>;
  url: string;
}

export function installVaultServer(overrides: Record<string, Handler> = {}) {
  const calls: VaultCall[] = [];
  const handlers = { ...defaultHandlers, ...overrides };
  mockGlobalFetch({
    "api/resources/": async (req) => {
      const url = new URL(req.url);
      const route = url.pathname
        .replace(/^.*\/api\/resources\/admin\/vault-/, "")
        .replace(/^.*\/api\/resources\/vault\//, "")
        .replace(/^.*\/api\/resources\//, "");
      const body = req.method === "GET" ? {} : ((await req.json()) as Record<string, unknown>);
      calls.push({ route, method: req.method, body, url: url.toString() });
      const handler = handlers[route];
      return handler ? handler(body, req.method) : { status: 404, json: { error: `no route ${route}` } };
    },
  });
  return {
    calls,
    last(route: string) {
      return calls.filter((entry) => entry.route === route).at(-1);
    },
    count(route: string) {
      return calls.filter((entry) => entry.route === route).length;
    },
  };
}

export const refuse =
  (status: number, error: string): Handler =>
  () => ({ status, json: { error } });
