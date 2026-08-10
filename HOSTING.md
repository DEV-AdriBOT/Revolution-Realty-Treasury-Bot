# Self-hosting guide

This deployment uses Docker Compose, PostgreSQL and an existing HTTPS reverse
proxy. Keep a single live finance worker unless database-locking behavior has
been revalidated for additional replicas.

## Requirements

- Linux server with Docker Engine and the Compose plugin
- a DNS name with a valid HTTPS certificate
- Discord bot application with the `bot` and `applications.commands` scopes
- PostgreSQL storage that is backed up independently of the application image
- Node.js is not required on the host because the image pins Node 22

## Install

```sh
git clone https://github.com/DEV-AdriBOT/Revolution-Realty-Treasury-Bot.git
cd Revolution-Realty-Treasury-Bot
cp .env.example .env
chmod 600 .env
```

Fill `.env` locally on the server. Never paste Treasury or Discord tokens into
Discord, GitHub issues, command arguments or logs. Generate a random PostgreSQL
password and a 32-byte base64 AES key. Start with:

```dotenv
FINANCE_MODE=disabled
PUBLIC_BASE_URL=https://example.com/realty
TOKEN_ENCRYPTION_ACTIVE_VERSION=v1
TOKEN_ENCRYPTION_KEYS=v1:<base64-key>
```

Then start and verify:

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:3020/healthz
curl --fail http://127.0.0.1:3020/readyz
docker compose run --rm app npm run migrate:check
```

The application port is bound only to `127.0.0.1:3020`. Publish it through an
HTTPS reverse proxy; do not expose PostgreSQL publicly.

## Nginx path example

Inside the existing TLS virtual host:

```nginx
location /realty/ {
    proxy_pass http://127.0.0.1:3020/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Validate before reloading:

```sh
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://example.com/realty/readyz
```

`PUBLIC_BASE_URL` must exactly match that externally reachable HTTPS path so
Treasury webhook and single-use connection URLs are correct.

If the hostname does not already have a valid certificate, install Certbot and
let its Nginx plugin create/renew one:

```sh
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d realty.example.com
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

When `/realty` is only a path on an already-certified hostname, reuse that
certificate; certificates are issued for hostnames, not URL paths. Never expose
port 3020 or PostgreSQL through the router.

## Initial Discord setup

Invite the bot with `bot applications.commands`. It needs Manage Roles, Manage
Channels and Manage Server for automatic setup, plus normal message/thread
permissions. On joining, it creates the required private staff channels and
registers guild slash commands. Verify `/finance status` reports `disabled`.

If the optional raid guard is required, enable Message Content Intent in the
Discord Developer Portal and set `ENABLE_MESSAGE_CONTENT_INTENT=true`.

## Safe financial activation

1. Keep `FINANCE_MODE=disabled` while restoring legacy data and checking Discord.
2. Install the BUSINESS key only in `.env`; validate account `120294` using
   `/finance account`.
3. Have each verified landlord use the ephemeral `/finance connect` HTTPS flow.
4. Set `FINANCE_MODE=shadow`, restart, and reconcile real postings.
5. Confirm the exact Realty `pluginSystem` from genuine transactions and set
   `REALTY_PLUGIN_SYSTEM`.
6. Exercise signed webhook delivery, replay deduplication, feed recovery and
   low-value idempotent transfers.
7. Set `FINANCE_MODE=live` only when shadow and Treasury agree.

Changing mode requires editing the server-side `.env` and rebuilding/restarting
the app. Incoming data remains durable while the live worker is disabled.

## Updates

```sh
git fetch --all --prune
git checkout main
git pull --ff-only
npm ci
npm test
npm run lint
docker compose up -d --build app
docker compose run --rm app npm run migrate:check
curl --fail https://example.com/realty/readyz
```

Never delete a migration or edit a migration already applied in production.

## Backup and restore

The `db-tools` profile pins its client to the same PostgreSQL 16 image as the
database and mounts `/backups`:

```sh
docker compose run --rm db-tools sh /scripts/backup.sh
docker compose run --rm -e RECOVERY_DATABASE_URL='postgresql://recovery-user@recovery-host/recovery-db' db-tools sh /scripts/restore-check.sh /backups/postgres-YYYYMMDDTHHMMSSZ.sql.gz
```

Create the recovery database separately and pass its URL only for the restore
test. The script refuses to use the source URL. Copy verified archives off-host;
keep the original Railway `data.json`/contract source and PostgreSQL backups
outside Docker volumes as well.

For an incident, set `FINANCE_MODE=disabled`, restart the app, preserve the
database and logs, and reconcile `UNKNOWN` operations using their existing
idempotency keys. Full operating procedures are in `OPERATIONS.md`; recovery is
in `ROLLBACK.md`.
