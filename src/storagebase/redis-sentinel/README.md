# redis-sentinel

The fork side of seam S4 (`SEAMS.md`): ioredis Sentinel options parsed out of a
`redis-sentinel://` / `rediss-sentinel://` connection string, until upstream takes the PR.

- `options.ts` — `parseSentinelConnectionString` (the grammar) and
  `storagebaseSentinelOptions` (the seam's entry: `{}` for everything that is not a Sentinel
  string, so upstream behaviour stays bit-identical).
- Docs: `docs/storagebase/redis-sentinel.md` (grammar, seam, the seeds-cannot-carry-it drift
  note, the upstream-PR plan, the compose fixture).
- Tests: `tests/storagebase/unit/redis-sentinel/options.test.ts` (100% line coverage of
  options.ts is a hard gate).
- Live fixture: `deploy/storagebase/compose.yml` (master + replica + 3 sentinels).
