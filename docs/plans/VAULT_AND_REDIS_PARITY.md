# Plan: Key Vault and Redis management parity

Status: **plan** — nothing here is implemented yet. Owner: next agent after the current Kafka /
Sentinel / audit work lands. Companion plan: [`ENTRA_SSO_AND_RESOURCE_GROUPS.md`](ENTRA_SSO_AND_RESOURCE_GROUPS.md)
(authentication and group-based authorization, which this work depends on).

Goal: make StorageBase Studio a complete, team-scoped management console for **Azure Key Vault** and
**Redis**, so that a team can use it as its only tool for both — browse, edit, recover, and audit —
with access decided by resource groups rather than by naming conventions.

Everything below keeps the fork rules in [`STORAGEBASE.md`](../../STORAGEBASE.md): Key Vault work stays
in the resource layer; Redis work touches the upstream Redis provider and so is recorded as a fork
exception (like Sentinel) and offered upstream.

## 1. Target capabilities and gaps

### Azure Key Vault
| Capability | StorageBase today | Work |
| :--- | :--- | :--- |
| Secrets list / reveal / write / delete | Yes (`src/lib/resources/providers/vaults/azure-key-vault.ts`), reveal-on-click, audited writes | **Delete currently purges immediately** (soft-delete + purge in one step). Change to soft-delete by default, with recover and purge as separate audited operations. |
| Secret metadata: enabled, content type, created/updated, expiry/activation, tags | Not surfaced | Show in list + detail; edit tags, content type, expiry/activation, enabled. |
| Secret versions | No | Version list + read a specific version. |
| Keys: create RSA 2048/3072/4096 or EC, view type/enabled/allowed operations, delete | No | New key operations in the resource layer (`@azure/keyvault-keys`); stage the SDK in `scripts/stage-resource-sdks.mjs` and `next.config.ts` externals. |
| Certificates: import PEM/PFX/P12/CER/CRT with optional password, view subject/issuer/expiry, delete | No | Certificate operations (`@azure/keyvault-certificates`), same SDK staging. |
| Soft-deleted items per type: list (deleted date, scheduled purge date), recover, purge | No | For secrets, keys, certificates; purge requires the group's admin permission. |
| Vault discovery across subscriptions, optional name filter | No (one connection = one vault) | Admin "Discover vaults" through Azure Resource Manager / Resource Graph over configured subscription ids, creating **managed** resource connections assigned to a resource group. Subscriptions come from config, never code. |
| Hide a vault; hide individual objects (vault name may be a regex) | No | Per-managed-resource visibility policy **enforced server-side on every read path** — list, read by name, versions, and the deleted list — not only as a list filter. |
| Copy after reveal, confirmations on delete / recover / purge (purge worded as permanent) | Reveal yes | Add copy + confirmations (typed-name confirmation for purge). |

### Redis
| Capability | StorageBase today | Work |
| :--- | :--- | :--- |
| Standalone / Sentinel | Standalone yes; Sentinel in progress on this branch | — |
| Cluster | No | `ioredis.Cluster` (fork exception in the Redis provider). Master/replica setups connect to the master as standalone — document, no extra mode. |
| Key tree grouped by prefix, pattern search | Yes, `SCAN`-based | Confirm grouping on `:`; add a configurable delimiter if needed. Never `KEYS *`. |
| Type-aware values, TTL, JSON pretty-print and validate-before-save | Per `docs/providers/redis.md` | Verify JSON validation on string edits and TTL view/edit; fill gaps. |
| Command policy by permission | Command editor runs anything the Redis ACL user may run | Server-side policy: read allowlist for readers, write allowlist for writers, always-deny list (`FLUSHALL`, `FLUSHDB`, `CONFIG SET`, `EVAL*`, `SCRIPT`, `DEBUG`, `SHUTDOWN`, `MODULE`, `ACL SETUSER`, …) unless the group grants admin. Fork-owned policy module called from the Redis query path. |
| Destination (SSRF) policy | None | Fork-owned `src/lib/security/destination-policy.ts`: block loopback, link-local (incl. cloud metadata), multicast, unspecified and IPv4-mapped addresses; optional `STORAGEBASE_ALLOWED_NETWORKS` CIDR allowlist and port allowlist; short connect timeouts; checked on save and on connect for **managed** connections. |
| Encrypted stored credentials | Yes (`src/lib/storage/connection-secrets.ts`) | — |
| Admin registry of instances with bulk "test connection" | Per-user connections only | Managed connections (companion plan) + bulk test action. |

### Cross-cutting
| Capability | StorageBase today | Work |
| :--- | :--- | :--- |
| Audit of every view, reveal, write, delete, recover, purge, sync and command | Structured stdout + in-memory ring buffer; query audit with masked SQL in progress | Redis commands logged with **arguments masked**; a **durable audit sink** (Postgres table) with admin UI filters per group, user, resource and action. |
| Rate limiting | Yes (`src/lib/api/rate-limit.ts`) | Apply to the new routes. |

## 2. Security requirements
1. Access comes from explicit resource groups bound to Entra app roles (companion plan) — never from
   substrings or prefixes of resource names.
2. No group or role ids in code, chart defaults, or docs examples (placeholders only).
3. Hidden objects are unreadable by every path, not just filtered from lists.
4. Every resource route resolves a **managed resource id** server-side; the browser never receives or
   sends credentials for managed resources.
5. Secret values and Redis command arguments never appear in audit records.

## 3. Phasing

| Phase | Scope | Depends on |
| :--- | :--- | :--- |
| P0 | Managed (server-owned) resource connections: admin registry, server-side credential resolution by id (the "M6" note in `src/lib/api/resource-route.ts`) | — |
| P1 | Key Vault: soft-delete/recover/purge, metadata + tags + versions, keys, certificates, visibility policy | P0 |
| P2 | Vault discovery across subscriptions | P0, Entra service identity |
| P3 | Redis: command policy, destination policy, cluster mode, TTL/JSON editing checks | Sentinel (this branch) |
| P4 | Resource groups + Entra app-role binding + SSO switch | companion plan |
| P5 | Durable audit sink and audit UI filters | P1–P4 |

Each phase follows the repo rules: resource triad (`docs/resources/<type>.md` + integration test) or
provider triad for Redis, 100% line coverage, TDD, and the full pre-commit gate from `CLAUDE.md`.

## 4. Acceptance checklist
- [ ] Every capability in §1 is implemented or explicitly deferred with the owner's agreement.
- [ ] A member of group X sees only group X's vaults and Redis instances; a reader cannot write;
      delete needs write; purge and admin-only commands need admin — each covered by route tests.
- [ ] No credential for a managed resource reaches the browser (asserted in route tests).
- [ ] Hidden secrets cannot be listed, read by name, versioned, or seen in the deleted list.
- [ ] Every reveal, write, delete, recover, purge, sync and command is in the durable audit trail with
      actor, app roles, IP, resource, group and outcome — values masked.
