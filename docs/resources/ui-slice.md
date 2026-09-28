# Resource UI slice

The shared chrome families plug into. One owner, lands on `main` before any
family branch: everything here is the merge surface families must not touch.

## What the slice owns

- **Section pages** (`src/components/sections/**`, routes in `src/app/(sections)/**`):
  a section rail on the far left switches between four management pages —
  Databases (`/`, the upstream studio), Blob storage (`/storage`), Messaging
  (`/messaging`) and Vaults (`/vaults`). Each resource page has its own
  connection list, header and main area (`ResourceSectionPage`), so a page
  never shows another family's active connection. The upstream chrome carries
  none of this: `src/app/page.tsx` wraps the studio in `SectionShell`, and
  `Studio`, `Sidebar`, `ConnectionsList` and `ConnectionModal` stay
  databases-only.
- **Connection form** (`src/components/sections/ResourceConnectionDialog.tsx` +
  `src/components/resources/ResourceConnectionForm.tsx`): pinned to the page's
  category, no category tabs. A type appears only when its provider module is
  registered (`selectableResourceTypes`) — the registry gate. The form renders
  exactly `RESOURCE_UI_CONFIG[type].connectionFields` and probes through
  `POST /api/resources/test`; state lives in `src/hooks/use-resource-connection-form.ts`.
- **Connection list and tree** (`SectionConnectionList.tsx` + `src/components/resources/ResourceTree.tsx`):
  select, edit, duplicate, delete (confirmed), add. Admin-managed connections
  (`useManagedResourceConnections`) list after the viewer's own with a lock,
  "Managed" and their grant, and no edit, duplicate or delete. A workbench type
  (`opensWorkbench()`: Kafka, every vault) opens its workbench full-page; the
  others get one lazy tree under the list, reading `POST /api/resources/tree`
  level by level, and a tree row opens its viewer full-page beside it
  (`ResourceViewerPane`). The tree branches on `hasChildren`, never on `kind`;
  node `meta` renders as-is and never carries credentials (provider contract).
- **Page state** (`src/hooks/use-resource-section.ts` over `use-resource-connections.ts`):
  load-on-ready from the `resource_connections` collection; the active
  connection is derived — the explicit pick, else the `?connection=<id>` deep
  link, else the one the section remembered (localStorage, per section), else
  the first — so it never points at a deleted connection. A save activates.
  The header's status is one `POST /api/resources/health` per connection shown.
- **Request bodies** (`src/lib/resources/connection-body.ts`): every UI call names
  its connection through `resourceConnectionBody(conn)`, so the switch to
  naming managed connections by id happens in one place.
- **Read-only** (`isReadOnlyResourceConnection`): a managed connection granted
  `read` reaches the workbenches and viewers as `readOnly`, which withholds
  every write control (create, save, delete, produce, purge, upload, offset
  reset, config edit) and keeps the reads, Reveal included.
- **Viewer registry** (`src/components/resources/viewer-registry.ts`): one viewer
  per type-id, `ComponentType<ResourceViewerProps>` (`connection`, `node`,
  `onChanged`, `onClose`, `readOnly`). A miss throws; the registry test pins
  every tree-browsed type to a viewer.
- **Audit vocabulary** (`resource_operation` + `resource_denied/not_found/conflict/unsupported/failed`
  in `src/lib/audit.ts`): family writes emit decision + outcome events joined by
  one correlation id (the `agent_operation` shape). Map outcomes with a total
  record so an unmapped outcome fails to compile. `resource_unsupported` is the
  honest refusal (Kafka has no purge); the trail records the class, the response
  carries the provider's sentence. Reads are audited too: wrap the provider call in
  `auditedResourceRead` (`src/lib/api/resource-audit.ts`) with the action's address as the target
  and numeric `counts` only — one event per read, success or failure.

## Firewall rule for families

Never touch the shared chrome: the upstream `ConnectionModal`, `Sidebar`,
`Studio` and `QueryTab`, the section pages, the form hooks, the list/tree
components. A family lands as: one
registry entry (`registerResourceProviderLoader`), one viewer entry
(`registerResourceViewer`), provider module(s), family routes, browser/viewer
components under `src/components/resources/<family>/`, docs + tests triad.
Viewers receive `ResourceViewerProps` and write against this spec, honouring
`readOnly`; they merge after the slice.
