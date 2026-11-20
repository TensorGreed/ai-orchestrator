---
title: "Install L2M with Docker"
description: "Run L2M on your own machine with Docker in two commands: published images, SQLite in a volume, a generated master key and admin password. No Node.js."
---

# Install with Docker

L2M runs as two containers: the API and the studio (the web UI, which also forwards the API's routes). You need
Docker with Compose v2 (Docker Desktop, or Docker Engine with the compose plugin) on Linux, macOS or Windows,
amd64 or arm64. You do not need Node.js. On Windows, run the commands below in WSL or Git Bash (in PowerShell,
`curl` is a different command; use `curl.exe` for the two-command install).

## The installer

```bash
curl -fsSL https://lsquarem.com/install.sh | sh
```

It checks Docker and Compose, downloads the release's `docker-compose.quickstart.yml` into `./l2m/docker-compose.yml`,
starts it, waits until the studio answers and prints how to sign in:

```text
L2M is running: http://localhost:8080
Sign in with
  email:    admin@l2m.local
  password: <generated>
```

It never uses `sudo` and sends nothing anywhere apart from the downloads (GitHub and the image registry). Read it
first at [lsquarem.com/install.sh](https://lsquarem.com/install.sh) if you like. Run it again to restart with the
same data. Optional settings, as environment variables before `sh`:

| Variable | Default | |
|---|---|---|
| `L2M_VERSION` | the release installed before, else `v0.1.0` | Release tag to install, such as `v0.1.0`. A re-run never moves an install back to an older release unless you name one. |
| `L2M_DIR` | `./l2m` | Folder for the compose file. |
| `L2M_PORT` | `8080` | Port of the studio on this machine. |
| `L2M_PULL` | `always` | `missing` uses images you already have. |

For example: `curl -fsSL https://lsquarem.com/install.sh | L2M_PORT=9000 sh`.

## Without the installer (two commands)

In an empty folder:

```bash
curl -fsSL https://raw.githubusercontent.com/TensorGreed/l2m/v0.1.0/docker-compose.quickstart.yml -o docker-compose.yml
docker compose up -d
```

Open `http://localhost:8080`. The admin password is printed once in the log, in a framed block:

```bash
docker compose logs api
```

## What the first start does

- **Master key.** Stored secrets are encrypted with `SECRET_MASTER_KEY_BASE64`. If you do not set it, the first
  start makes a random 32-byte key and keeps it in the data volume (`quickstart/master-key`, readable only inside the
  container). It is never printed. **Back up the volume**: without that key, saved secrets cannot be read. The key
  then sits next to the secrets it protects, so a copy of the volume opens them; for production, set your own
  `SECRET_MASTER_KEY_BASE64` and keep it apart from the data. If the volume holds a database but the key file is
  gone and no key is set, the API refuses to start rather than make a new key.
- **Admin account.** The first user is `admin@l2m.local` (or `BOOTSTRAP_ADMIN_EMAIL`). Without
  `BOOTSTRAP_ADMIN_PASSWORD`, a random password is made, printed once in the log and kept in
  `quickstart/initial-admin-password`. To read it again: `docker compose exec api cat /app/apps/api/data/quickstart/initial-admin-password`.
- **Database.** SQLite, in the `l2m-quickstart_l2m-data` volume. Public sign-up is off; invite people under **Settings → Users**.

To choose your own values, put them in a `.env` file next to `docker-compose.yml` before the first start:

```bash
SECRET_MASTER_KEY_BASE64=...   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
BOOTSTRAP_ADMIN_EMAIL=you@example.com
BOOTSTRAP_ADMIN_PASSWORD=...
```

Once data exists, keep the same master key: changing it makes the stored secrets unreadable.

## Settings

All optional, in `.env` or the shell:

| Variable | Default | |
|---|---|---|
| `L2M_VERSION` | the release of the file | Image tag, or `latest`. |
| `L2M_PORT` | `8080` | Studio port on this machine. |
| `L2M_BIND` | `127.0.0.1` | Address the port listens on. `0.0.0.0` opens it to your network: put HTTPS in front first, since sign-in cookies travel over plain HTTP otherwise. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | empty | Model keys. You can also add them as secrets in the studio. |
| `OLLAMA_BASE_URL` | empty | A local Ollama, for example `http://host.docker.internal:11434/v1`. |

Nothing else is needed for a first run: the starter templates on **Home** run without a model or a key. See
[Starter templates](./starter-templates.md) and [Build your first MCP agent](./build-your-first-mcp-agent.md).

## Upgrade, stop, remove

```bash
docker compose pull && docker compose up -d   # with L2M_VERSION=latest, or after setting a newer tag
docker compose stop                            # stop, keep the data
docker compose down -v                         # remove the containers and all data
```

Read the [changelog](https://github.com/TensorGreed/l2m/blob/main/CHANGELOG.md) before an upgrade; migrations run on
start. Back up first: [Backup and recovery](../operations/backup-and-recovery.md).

## Check the images

Every release image is signed and carries an SBOM and build provenance. The same images are on Docker Hub as
`lsquarem/l2m` and `lsquarem/l2m-web`. See [Verify a release](../operations/verify-a-release.md).

## Beyond one machine

- Postgres, several API replicas and a webhook tier: `docker-compose.prod.yml` in the repository, and
  [Postgres](../operations/postgres.md), [Scaling](../operations/scaling.md).
- Kubernetes: the Helm chart in `ops/helm/l2m`.
- From source, to change L2M itself (Node.js 24+, pnpm 10+): [Run from source](./run-from-source.md).
