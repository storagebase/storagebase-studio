import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseDocument, YAMLError } from "yaml";
import { logger } from "@/lib/logger";
import { authProvider } from "@/lib/config/auth-provider";
import { rolesMatch } from "@/lib/seed/connection-filter";
import {
  resolveConnectionCredentials,
  resolveVaultCredentials,
  seedValuesAreLiteral,
} from "@/lib/seed/credential-resolver";
import { seedRolesOf } from "@/lib/seed/roles";
import type { SeedConnection } from "@/lib/seed/types";
import { resourceConnectionRow } from "./sealing";
import {
  RESOURCE_TYPES,
  type ResourceConnection,
  type ResourceConnectionRow,
  type ResourcePermission,
  type ResourceType,
} from "./types";
import { RESOURCE_CONNECTION_FIELD_NAMES } from "./ui-config";

/**
 * The fork's preconfigured resource connections (D3: config-only — this file
 * replaces the legacy admin-managed connection store).
 *
 * `STORAGEBASE_RESOURCE_SEED_PATH` points at a YAML file in the same shape as
 * upstream's seed config (one `connections:` list, entries validated by a
 * fork-owned zod schema — upstream's seed schemas are never extended, P3).
 * See docs/storagebase/resources/README.md for the full format and a complete
 * example.
 *
 * `${ENV}` and `${vault:…}` values are resolved by CALLING upstream's resolver
 * functions (`resolveConnectionCredentials`, `resolveVaultCredentials` —
 * imported, never reimplemented, P4/P5). Upstream's resolvers iterate their
 * own fixed field list, so each fork field value rides through them under the
 * carrier below — a name upstream's list knows and never warns about — and the
 * fork field name never crosses into upstream code. The split mirrors
 * upstream's own: `${ENV}` references resolve eagerly at load (cheap, no
 * network), `${vault:…}` references only when a connection the caller's roles
 * match is OPENED, so listing connections never reads a secret.
 *
 * `roles:` is matched against the session with upstream's `seedRolesOf` and
 * `rolesMatch` (imported): standard roles (`*`, `admin`, `user`) plus OIDC
 * claim roles under OIDC_ROLE_PREFIX. A non-matching entry is not listed and
 * resolves as a 404 exactly like an id that does not exist, so a non-member
 * learns nothing.
 *
 * A broken ENTRY is skipped with a warning naming the id — the file serves
 * every other entry, and one bad row never takes the resource routes down (the
 * upstream operator loader's ruling). A broken FILE (unreadable, unparsable,
 * invalid, or carrying a custom role the sign-in mode can never match) serves
 * nothing and logs the path, because the entries after the broken one cannot
 * be trusted to be the ones the operator meant. A missing file is a zero-config
 * install, not an error.
 */

export const DEFAULT_STORAGEBASE_RESOURCE_SEED_PATH = "/app/config/storagebase-resources.yaml";

const ROUTE = "storagebase/resources/seed";

/** `STORAGEBASE_RESOURCE_SEED_PATH` when non-empty, else the default path. */
export function resourceSeedPath(): string {
  return process.env.STORAGEBASE_RESOURCE_SEED_PATH || DEFAULT_STORAGEBASE_RESOURCE_SEED_PATH;
}

/** The class the role schema refuses, same as upstream's seed roles (src/lib/seed/types.ts). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what a role name may not hold
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f-\x9f]/;

const AllowedSeedRoleSchema = z
  .string()
  .min(1, "Role cannot be empty")
  .max(64, "Role name must not exceed 64 characters")
  .refine((role) => Buffer.byteLength(role, "utf8") <= 64, "Role name must not exceed 64 bytes in UTF-8")
  .refine((role) => role.trim() === role, "Role name cannot have leading or trailing whitespace")
  .refine((role) => !CONTROL_CHAR_REGEX.test(role), "Role name cannot contain control characters");

const SeedFieldsSchema = z
  .record(z.string(), z.string())
  .refine(
    (fields) =>
      Object.keys(fields).every((key) => (RESOURCE_CONNECTION_FIELD_NAMES as readonly string[]).includes(key)),
    { message: `fields keys must be resource connection field names: ${RESOURCE_CONNECTION_FIELD_NAMES.join(", ")}` },
  );

const SeedEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1).max(128),
  type: z.enum(RESOURCE_TYPES as [ResourceType, ...ResourceType[]]),
  roles: z.array(AllowedSeedRoleSchema).min(1, "At least one role is required"),
  permission: z.enum(["read", "write", "admin"]).optional(),
  group: z.string().max(64).optional(),
  environment: z.enum(["production", "staging", "development", "local", "other"]).optional(),
  fields: SeedFieldsSchema.optional(),
});

const ResourceSeedConfigSchema = z.object({
  connections: z.array(SeedEntrySchema),
});

type SeedFileEntry = z.infer<typeof SeedEntrySchema>;

/** One entry as the file declares it, `${ENV}` references resolved, `${vault:…}` left for the open path. */
export interface ResourceSeedEntry {
  readonly id: string;
  readonly name: string;
  readonly type: ResourceType;
  readonly roles: readonly string[];
  readonly permission: ResourcePermission;
  readonly group?: string;
  readonly environment?: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * Where the failure text never goes: into a message. A parser's error quotes
 * the line it failed on, and in a seed file that line can hold a plaintext
 * token — every message below names the file and the position only.
 */
function seedParseFailure(error: unknown): string {
  if (error instanceof YAMLError) {
    const at = error.linePos?.[0];
    return at ? `${error.code} at line ${at.line}, column ${at.col}` : error.code;
  }
  return "the file is not valid YAML";
}

/**
 * The upstream resolvers iterate `RESOLVABLE_FIELDS`, a fixed list of database
 * connection names; a fork field name (`token`, `clientSecret`, `endpoint`)
 * is not on it. So each value rides through them under `host` — a name the
 * list knows, and one upstream never logs a plaintext warning for (its warned
 * fields are `password` and `agentPassword`). The carrier satisfies the
 * resolver's required shape only; nothing connects through it.
 */
function carrierFor(entryId: string, value: string): SeedConnection {
  return { id: entryId, name: entryId, type: "postgres", roles: ["*"], host: value } as SeedConnection;
}

/** One fork field value through upstream's env resolver, under the carrier. */
function resolveSeedEnvValue(entryId: string, value: string): string {
  return resolveConnectionCredentials(carrierFor(entryId, value)).host ?? value;
}

/** One fork field value through upstream's vault resolver, under the carrier. */
async function resolveSeedVaultValue(entryId: string, value: string): Promise<string> {
  return (await resolveVaultCredentials(carrierFor(entryId, value))).host ?? value;
}

/** One entry's fields, every `${ENV}` reference resolved at load time. */
function resolveEntryEnvFields(entryId: string, fields: Readonly<Record<string, string>>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    resolved[key] = seedValuesAreLiteral() ? value : resolveSeedEnvValue(entryId, value);
  }
  return resolved;
}

function entryOf(entry: SeedFileEntry): ResourceSeedEntry {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    roles: entry.roles,
    permission: entry.permission ?? "read",
    ...(entry.group !== undefined ? { group: entry.group } : {}),
    ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
    fields: resolveEntryEnvFields(entry.id, entry.fields ?? {}),
  };
}

/** Paths already reported missing: a deployment that ships no file reads it again on every load, so the warning logs once per path. */
const missingPathsLogged = new Set<string>();

/** Test seam: re-arms the once-per-path "not found" log. */
export function resetResourceSeedState(): void {
  missingPathsLogged.clear();
}

/** The zod issues as one sentence, path-joined the way upstream's seed loader joins them. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
}

/**
 * Every entry the file declares, `${ENV}` references resolved, broken entries
 * skipped with a warning naming the id. Never throws: a seed file is operator
 * config, and the routes serve the entries that parse rather than failing on
 * the ones that do not.
 */
export async function loadResourceSeedEntries(): Promise<ResourceSeedEntry[]> {
  const path = resourceSeedPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.error(`Cannot read the resource seed config at ${path}`, error, { route: ROUTE, code });
      return [];
    }
    if (!missingPathsLogged.has(path)) {
      missingPathsLogged.add(path);
      logger.warn("Resource seed file not found, preconfigured resource connections disabled", {
        route: ROUTE,
        path,
      });
    }
    return [];
  }
  missingPathsLogged.delete(path);

  let parsed: unknown;
  try {
    const document = parseDocument(raw, { logLevel: "error" });
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem !== undefined) throw problem;
    parsed = document.toJS();
  } catch (error) {
    logger.error(`Failed to parse the resource seed config at ${path}`, error, {
      route: ROUTE,
      detail: seedParseFailure(error),
    });
    return [];
  }

  const result = ResourceSeedConfigSchema.safeParse(parsed);
  if (!result.success) {
    logger.error(`Invalid resource seed config at ${path}`, result.error, {
      route: ROUTE,
      detail: describeIssues(result.error),
    });
    return [];
  }
  const refusal = refuseInvalidCustomRoles(result.data.connections, path);
  if (refusal !== null) {
    logger.error(refusal, { route: ROUTE });
    return [];
  }

  const entries: ResourceSeedEntry[] = [];
  for (const fileEntry of result.data.connections) {
    try {
      entries.push(entryOf(fileEntry));
    } catch (error) {
      // One unresolved \${ENV} reference skips its own entry (upstream's
      // operator loader drops the connection the same way): the variable is
      // named in the error, the value never is.
      logger.warn(`Skipping resource seed connection "${fileEntry.id}": ${(error as Error).message}`, { route: ROUTE });
    }
  }
  return entries;
}

/**
 * The custom-role rule upstream's seed loader enforces (config-text.ts), so a
 * fork seed role behaves exactly like an upstream seed role: a role beyond
 * `*`/`admin`/`user` requires the OIDC sign-in mode and the claim-role prefix,
 * and must start with it — otherwise it can never match and the operator
 * should hear that at load, not wonder why the entry is invisible. Non-null
 * return is the refusal sentence; the whole file is refused (an upstream seed
 * file is too, by its loader throwing).
 */
function refuseInvalidCustomRoles(connections: readonly SeedFileEntry[], origin: string): string | null {
  const isOidc = authProvider() === "oidc";
  const prefix = process.env.OIDC_ROLE_PREFIX;
  for (const entry of connections) {
    for (const role of entry.roles) {
      if (role === "*" || role === "admin" || role === "user") continue;
      if (!isOidc || !prefix) {
        return `Invalid resource seed config at ${origin}: connection "${entry.id}" declares custom role "${role}", which requires NEXT_PUBLIC_AUTH_PROVIDER="oidc" and OIDC_ROLE_PREFIX to be set`;
      }
      if (!role.startsWith(prefix)) {
        return `Invalid resource seed config at ${origin}: connection "${entry.id}" declares role "${role}", which does not start with OIDC_ROLE_PREFIX "${prefix}"`;
      }
    }
  }
  return null;
}

/** Whether this session's roles select this entry, through upstream's own matcher and combiner. */
export function seedEntryMatches(
  session: { role: string; claimRoles?: readonly string[] | unknown },
  entry: ResourceSeedEntry,
): boolean {
  return rolesMatch([...entry.roles], seedRolesOf(session));
}

/** A seed entry as the connection a request runs against: id `seed:<id>`, fields spread, no marker (the caller sets it). */
function connectionOfEntry(entry: ResourceSeedEntry, createdAt: string): ResourceConnection {
  return {
    id: `seed:${entry.id}`,
    name: entry.name,
    type: entry.type,
    createdAt,
    ...(entry.group !== undefined ? { group: entry.group } : {}),
    ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
    ...entry.fields,
  };
}

/**
 * The seeded rows a session's list shows: role-matched entries as
 * `ResourceConnectionRow`s — non-secret fields only, `seeded: true`, the
 * permission the roles grant, and a `hasCredential` marker that counts an
 * unresolved `${vault:…}` reference as the credential it resolves into. The
 * value itself never rides.
 */
export async function seededResourceRows(
  session: { role: string; claimRoles?: readonly string[] | unknown },
  now: () => Date = () => new Date(),
): Promise<ResourceConnectionRow[]> {
  const entries = await loadResourceSeedEntries();
  const rows: ResourceConnectionRow[] = [];
  for (const entry of entries) {
    if (!seedEntryMatches(session, entry)) continue;
    rows.push(resourceConnectionRow(connectionOfEntry(entry, now().toISOString()), { permission: entry.permission }));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The seeded connection a request opens, resolved for this session only:
 * role-matched (a miss answers null and the route's 404 says the same thing an
 * unknown id would), then every `${vault:…}` reference in its fields read by
 * upstream's resolver — one connection, after the access decision, never on
 * the list path. `SEED_LITERAL_VALUES` leaves the file's values as written,
 * the upstream ruling for files a platform writes from user-controlled data.
 */
export async function openSeededResourceConnection(
  session: { role: string; claimRoles?: readonly string[] | unknown },
  seedId: string,
): Promise<{ connection: ResourceConnection; permission: ResourcePermission } | null> {
  const entries = await loadResourceSeedEntries();
  const entry = entries.find((candidate) => candidate.id === seedId);
  if (entry === undefined || !seedEntryMatches(session, entry)) return null;

  const opened = connectionOfEntry(entry, new Date().toISOString());
  if (!seedValuesAreLiteral()) {
    // The zod schema already refused a fields key that is not a connection
    // field name, so this record view only lets the loop write what the file
    // was allowed to declare.
    const target = opened as unknown as Record<string, string>;
    for (const [field, value] of Object.entries(entry.fields)) {
      if (value.startsWith("${vault:")) target[field] = await resolveSeedVaultValue(entry.id, value);
    }
  }
  return { connection: opened, permission: entry.permission };
}
