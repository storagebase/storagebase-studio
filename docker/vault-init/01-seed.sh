#!/bin/sh
# Vault fixture seed (workstream B). Run by the vault-init sidecar in
# resources-compose.yml on every `up` against the dev server (VAULT_ADDR and
# VAULT_TOKEN come from the sidecar's environment). `kv put` overwrites, so
# re-runs are no-ops with identical content.
#
# What exists afterwards, and why:
# - `storagebase/fixture` (kv-v2: user/password) — the secret.read path is
#   measured against exactly this shape, and the masked secret view renders
#   these two keys.
# - `storagebase/nested/deep` — proves path delimiting in the tree: `nested/`
#   must read as a folder, the same ruling the blob prefix fixture proves.
set -eu

# The dev server ships only secret/ and cubbyhole: enable the fixture mount
# first, idempotently (a second enable answers "path is already in use").
if ! vault secrets list | grep -q '^storagebase/'; then
  vault secrets enable -path=storagebase kv-v2 >/dev/null
fi
vault kv put storagebase/fixture username="fixture" password="fixture-pass" >/dev/null
vault kv put storagebase/nested/deep key="deep-value" >/dev/null
vault kv list storagebase/ >/dev/null
