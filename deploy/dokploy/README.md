# StorageBase Studio on Dokploy

[Dokploy](https://dokploy.com) ([Dokploy/dokploy](https://github.com/Dokploy/dokploy))
is a self-hosted, open-source deployment platform (an alternative to Heroku,
Vercel, and Netlify) that runs Docker Compose services behind Traefik and
installs apps from a built-in template catalog with one click.

StorageBase Studio is listed in the official

[Dokploy template catalog](https://templates.dokploy.com)
[StorageBase Studio Dokploy Template](https://templates.dokploy.com/?q=storagebase+studio)

(merged in [Dokploy/templates#931](https://github.com/Dokploy/templates/pull/931)).

The canonical blueprint lives in the Dokploy templates repo at
[`blueprints/storagebase-studio/`](https://github.com/Dokploy/templates/tree/main/blueprints/storagebase-studio)
(`docker-compose.yml` + `template.toml`); this folder is a documentation mirror,
not the source of truth.

> Tracking issue: [storagebase-studio#171](https://github.com/storagebase/storagebase-studio/issues/171)

## Install

From a running Dokploy instance (see the
[Dokploy install docs](https://docs.dokploy.com/docs/core/installation) to set
one up):

1. **Open your Dokploy dashboard** → create or pick a project → **Create
   Service → Template**.
2. **Search** for **StorageBase Studio**.
3. **Deploy.** Dokploy auto-generates `ADMIN_PASSWORD`, `USER_PASSWORD`, and
   `JWT_SECRET` from the template's variable definitions (`${password:32}` /
   `${password:64}`) — no manual secret entry is needed.
4. **Assign a domain** (the template maps the service's port `3000`), then open
   the app.

## What the blueprint does

- Runs the prebuilt `ghcr.io/storagebase/storagebase-studio` image (pinned tag, never
  `:latest`) as a single container on HTTP port `3000`.
- Persists saved connections & settings with **SQLite**
  (`STORAGE_PROVIDER=sqlite`) on a named Docker volume (`storagebase-data`) mounted
  at `/app/data`, surviving restarts and redeploys — no external database
  required.
- Generates unique per-install credentials at deploy time via Dokploy template
  variables, so no two installs share a password and nothing is baked into the
  image.

## First login

Open the app's domain and log in:

- **Admin** (full access incl. maintenance tools): `admin@storagebase.org` + the
  generated `ADMIN_PASSWORD` (visible in the service's Environment tab).
- **User** (query execution only): `user@storagebase.org` + the generated
  `USER_PASSWORD`.

## Environment variables

See the [main README environment table](../../README.md#environment-variables)
for the full list. The blueprint sets the minimum for a working deploy
(`ADMIN_EMAIL`/`ADMIN_PASSWORD`, `USER_EMAIL`/`USER_PASSWORD`, `JWT_SECRET`,
`STORAGE_PROVIDER=sqlite`, `STORAGE_SQLITE_PATH`); optional AI (`LLM_*`) and
OIDC (`OIDC_*`) settings can be added in the service's Environment tab.

## Keeping the listing fresh

The blueprint pins an image tag, so it does not track our releases
automatically. Maintenance procedure:

1. On security patches and notable feature releases, open a small PR against
   [Dokploy/templates](https://github.com/Dokploy/templates) bumping the
   `image:` tag in `blueprints/storagebase-studio/docker-compose.yml` to the
   current release.
2. The env contract above is version-stable, so a tag bump is normally the
   only change needed.
3. Track the currently pinned tag against
   [our releases](https://github.com/storagebase/storagebase-studio/releases) when
   preparing release notes.
