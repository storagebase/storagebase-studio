# Plan: Microsoft Entra ID integration — switchable SSO and resource groups bound to app roles

Status: **plan for the next agent — do not implement until the owner confirms resource testing is done.**
Companion plan: [`VAULT_AND_REDIS_PARITY.md`](VAULT_AND_REDIS_PARITY.md).

## 1. Goals
1. **Entra ID as a first-class integration**, separate from the generic OIDC mode: a dedicated config
   block, a "Sign in with Microsoft" button, Entra-specific claim handling, and docs.
2. **A switch**: Entra SSO can be turned on/off at runtime (no rebuild), with local login kept as a
   break-glass path that the admin can also restrict.
3. **Resource groups**: every managed connection (databases *and* resources — Key Vault, blob, queues,
   Kafka, Redis, …) belongs to one or more *resource groups*. An admin binds groups to **Entra app
   roles** with a permission level. **No group/role ids are hardcoded** anywhere: bindings are data,
   edited in the admin UI, stored server-side.

## 2. What exists today (verify before building)
- `NEXT_PUBLIC_AUTH_PROVIDER=local|oidc` — **build-time** (`NEXT_PUBLIC_`), so it cannot be the
  runtime switch. OIDC flow: `src/lib/oidc.ts`, routes under `src/app/api/auth/oidc/*`, Authorization
  Code + PKCE, issues the same JWT cookie as local login (`src/lib/auth.ts`).
- Role mapping: `OIDC_ROLE_CLAIM` (e.g. `roles`) + `OIDC_ADMIN_ROLES` → only `admin | user`
  (`docs/OIDC.md` → "Role Mapping"). The JWT payload is `{ role, username }` (`src/lib/auth.ts:21-24`);
  **the user's app roles are discarded after login**.
- RBAC middleware: `src/proxy.ts` (admin vs user only).
- Seed connections (`docs/SEED_CONNECTIONS.md`, `src/lib/seed/*`): server-side, `${ENV}` credential
  resolution, `seed:` ids, a `roles: [...]` visibility list — the closest existing thing to managed,
  group-scoped connections. Resource connections have no seed/managed form yet ("M6" note in
  `src/lib/api/resource-route.ts`).
- Storage is **per user** (`StorageProvider.getCollection(userId, …)`, `src/lib/storage/types.ts:80-86`);
  there is no global/admin-owned collection yet.
- Client IP resolution with proxy trust: `src/lib/api/client-address.ts`.

## 3. Design

### 3.1 Why app roles, not group claims
Use **Entra app roles** (`roles` claim) as the only authorization input:
- The `groups` claim hits the overage limit (~200 groups in a JWT) and then needs Microsoft Graph with
  `GroupMember.Read.All` — extra permissions and a runtime dependency. App roles never overflow.
- App-role **values** are human-readable strings the tenant admin defines (e.g. `StorageBase.Admin`,
  `Team.Payments.Read`, `Team.Payments.Write`). Entra groups are assigned to app roles in the Enterprise
  Application — so group membership still drives access, but Studio never sees or stores a group GUID.
- Studio stores only role **values** in its bindings. Nothing about the tenant is in code or chart
  defaults.

### 3.2 Configuration (runtime, server-side, `STORAGEBASE_` prefix per STORAGEBASE.md)
| Variable | Purpose |
| :--- | :--- |
| `STORAGEBASE_ENTRA_ENABLED` | `true`/`false` — initial state of the switch (admin can override in UI, see 3.3) |
| `STORAGEBASE_ENTRA_TENANT_ID` | Tenant id; issuer derived as `https://login.microsoftonline.com/<tenant>/v2.0` |
| `STORAGEBASE_ENTRA_CLIENT_ID` / `STORAGEBASE_ENTRA_CLIENT_SECRET` | App registration (secret via k8s Secret; later: certificate or workload identity federation) |
| `STORAGEBASE_ENTRA_ADMIN_ROLES` | App-role values that grant Studio `admin` (default `StorageBase.Admin`) |
| `STORAGEBASE_ENTRA_ALLOWED_ROLES` | Optional: if set, a user with none of these roles is refused at login (tenant-wide sign-in gate) |
| `STORAGEBASE_LOCAL_LOGIN` | `enabled` \| `admin-only` \| `disabled` — break-glass policy for email/password login while Entra is on |

The generic `OIDC_*` mode keeps working unchanged (upstream behaviour). Entra mode reuses the OIDC
engine in `src/lib/oidc.ts` through a fork-owned adapter (`src/lib/entra/**`) rather than editing it;
if a hook is unavoidable, keep it one additive line and record it as a fork exception.

### 3.3 The switch
- A server-side "auth settings" record (new **global** storage collection, see 3.5) holds
  `{ entraEnabled, localLogin }`; env vars seed the initial value, the admin UI changes it, every
  change is audited (`auth_settings_changed`, actor, before/after, IP).
- The login page asks `GET /api/auth/providers` (public, fork-owned) which buttons to render, instead of
  reading the build-time `NEXT_PUBLIC_AUTH_PROVIDER`.
- Safety rails: the switch cannot disable local login while Entra is off; turning Entra off while
  `localLogin=disabled` forces `localLogin=admin-only`; the admin UI shows a "test Entra sign-in" button
  that runs the flow in a popup-free redirect and reports the claims it received (roles, oid, tid,
  upn) before the switch can be saved as on.
- `src/proxy.ts` public-route list gains only `/api/auth/providers` and the Entra callback (if it is a
  separate path) — the proxy is the authority for public routes.

### 3.4 Session contents
Extend the JWT payload additively: `{ role, username, provider: "local"|"entra"|"oidc", appRoles?: string[], oid?, tid? }`
- `appRoles` = the `roles` claim values, bounded (e.g. max 64 values × 128 chars), captured at login.
- Session lifetime for Entra sessions: configurable (default 8h), shorter than local if desired;
  roles are re-read at every login (no silent refresh in v1).
- Token validation: issuer = the tenant's v2 issuer, `aud` = client id, `tid` = configured tenant
  (reject other tenants even if the app registration is later made multi-tenant).

### 3.5 Resource groups and bindings (data model)
New **global** (not per-user) storage, added to `StorageProvider` for sqlite/postgres behind fork-owned
modules (`src/lib/storage/global/**`), with append-only registration in shared registries only if
unavoidable:

```
resource_group      { id, name, description, createdAt, createdBy }
managed_connection  { id, kind: "database"|"resource", type, name, config (encrypted secrets),
                      groupIds[], visibilityPolicy?, createdAt, createdBy, updatedAt, updatedBy }
role_binding        { id, appRoleValue, groupId, permission: "read"|"write"|"admin", createdBy }
auth_settings       { entraEnabled, localLogin, updatedAt, updatedBy }
```

Permission semantics (checked **server-side** on every route that takes a managed connection id):
- `read` — list/browse/peek, reveal secrets (reveal is still audited), run read-only commands/queries.
- `write` — plus create/update/delete objects, publish/produce, soft-delete, recover.
- `admin` — plus purge, admin-only Redis commands, destructive Kafka ops (delete topic/group, reset
  offsets), editing the managed connection itself.
- Studio `admin` role (from `STORAGEBASE_ENTRA_ADMIN_ROLES`) manages groups, bindings, managed
  connections and the auth switch; it does **not** implicitly get data access unless also bound
  (optional flag `adminBypass`, default off — decide with the owner).
- Effective permission = max over all bindings whose `appRoleValue` ∈ session `appRoles` and whose
  group is in the connection's `groupIds`.

### 3.6 Managed connections and credential flow
- Today the browser sends the full connection (with secrets) inline on every request. For managed
  connections the browser sends **only the id** (`managed:<id>`, parallel to `seed:`); the server loads
  the config, checks permission, decrypts, and runs. Credentials never reach the browser; the UI gets a
  redacted view.
- Seed connections from Helm keep working; their `roles: [...]` list is interpreted as app-role values
  when Entra is on (document the migration).
- Destination policy (SSRF) from `VAULT_AND_REDIS_PARITY.md` applies to managed connections on save and on
  connect.

### 3.7 Admin UI (new tab in `src/components/admin/**`, fork-owned sub-components)
- **Resource groups**: CRUD; list member connections.
- **Role bindings**: table of `app role value → group → permission`; free-text role value with
  suggestions from roles seen in recent logins (never fetched from Graph in v1); validation against
  empty/whitespace; audit every change.
- **Managed connections**: create from the existing connection forms (database + resource), assign
  groups, test connection, visibility policy (Key Vault).
- **Authentication**: the Entra switch, local-login policy, "test sign-in" result, last-changed-by.
- **Access preview**: pick an app-role set → see which connections and permissions it yields (debugging
  aid for admins).

### 3.8 Audit
Every login/logout carries `provider`, `oid`, `appRoles`, IP (XFF when trusted). Every managed-connection
operation carries `groupIds`, effective `permission`, and the binding that granted it.

## 4. Entra tenant setup (to document in `docs/ENTRA.md`)
1. App registration (single tenant), Web redirect `https://<host>/api/auth/oidc/callback` (or the
   Entra-specific callback path), client secret (or certificate).
2. App roles defined in the manifest — examples only, the owner chooses names:
   `StorageBase.Admin`, `Team.<Name>.Read`, `Team.<Name>.Write`, `Team.<Name>.Admin`.
3. Enterprise Application → Users and groups → assign Entra groups to app roles. Enable "Assignment
   required" to block unassigned users.
4. Token configuration: none needed for roles (emitted by default in the id_token when assigned). Do
   **not** add the groups claim.
5. API permissions: `openid profile email` only (no `Directory.Read.All` / `GroupMember.Read.All`).
6. For vault discovery (companion plan P2) a separate identity with `Reader` on the subscriptions and
   Key Vault data-plane roles — prefer workload identity federation on AKS over a client secret.

## 5. Delivery plan for the implementing agent
Order, each step with tests first (100% line coverage gate), docs, and the full gate from `CLAUDE.md`:
1. Global storage layer (sqlite + postgres) + migrations; unit/integration tests.
2. Managed connections (`managed:` ids) with server-side resolution for **resource** routes, then
   database routes via the existing seed resolution seam (smallest possible upstream-territory touch,
   recorded in STORAGEBASE.md).
3. Resource groups + role bindings + permission evaluator (pure module, exhaustive tests).
4. Enforcement in every resource route + the DB routes that accept a connection; tests proving a
   reader cannot write and a non-member gets 404 (not 403, to avoid existence leaks).
5. Entra adapter + `/api/auth/providers` + login page buttons + JWT `appRoles`; tests with a mocked
   issuer (see existing OIDC tests for the pattern).
6. Auth switch + local-login policy + admin UI + audit events.
7. `docs/ENTRA.md`, Helm values (`storagebase.entra.*`, secrets via existing `secrets.existingSecret`
   pattern — follow the chart version-bump rules in `CLAUDE.md`), `.env.example` entries.
8. End-to-end test against a real test tenant (manual checklist in `docs/ENTRA.md`), then enable on
   the demo cluster.

## 6. Open questions for the owner
- Should Studio `admin` bypass resource-group checks (`adminBypass`)?
- Are user-owned (browser) connections still allowed when Entra is on, or only managed ones?
- Session lifetime for Entra sessions (proposal: 8h).
- Multiple tenants ever? (Plan assumes one tenant; the `tid` check enforces it.)
