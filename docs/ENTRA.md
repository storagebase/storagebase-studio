# Microsoft Entra ID sign-in and connection groups

StorageBase Studio (fork) signs users in with Microsoft Entra ID and decides which **preconfigured
("managed") connections** each of them may use from the **app roles** Entra puts in their token.
This page covers the tenant setup, the server configuration, the access model, the admin screens, the
admin API (for scripted deployments), and troubleshooting.

Nothing about any tenant is built into the product: the tenant id, the client id and every role value
below are yours, configured at runtime. Values on this page such as `StorageBase.Admin` or
`Team.Payments.Read` are examples.

The generic OIDC mode ([`OIDC.md`](OIDC.md), `NEXT_PUBLIC_AUTH_PROVIDER=oidc`) keeps working
unchanged. Entra is a separate integration with its own button, callback and claim checks.

## 1. How it fits together

```
Entra group ──assigned to──▶ app role (e.g. Team.Payments.Read)
                                  │  arrives in the id token `roles` claim
                                  ▼
Studio session { role: admin|user, appRoles: [...] }
                                  │  role binding: app role value → connection group → read|write|admin
                                  ▼
connection group ──contains──▶ managed connections (databases and resources)
```

- **App roles, not group claims.** The `groups` claim overflows at ~200 groups and then needs
  Microsoft Graph permissions; app roles never do. You assign Entra groups to app roles in the
  Enterprise Application, so group membership still drives access, but Studio never sees or stores a
  group id.
- **Studio admins** are users holding any app role listed in `STORAGEBASE_ENTRA_ADMIN_ROLES`
  (default `StorageBase.Admin`). Admins manage groups, bindings, managed connections and the sign-in
  switch, and — by the owner's decision — may **use every managed connection** (admin bypass). Every
  such use is on the audit trail as `granted_by: admin-bypass`.
- **User-owned connections** (the ones a user creates in their browser) work exactly as before.
  Managed connections appear beside them, usable but never viewable: no host, user, address or
  credential reaches the browser, and there is no edit, duplicate or delete.

## 2. Tenant setup

Everything below uses placeholders. Replace `<...>` with your values.

### 2.1 App registration

```bash
# Single tenant web app. Register every URL Studio is reached at (base path included, if any).
az ad app create \
  --display-name "StorageBase Studio" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://<studio-host>/api/auth/entra/callback"

APP_ID=$(az ad app list --display-name "StorageBase Studio" --query "[0].appId" -o tsv)

# Client secret (store it in a Kubernetes Secret, never in values.yaml)
az ad app credential reset --id "$APP_ID" --display-name studio --years 1 --query password -o tsv
```

The redirect URI is **`<origin><base path>/api/auth/entra/callback`** — note `entra`, not `oidc`.
A local port-forward needs its own entry, for example `http://127.0.0.1:8080/api/auth/entra/callback`
(Entra accepts plain `http` only for loopback addresses).

API permissions: `openid profile email` only. Do **not** add `GroupMember.Read.All`,
`Directory.Read.All`, or the groups claim.

### 2.2 App roles

Define the roles in the app manifest. Values are free text without spaces; choose your own.

```json
[
  { "allowedMemberTypes": ["User"], "displayName": "Studio administrator", "value": "StorageBase.Admin",
    "description": "Manages StorageBase Studio", "id": "<new-guid>", "isEnabled": true },
  { "allowedMemberTypes": ["User"], "displayName": "Payments read", "value": "Team.Payments.Read",
    "description": "Read the payments team's connections", "id": "<new-guid>", "isEnabled": true },
  { "allowedMemberTypes": ["User"], "displayName": "Payments write", "value": "Team.Payments.Write",
    "description": "Change the payments team's data", "id": "<new-guid>", "isEnabled": true }
]
```

```bash
az ad app update --id "$APP_ID" --app-roles @app-roles.json
```

### 2.3 Enterprise application: who gets which role

```bash
az ad sp create --id "$APP_ID"
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
# Only assigned users may sign in at all
az ad sp update --id "$SP_ID" --set appRoleAssignmentRequired=true

# Assign an Entra group to an app role (repeat per group/role)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
  --body '{"principalId":"<group-object-id>","resourceId":"'"$SP_ID"'","appRoleId":"<app-role-id>"}'
```

App roles are emitted in the id token's `roles` claim by default; no token configuration is needed.
Roles are read at every sign-in — a change in Entra takes effect at the user's next sign-in.

## 3. Server configuration

All server-side, read at runtime (no rebuild). See [`.env.example`](../.env.example) and the Helm
values `storagebase.entra.*` / `storagebase.localLogin` ([`HELM_CHART.md`](HELM_CHART.md)).

| Variable | Meaning |
| :--- | :--- |
| `STORAGEBASE_ENTRA_TENANT_ID` | Directory (tenant) id **GUID**. The issuer is `https://login.microsoftonline.com/<tenant>/v2.0`; a token whose `tid` or `iss` names another tenant is refused. |
| `STORAGEBASE_ENTRA_CLIENT_ID` / `STORAGEBASE_ENTRA_CLIENT_SECRET` | The app registration. The secret goes through the chart's Secret (`entra-client-secret`). |
| `STORAGEBASE_ENTRA_ENABLED` | Initial position of the switch (`true`/`false`). Once an admin saves the switch, the saved value wins. |
| `STORAGEBASE_ENTRA_ADMIN_ROLES` | Comma-separated app-role values that make a Studio admin. Default `StorageBase.Admin`. |
| `STORAGEBASE_ENTRA_ALLOWED_ROLES` | Optional sign-in gate: a user holding none of these (and no admin role) is refused. |
| `STORAGEBASE_ENTRA_REDIRECT_URI` | Optional explicit callback URL. Otherwise derived from `x-forwarded-host`/`x-forwarded-proto` or `Host` — and a missing `x-forwarded-proto` is read as `https`, so **set this when Studio is reached over plain http** (a port-forward). Its origin is also where the browser is sent after sign-in. |
| `STORAGEBASE_ENTRA_SESSION_HOURS` | Entra session length, 1–168 hours, default 8. |
| `STORAGEBASE_LOCAL_LOGIN` | `enabled` (default) \| `admin-only` \| `disabled` — who may still use email/password. |

**Managed connections, groups, bindings and a saved switch need server storage**
(`STORAGE_PROVIDER=sqlite` or `postgres`). With `STORAGE_PROVIDER=local` the switch follows the
environment and the Access screens say that managed connections are unavailable.

## 4. The sign-in switch and break-glass

The login page asks the server at request time which methods to offer (`GET /api/auth/providers`,
public): "Sign in with Microsoft", the email/password form, or both.

- `enabled`: both methods for everyone.
- `admin-only`: email/password for **administrator accounts only** (break-glass). A non-admin account
  with the right password gets the same 401 as a wrong password, so the policy leaks nothing.
- `disabled`: email/password refused outright (403) — Microsoft only.

Safety rails, enforced on the server on every read and save:

- Entra cannot be on unless it is configured.
- Local sign-in cannot be `disabled` while Entra is off; that combination reads and saves as
  `admin-only`, so nobody can be locked out.
- Turning Entra **on from the admin screen** needs a successful **test sign-in** in the last 24 hours
  (Admin → Access → Authentication → "Test sign-in with Microsoft"). A test sign-in runs the real flow,
  records the claims it received (roles, oid, tid, upn and the Studio role they map to) and creates no
  session. The environment's `STORAGEBASE_ENTRA_ENABLED=true` needs no test.

Recommended production setting: Entra on, `STORAGEBASE_LOCAL_LOGIN=admin-only`, a strong
`ADMIN_PASSWORD` (plus `ADMIN_TOTP_SECRET`) kept for emergencies.

## 5. The access model

| Record | Fields |
| :--- | :--- |
| Connection group | `id` (slug, optional on create), `name`, `description` |
| Role binding | `appRoleValue` → `groupId` → `permission` (`read` \| `write` \| `admin`) |
| Managed connection | `id` (slug, optional), `kind` (`database` \| `resource`), `type`, `name`, `config` (credentials sealed with the storage encryption), `groupIds[]` |

Rules (`src/lib/access/permissions.ts`): a binding matches when its group is one of the connection's
groups and its role value is one of the session's roles — the Studio role (`user`/`admin`, so a binding
to `user` covers everyone signed in) or an app role, compared case-insensitively. The effective
permission is the **maximum** over matching bindings. No match means **no access**, answered as 404.
A connection in no group is visible to admins only.

Helm seed connections keep working. Their `roles:` list now also matches app-role values, so a seed
with `roles: [Team.Payments.Read]` is served to that app role ([`SEED_CONNECTIONS.md`](SEED_CONNECTIONS.md)).

### 5.1 What each permission allows

| Surface | `read` | `write` | `admin` |
| :--- | :--- | :--- | :--- |
| Database: browse objects, monitoring, health, profile | yes | yes | yes |
| Database: statements | read-only only (see below) | any | any |
| Database: transactions (`begin`/`commit`/`rollback`/`query`) | no (status only) | yes | yes |
| Database: object edit (plan + apply) | no | yes | yes |
| Database: maintenance | Studio admins only (unchanged) | ← | ← |
| Resources: list/browse/peek/reveal/download/inspect | yes | yes | yes |
| Resources: create/update/delete objects, publish, produce, upload, soft-delete, recover, topic config/partitions | no | yes | yes |
| Resources: purge, delete topic, delete consumer group, reset offsets, purge soft-deleted | no | no | yes |

The per-route table is `src/lib/access/resource-permissions.ts`; a resource route missing from it
needs `admin` (fails closed).

**Read-only statements** (`src/lib/access/read-only.ts`): SQL — every statement of the text must be a
`SELECT` (or `WITH … SELECT`), `SHOW`, `DESCRIBE`/`DESC` or `EXPLAIN`, and no statement may contain a
writing keyword in its code (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `DROP`, `CREATE`, `ALTER`,
`TRUNCATE`, `GRANT`, `REVOKE`, `CALL`, `EXEC`, `COPY`, …), which also catches data-modifying CTEs,
`SELECT … INTO` and `SELECT … FOR UPDATE`. MongoDB — `find`, `findOne`, `count`, `distinct`, or an
`aggregate` without `$out`/`$merge`. Redis — a fixed list of read commands (`CONFIG`, `CLIENT` and
scripting are excluded).

> **Defence in depth.** A statement classifier cannot see a function with side effects called from a
> `SELECT` (`SELECT pg_terminate_backend(…)`, a user-defined function that writes). For connections
> bound at `read`, configure a **database user that can only read**; the classifier is the second line.

## 6. Admin screens

**Admin → Access** (`/admin/access`):

- **Groups** — create, rename, delete (deleting removes the group's bindings and its membership).
- **Role bindings** — app role value → group → permission; the role field suggests values seen at
  recent sign-ins (never fetched from the directory).
- **Managed connections** — create/edit with the same field lists as the connection forms, assign
  groups, **Test connection**. Credentials are write-only: an edit shows "Set — leave blank to keep",
  and "Clear" removes one. TLS and SSH tunnel settings are not editable here yet.
- **Authentication** — the Entra configuration the server read, the switch, the local-login policy,
  the test sign-in and its last result.
- **Access preview** — enter app role values to see which managed connections and permissions they
  yield.
- **Vault exclusions** — one global list of rules, each "on vaults of this type whose name/address
  matches this pattern (exact, glob or regex), hide secrets/keys/certificates whose name matches that
  pattern". Enforced on the server on every vault request, for everyone including administrators, and
  matched against the vault the **server** resolved — for a managed connection, its decrypted record
  (the Key Vault name the browser never receives). Add, edit, enable/disable and delete rules; the
  server's validation sentence shows beside the form. **Preview** picks a vault connection you can
  use (managed or your own) and answers how many objects the saved rules — or the rule in the form —
  would hide, per type: counts only, never names. The vault workbench shows admins a read-only
  "N exclusion rules apply to this vault" line linking here. Matching per vault type:
  [`docs/resources/azure-key-vault.md`](resources/azure-key-vault.md#exclusion-rules-admin).

Every change is audited with before/after (`access_config`, `managed_connection`,
`auth_settings_changed` events, and `resource_operation` `vault.exclusions.*` for exclusion rules;
never a credential). Every use of a managed connection is audited with
its grant (`permission`, `granted_by`, `access_groups` on `query_execution`, `resource_operation` and a
`managed_connection`/`connection.use` event at most once per user and connection per 10 minutes).
Sign-ins carry `auth_provider`, `subject` (the Entra object id) and `app_roles`.

## 7. Admin API (scripted deployments)

All routes are admin-only (a session cookie from an admin sign-in), audited, and answer errors as
`{ error, code? }`. Mutating requests from a script must send `Content-Type: application/json` (or an
`Origin` header matching the deployment) to pass the CSRF check.

```bash
BASE=http://127.0.0.1:8080
H=(-H "Content-Type: application/json" -H "Origin: $BASE")
curl -s -c jar "${H[@]}" -d '{"email":"<admin-email>","password":"<admin-password>"}' $BASE/api/auth/login

# Groups (id optional; a slug makes bindings scriptable)
curl -s -b jar "${H[@]}" -d '{"id":"payments","name":"Payments","description":"Payments team"}' $BASE/api/admin/access/groups
curl -s -b jar $BASE/api/admin/access/groups
curl -s -b jar "${H[@]}" -X PUT -d '{"id":"payments","name":"Payments team"}' $BASE/api/admin/access/groups
curl -s -b jar "${H[@]}" -X DELETE "$BASE/api/admin/access/groups?id=payments"

# Bindings (POST upserts: the same role + group again changes the permission)
curl -s -b jar "${H[@]}" -d '{"appRoleValue":"Team.Payments.Read","groupId":"payments","permission":"read"}' $BASE/api/admin/access/bindings
curl -s -b jar "${H[@]}" -X DELETE "$BASE/api/admin/access/bindings?id=<binding-id>"

# Managed connections — config uses the connection field names (DatabaseConnection / ResourceConnection)
curl -s -b jar "${H[@]}" -d '{"id":"orders-db","kind":"database","type":"postgres","name":"Orders",
  "groupIds":["payments"],"config":{"host":"<host>","port":5432,"user":"<user>","password":"<password>","database":"orders"}}' \
  $BASE/api/admin/access/connections
curl -s -b jar "${H[@]}" -d '{"id":"team-vault","kind":"resource","type":"azure-key-vault","name":"Team vault",
  "groupIds":["payments"],"config":{"vaultName":"<vault>","tenantId":"<tenant>","clientId":"<client>","clientSecret":"<secret>"}}' \
  $BASE/api/admin/access/connections
# Update: a blank/absent secret keeps the stored one, null clears it
curl -s -b jar "${H[@]}" -X PUT -d '{"id":"orders-db","config":{"host":"<new-host>","port":5432,"user":"<user>","database":"orders"}}' $BASE/api/admin/access/connections
curl -s -b jar "${H[@]}" -d '{"id":"orders-db","kind":"database","type":"postgres","name":"Orders","config":{}}' $BASE/api/admin/access/connections/test
curl -s -b jar "${H[@]}" -X DELETE "$BASE/api/admin/access/connections?id=orders-db"

# Sign-in switch and preview
curl -s -b jar $BASE/api/admin/access/auth-settings
curl -s -b jar "${H[@]}" -d '{"entraEnabled":true,"localLogin":"admin-only"}' $BASE/api/admin/access/auth-settings
curl -s -b jar "${H[@]}" -d '{"roles":["Team.Payments.Read"]}' $BASE/api/admin/access/preview

# Vault exclusions (global; matched server-side against the vault each connection really reaches)
curl -s -b jar $BASE/api/resources/admin/vault-exclusions
curl -s -b jar "${H[@]}" -d '{"vaultType":"azure-key-vault","vaultPattern":"^kv-prod-","vaultPatternKind":"regex",
  "objectPattern":"break-glass-*","objectPatternKind":"glob","objectType":"secret","note":"<why>"}' \
  $BASE/api/resources/admin/vault-exclusions
curl -s -b jar "${H[@]}" -X PUT -d '{"id":"<rule-id>","vaultType":"any","vaultPattern":"*","vaultPatternKind":"glob",
  "objectPattern":"break-glass-*","objectPatternKind":"glob","objectType":"any","enabled":false}' \
  $BASE/api/resources/admin/vault-exclusions
curl -s -b jar "${H[@]}" -X DELETE "$BASE/api/resources/admin/vault-exclusions?id=<rule-id>"
curl -s -b jar "${H[@]}" -d '{"connectionId":"managed:team-vault"}' $BASE/api/resources/admin/vault-exclusions/preview
```

Users' browsers address a managed database connection as `seed:m_<id>` and a managed resource as
`managed:<id>`; both are listed (without credentials) by `GET /api/connections/managed` and
`GET /api/resources/managed`.

## 8. Troubleshooting

The login page shows one sentence per failure; the audit trail (`login_failure` events) has the code.

| Code | Meaning / fix |
| :--- | :--- |
| `entra_disabled` | The switch is off. Turn it on in Admin → Access → Authentication or set `STORAGEBASE_ENTRA_ENABLED=true`. |
| `entra_tenant_mismatch` | The token's `tid`/`iss` is not `STORAGEBASE_ENTRA_TENANT_ID` — a guest from another tenant, or the wrong tenant id. |
| `entra_role_not_allowed` | `STORAGEBASE_ENTRA_ALLOWED_ROLES` is set and the user holds none of those roles. Assign an app role. |
| `oidc_config` | Missing or invalid `STORAGEBASE_ENTRA_*` (tenant id must be a GUID), or the JWT secret. |
| `oidc_discovery` | `https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration` could not be fetched (egress, DNS, TLS). |
| `oidc_state_missing` / `oidc_state_invalid` | The 5-minute state cookie was lost or tampered with — often the browser dropped a `Secure` cookie over plain http; see `AUTH_COOKIE_SECURE`. |
| `oidc_failed` | The code exchange failed. The server log names the Entra error, e.g. `AADSTS50011` (redirect URI not registered — register the exact `…/api/auth/entra/callback` URL) or `AADSTS7000215` (wrong client secret). |

A user who signs in but sees no managed connections: run **Access preview** with the role values from
their last sign-in (Role bindings shows recently seen values); check the connection is in a group that
a binding grants.

## 9. Known limits

- No federated sign-out: signing out ends the Studio session only; the Microsoft session stays (the
  account picker appears at the next sign-in).
- Roles are read at sign-in; a revoked app role takes effect when the session expires (8 h default).
- Agent runs on a managed connection are available to admins only (the run records no app roles).
- TLS and SSH tunnel fields of managed connections cannot be edited in the admin screen yet.
- One tenant per deployment; sovereign clouds (other authority hosts) are not supported yet.

## 10. Manual test checklist (real tenant)

1. Register the app and roles (§2), set the variables (§3), `STORAGE_PROVIDER=sqlite|postgres`.
2. Sign in locally as admin → Admin → Access → Authentication: configuration shown without error.
3. "Test sign-in with Microsoft" with an admin account → result shows `studioRole: admin` and the roles.
4. Turn Entra on, local sign-in `admin-only`, save; sign out → the login page shows the Microsoft
   button and "Administrator sign-in".
5. Create a group, a `read` binding for a test role, a managed database connection in the group.
6. Sign in as a user with that role → the connection is listed with a lock; `SELECT` works;
   `DELETE`/`UPDATE` are refused with "read-only"; no host or password anywhere in the page or network tab.
7. Sign in as a user without the role → the connection is not listed; its id answers 404.
8. Admin → Audit: sign-ins carry `auth_provider=entra`, uses carry `permission`/`granted_by`.
