# Section rail and navigation pages

The section rail is the StorageBase fork's only navigation chrome. It is a
fork-owned React layer (`src/components/storagebase/sections/**`) plus three
fork-owned pages (`src/app/(storagebase)/{storage,messaging,vaults}/page.tsx`)
and one upstream seam (S1 in `SEAMS.md`). Upstream's Studio, headers, sidebar
and admin sections are never edited for navigation.

## The four sections

`src/components/storagebase/sections/sections.ts` is the one source of truth:

| id | href | label | page |
|---|---|---|---|
| `databases` | `/` | Databases | upstream Studio inside `WorkspaceOwnerGate` |
| `blob` | `/storage` | Blob storage | `ResourceSectionPage category="blob"` |
| `messaging` | `/messaging` | Messaging | `ResourceSectionPage category="messaging"` |
| `vault` | `/vaults` | Vaults | `ResourceSectionPage category="vault"` |

`SectionId` is `"databases" | ResourceCategory` and the `ResourceCategory`
union in `src/storagebase/resources/types.ts` is the only category list.
`sectionById()` is exhaustive; `sectionForPathname()` prefixes are exact
(`/storagebox` is not `/storage`) and every unmatched path falls back to
Databases. The rail is `aria-label="Sections"`, each item is a real link with
an accessible name and `aria-current="page"`, and the mobile strip shows the
`shortLabel` under the icon.

The admin-only entry is a link to the fork's own `/sb-admin/audit` page, both
in the rail and in the header's account menu. `useAuth()` is imported from
upstream and read only; no upstream admin registry is extended (P2/P3).

## Shell and routes

`SectionShell` renders the rail and a `data-testid="section-page"` slot. Its
`[&>*]:h-full!` override cancels Studio's own `h-screen` root so the studio
fits beside the rail; **the override must stay inside the fork shell**, never
in `Studio.tsx` or its callers. Each section page awaits `renderSectionPage()`
and wraps the result in the shell. There is deliberately **no** `layout.tsx`
in the route group (it would also wrap `/sb-admin/**`, which another agent
owns) and **no** `route.ts` anywhere under `src/app/(storagebase)/**` — the
upstream route-auth census permits only `health` outside `src/app/api/`.

S1 is three added lines in `src/app/page.tsx`: the `StorageBaseShell` import
and the opening/closing wrapper **inside** `WorkspaceOwnerGate`. The `<Studio
/>` line is byte-for-byte unchanged so the diff stays within the ledger's
`+3/−0` budget. `StorageBaseShell` re-exports `SectionShell`; there is one
shell implementation.

`section-route.tsx` reads `?connection=<id>` from `searchParams` (the first
value when repeated) and passes it to `ResourceSectionPage` as
`initialConnectionId`. The browser tab title comes from `sectionMetadata()`.

## Page ↔ catalog contract

Resource connections are **not** in upstream storage. The hooks under
`src/components/storagebase/sections/` talk only to the fork routes:

| Hook | Route |
|---|---|
| `useResourceConnections` | `POST /api/sb/resources/connections` with `{ action: "list" }`, `{ action: "create", connection }`, and `POST /api/sb/resources/connections/[id]` with `{ action: "update" \| "delete" }` |
| `useManagedResourceConnections` | the same list, filtered to `seeded: true` rows (D3 config-only "managed" connections) |
| `useResourceHealth` | `POST /api/sb/resources/health` |
| `useResourceConnectionForm` | `POST /api/sb/resources/test` before the save |

The browser holds **rows only** — ids, non-secret fields, `hasCredential`, and
`permission` (the creator-set grant on stored rows; the role-derived grant on
seeded rows, which also carry `seeded: true`). `sectionConnectionBody()`
names a stored (`res_…`) or seeded (`seed:…`) row by `connectionId`; only an
unsaved form candidate travels inline, once, for the test route. No secret is
ever returned to the browser or rendered in a row, header or dialog.

`useResourceSection` filters the merged catalog by `RESOURCE_CATEGORY_OF`,
derives the active row (explicit pick → deep link → per-section remembered id
→ first), remembers picks in `localStorage` behind try/catch, and rewrites the
URL with `history.replaceState`. Seeded rows have no edit/duplicate/delete
affordances; any row granted `read` — a seeded entry or a stored record whose
definer chose `read` — reaches the workbench and viewer with `readOnly: true`,
and the routes refuse write/admin operations regardless of the session's role.

## Main area

Workbench types (`opensWorkbench()` in the fork UI config: Kafka and every
vault family) open full-page. Vaults use the fork VaultWorkbench with the new
`{ connection, readOnly? }` signature — the legacy `isAdmin` prop was dropped
with D3 and must not be passed. Messaging uses the navigation-level
`SectionKafkaWorkbench` (the shared resource tree) until the phase-4 Kafka
workbench lands; the page's prop contract (`connection`, `readOnly`) is
already the final one. Other types show `ResourceTree` beside
`ResourceViewerPane`, which resolves the family viewer through the fork's
viewer registry. Below the breakpoint the page is master/detail with both
views mounted and a Back button in the header.

## Tests

`tests/storagebase/components/sections/**` ports the legacy section tests with
fork imports and adds hook/adapter coverage. Every line in
`src/components/storagebase/sections/**` is covered at 100% by that directory's
tests; the page seam is also exercised by the unmodified upstream
`tests/components/Page.test.tsx`.
