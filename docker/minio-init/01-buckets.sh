#!/bin/sh
# MinIO fixture seed (workstream B). Run by the minio-init sidecar in
# resources-compose.yml on every `up`, so everything below is idempotent:
# `mb --ignore-existing` and `cp` overwrites rather than creates.
#
# What exists afterwards, and why:
# - `fixture-blobs` — the bucket the s3 provider's live pass browses. One
#   bucket is enough: the tree's root level is the bucket list, and a second
#   bucket would only prove the same read twice.
# - `fixture-blobs/hello.txt` — the object download/preview paths read. Small
#   and text so a person can verify the bytes by eye.
# - `fixture-blobs/nested/dir/notes.md` — the object that proves prefix
#   delimiting: `nested/` must read as a folder, not as an object name.
set -eu

mc alias set fixture http://minio:9000 minioadmin minioadmin --api S3v4 >/dev/null
mc mb --ignore-existing fixture/fixture-blobs
printf 'hello storagebase\n' | mc pipe fixture/fixture-blobs/hello.txt
printf '# nested notes\n' | mc pipe fixture/fixture-blobs/nested/dir/notes.md
mc ls fixture/fixture-blobs --recursive
