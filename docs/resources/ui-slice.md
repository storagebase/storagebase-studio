# Resource UI slice

The shared chrome families plug into. One owner, lands on `main` before any
family branch: everything here is the merge surface families must not touch.

## What the slice owns

- **Connection dialog tabs** (`ConnectionModal` + `src/components/resources/ResourceConnectionForm.tsx`):
  Databases / Blob Storage / Messaging / Key Vaults. A category tab renders
  only when its provider module is registered (`selectableResourceTypes`) —
  the registry gate. The form renders exactly `RESOURCE_UI_CONFIG[type].connectionFields`
  and probes through `POST /api/resources/test`; state lives in
  `src/hooks/use-resource-connection-form.ts`.
- **Sidebar sections** (`src/components/sidebar/Sidebar.tsx` + `src/components/resources/ResourceConnectionsList.tsx`
  and `ResourceTree.tsx`): the resource list (select/edit/delete/add) and one
  lazy tree per active connection, reading `POST /api/resources/tree` level by
  level. The tree branches on `hasChildren`, never on `kind`; node `meta`
  renders as-is and never carries credentials (provider contract).
- **Shell state** (`src/hooks/use-resource-connections.ts`, wired in `Studio.tsx`):
  load-on-ready from the `resource_connections` collection, save activates,
  deleting the active connection falls back to the first survivor. No seeds,
  no catalog reads, no persisted active id.
- **Viewer registry** (`src/components/resources/viewer-registry.ts`): one viewer
  per type-id, `ComponentType<{ connection: ResourceConnection; node: ResourceNode }>`.
  A miss returns `undefined` — the shell degrades to the tree, never crashes.
- **Audit vocabulary** (`resource_operation` + `resource_denied/not_found/conflict/unsupported/failed`
  in `src/lib/audit.ts`): family writes emit decision + outcome events joined by
  one correlation id (the `agent_operation` shape). Map outcomes with a total
  record so an unmapped outcome fails to compile. `resource_unsupported` is the
  honest refusal (Kafka has no purge); the trail records the class, the response
  carries the provider's sentence. Reads are audited too: wrap the provider call in
  `auditedResourceRead` (`src/lib/api/resource-audit.ts`) with the action's address as the target
  and numeric `counts` only — one event per read, success or failure.

## Firewall rule for families

Never touch the shared chrome: `ConnectionModal`, `Sidebar`, `Studio`,
`QueryTab`, the form hooks, the list/tree components. A family lands as: one
registry entry (`registerResourceProviderLoader`), one viewer entry
(`registerResourceViewer`), provider module(s), family routes, browser/viewer
components under `src/components/resources/<family>/`, docs + tests triad.
Viewers receive `{ connection, node }` and write against this spec; they merge
after the slice.
