# store

Server-side durable fork store: audit events and generic records (resource connections) in
fork-owned `storagebase_*` tables. It follows upstream's storage config (`STORAGE_PROVIDER` =
`local` | `sqlite` | `postgres`, with `STORAGE_SQLITE_PATH` / `STORAGE_POSTGRES_URL`), so one
deployment configuration drives both layers; retention reads `STORAGEBASE_AUDIT_RETENTION_DAYS`.
Never extend upstream storage collections (P3).

On `sqlite` the store opens its own handle to the same file and releases it once idle (the next
macrotask after the last statement), so it never outlives the upstream provider's close: a held
handle is a file Windows cannot move or delete.
