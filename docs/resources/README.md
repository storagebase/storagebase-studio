# Resource providers

The StorageBase fork's provider family for blob storage, messaging systems and
key vaults. Same triad rule as the database side, against a different set:

- **Code:** `src/lib/resources/providers/<family>/<type-id>.ts`, or
  `.../<type-id>/index.ts` when the provider is split across modules. New
  families beyond `blob/`, `messaging/`, `vaults/` are not expected — the three
  are the fork's whole scope.
- **Docs:** `docs/resources/<type-id>.md`, one per type-id (an `s3` doc covers
  MinIO/R2/Spaces as wire relatives; a Vault doc covers OpenBao as its second
  id — write the mapping table, never a second doc).
- **Tests:** `tests/integration/resources/<type-id>-provider.test.ts`, fully
  mocked via `mock.module` in the same discipline as
  `tests/integration/db/*-provider.test.ts`, with mock fidelity anchored to a
  live pass against `resources-compose.yml` (the fork's fixture stack; it never
  touches `database-compose.yml`).

All three land in the same PR, and the 100% line-coverage gate applies to all
of them: coverage is measured over `src/lib/resources/**`,
`src/app/api/resources/**` and `src/components/resources/**` exactly as it is
over the database surface.

A doc answers the same fixed sections as a database provider doc (connection,
browse surface, operations, capabilities and labels, testing, known
limitations) minus the SQL-specific ones a resource family never has: there is
no dialect, no query grammar, no EXPLAIN, no transactions — do not invent those
sections to mirror upstream's shape.

## Scope of this milestone

M1 ships the spine only: types, base provider, registry, factory, storage and
API handling, UI configuration and icons. The four REST routes and the sidebar
listing speak through them, but no provider module is registered yet, so the
picker offers no types: `selectableResourceTypes()` is empty by design until
the blob family registers `s3`. That is the honest midpoint — a type that answers 501 looks
broken, so the UI hides it rather than offering it.
