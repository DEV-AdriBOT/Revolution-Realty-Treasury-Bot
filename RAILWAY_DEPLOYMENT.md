# Deploying Revolution Realty on Railway

This guide deploys the complete Revolution Realty Discord and Treasury system
to Railway. It is written for the project owner and assumes no prior Railway
experience.

The finished Railway project contains:

- one application service built from this GitHub repository;
- one private PostgreSQL service;
- one persistent application volume for legacy Discord state and backups; and
- one HTTPS domain for Treasury webhooks, health checks and single-use account
  connection pages.

Keep exactly one application replica. Railway volumes do not support replicas,
and running two finance workers against different databases could create
duplicate real-money operations.

## 1. Before starting

Have the following ready:

- access to the Railway workspace;
- access to the Discord Developer Portal for the bot;
- the public GitHub repository
  `DEV-AdriBOT/Revolution-Realty-Treasury-Bot`;
- a newly reset Discord bot token;
- the backed-up legacy `data.json`, if this is replacing an existing bot;
- the Revolution Realty BUSINESS Treasury key; and
- access for Servalot and summerock to connect their PERSONAL Treasury keys.

Do not paste any Discord or Treasury token into Discord, GitHub, a deployment
log, a command argument or this repository. Railway variables containing
tokens or encryption material must be sealed after they are entered.

If another copy of the bot is running, leave Railway in
`FINANCE_MODE=disabled`. Do not run both copies with live finance enabled.

## 2. Create the project and PostgreSQL service

1. Sign in to [Railway](https://railway.com/) and select **New Project**.
2. Select **Empty Project**.
3. On the project canvas, select **New** and then **Database → PostgreSQL**.
4. Rename the database service to `Postgres` so the variable reference used
   below is easy to recognise.
5. Keep PostgreSQL private. Do not add Public Networking or a TCP proxy unless
   it is temporarily required for a controlled import.
6. Confirm the PostgreSQL major version. This release is tested against
   PostgreSQL 16. Do not change the major version of an existing database
   without a backup and a migration/integration test.

Railway exposes the database's private `DATABASE_URL` to other services through
a reference variable. The password never needs to be copied into this repo.

## 3. Add the bot service from GitHub

1. Select **New → GitHub Repo**.
2. Choose `DEV-AdriBOT/Revolution-Realty-Treasury-Bot`.
3. Rename the service to `Revolution-Realty-Bot`.
4. In **Settings → Source**, confirm the branch is `main`.
5. Do not set a custom build or start command. Railway detects the root
   `Dockerfile`; its normal start command applies all SQL migrations before the
   bot connects.
6. Under **Deploy**, configure:
   - **Healthcheck Path:** `/readyz`
   - **Healthcheck Timeout:** `300`
   - **Restart Policy:** `Always` on a paid plan, or `On Failure` when `Always`
     is unavailable
   - **Replicas:** `1`

Do not configure a pre-deploy migration command. Railway volumes are unavailable
during pre-deploy, while the repository's start command already runs migrations
safely at process startup.

## 4. Attach persistent storage

The bot keeps imported non-financial Discord state and timestamped legacy
backups under `/data`. Railway's normal container filesystem is temporary, so a
volume is required.

1. Open the application service.
2. Select **Settings → Volumes → Add Volume**.
3. Mount the volume at `/data`.
4. Keep the application at one replica. Railway does not allow replicas on a
   service with a volume.

The image normally runs as the unprivileged `node` user, while Railway mounts
volumes as `root`. The variable `RAILWAY_RUN_UID=0` in the next section is
therefore required for this deployment. Do not expose the application volume
over the public network.

If this is a new database that must import an existing `data.json`, upload the
backed-up file to the volume as `/data.json` **before the application's first
successful start**:

```sh
railway volume browse /
```

The application sees the uploaded file as `/data/data.json`, creates a
timestamped backup and imports it into PostgreSQL on first start. If the
application has already created an empty `legacy_state` row, stop and use a
fresh recovery database or an operator-reviewed import. Do not overwrite files
or delete database rows in an attempt to force the import.

## 5. Create the HTTPS domain

1. Open **Settings → Networking → Public Networking** on the application
   service.
2. Select **Generate Domain**.
3. Confirm the generated domain targets the port provided by Railway. The bot
   listens on Railway's injected `PORT` value.

The generated `*.up.railway.app` domain includes managed HTTPS. Certbot is not
needed.

For a custom domain, select **Custom Domain** and add both DNS records Railway
shows: the `CNAME` and the ownership-verification `TXT`. Railway provisions the
certificate after verification. Choose the final hostname before registering
Treasury webhooks.

## 6. Configure application variables

Open the application service's **Variables** tab. Add the variables below.
Use Railway's autocomplete when inserting reference variables.

| Variable | Value or source | Required |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Yes |
| `PGSSLMODE` | `require` | Yes |
| `DISCORD_TOKEN` | A newly reset bot token | Yes |
| `ENABLE_MESSAGE_CONTENT_INTENT` | `true` when the Discord intent is enabled; otherwise `false` | Yes |
| `FINANCE_MODE` | `disabled` | Yes for the first deployment |
| `PUBLIC_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` or the final custom HTTPS origin | Yes |
| `TREASURY_BASE_URL` | `https://api.democracycraft.net/economy` | Yes |
| `TOKEN_ENCRYPTION_ACTIVE_VERSION` | `v1` | Yes |
| `TOKEN_ENCRYPTION_KEYS` | `v1:<32-byte-base64-key>` | Yes |
| `DATA_DIR` | `/data` | Yes |
| `BACKUP_DIR` | `/data/backups` | Yes |
| `RAILWAY_RUN_UID` | `0` | Yes with the application volume |
| `DB_POOL_SIZE` | `8` | Recommended |

Generate the encryption key on a trusted computer:

```sh
openssl rand -base64 32
```

Prefix the generated value with `v1:` when entering
`TOKEN_ENCRYPTION_KEYS`. Seal `DISCORD_TOKEN` and `TOKEN_ENCRYPTION_KEYS` from
their three-dot menus after saving them. A sealed value cannot be read back
from the Railway UI or API.

Do not add `POSTGRES_PASSWORD` to the application service; it is only used by
the local Docker Compose setup. Do not manually define `PORT`; Railway injects
it for the deployment and health check.

The following variables are added only when their real values are available:

| Variable | Purpose |
|---|---|
| `TREASURY_BUSINESS_TOKEN` | Revolution Realty BUSINESS key; seal immediately |
| `REALTY_PLUGIN_SYSTEM` | Exact value verified from a genuine Realty posting |
| `DC_API_TOKEN` | Optional legacy IGN verification reader |
| `VERIFY_ACCOUNT_ID` | Account used by optional micropayment IGN verification |

Never guess `REALTY_PLUGIN_SYSTEM`. Without an exact verified value,
Realty-shaped postings remain unclassified and cannot move money.

Review the staged changes, then select **Deploy**.

## 7. Verify the disabled deployment

Wait for the deployment to become **Active**. The logs should show all SQL
migrations applied, the HTTP server listening and the Discord client connected.
Do not ignore a failed migration or readiness check.

Open these URLs in a browser:

```text
https://<railway-domain>/healthz
https://<railway-domain>/readyz
```

Expected responses:

```json
{"ok":true}
```

```json
{"ok":true,"missing":[]}
```

In Discord, run `/finance status`. It must report `disabled`. Confirm the
ticket panel, private staff channels, listings, contracts and verification
commands are present before doing any Treasury configuration.

For an additional migration check, install the Railway CLI, link the project
and run the command inside the deployed container:

```sh
railway ssh -- npm run migrate:check
```

## 8. Verify or restore existing bot data

Skip this section for a completely new Discord installation. Keep finance
disabled and prevent users from changing tickets or contracts during the
migration.

For a first-time `data.json` import, follow the upload instructions in section
4 before the first successful application start. Then run:

```sh
railway ssh -- npm run legacy:import
```

The command must report that legacy state is ready. Check representative guild
settings, tickets, contracts, verification records and listings in Discord.
Preserve the original `data.json` separately, record its SHA-256 hash and do not
delete it after import.

If PostgreSQL is being moved from another production deployment, restore a
verified PostgreSQL backup into the new `Postgres` service before the first
application start. This is the correct path when the source already contains
financial or imported legacy state. Do not seed properties again after
restoring an existing database. Keep the source deployment transfer-disabled
until database counts, migrations and representative records match.

## 9. Configure Discord and Treasury

1. In the Discord Developer Portal, enable **Message Content Intent** if
   `ENABLE_MESSAGE_CONTENT_INTENT=true`.
2. Invite the bot with the `bot` and `applications.commands` scopes. Grant the
   documented role, channel, thread and message permissions.
3. Add and seal `TREASURY_BUSINESS_TOKEN` in Railway.
4. Redeploy while `FINANCE_MODE=disabled`.
5. Use `/finance account account_id:120294`. The bot validates that the account
   is active and belongs to the authenticated firm before saving it and
   registering the firm webhook.
6. Have Servalot and summerock run `/finance connect`. Each person receives an
   ephemeral one-time HTTPS link and enters their PERSONAL key there, never in
   Discord.
7. Confirm `/finance connections` shows the expected owners and expiry state.
8. Identify the exact Realty `pluginSystem` from genuine postings, set it as
   Railway's `REALTY_PLUGIN_SYSTEM` variable and redeploy while finance remains
   disabled or shadowed. Startup writes the verified value to guild finance
   configuration.
9. On a fresh database, run `railway ssh -- npm run properties:preview` and
   review the complete initial ownership import. After the two connected
   shareholder identities are correct, run
   `railway ssh -- npm run properties:apply`. Enable approved properties with
   `/property enable`; C193 and C194 remain `REVIEW_REQUIRED` until a manager
   confirms their merge outcome.

If `PUBLIC_BASE_URL` changes after webhooks have been registered, do not assume
they followed the new domain. Re-register the business account webhook and have
connected shareholders rotate/reconnect their personal integrations.

## 10. Enable financial processing safely

The application is complete, but real-money execution must be enabled against
real external accounts deliberately.

1. Set `FINANCE_MODE=shadow` and deploy.
2. Run `/finance reconcile` and compare the imported Treasury postings,
   ownership snapshots and proposed operations with the real account history.
3. Verify a signed webhook, a replayed delivery, transaction-feed recovery and
   a low-value transfer using the stored idempotency key.
4. Confirm refund matching, reserve accounting and restart recovery.
5. Set `FINANCE_MODE=live` only when the shadow ledger and Treasury results
   agree.
6. Monitor the first real rental through its seven-day hold and payout.

At any time, `/finance emergency-disable confirm:DISABLE` latches the emergency
stop in PostgreSQL while webhooks and reconciliation continue recording events.
If Discord is unavailable, set `FINANCE_MODE=disabled` in Railway and deploy the
change.

## 11. Backups and updates

Configure Railway backups for both the PostgreSQL service and the application
volume. Use daily, weekly and monthly schedules appropriate to the account plan,
and periodically test a restore into a separate recovery database. Keep at
least one encrypted off-platform copy of the legacy source and PostgreSQL dump.

Never wipe or delete a Railway volume as a cleanup operation: deleting a volume
also deletes its backups. Financial records are reversed through status and
ledger entries, never removed manually.

Each push to `main` triggers a new application deployment. Before accepting an
update:

1. confirm GitHub Actions is green;
2. create database and volume backups;
3. keep the application at one replica;
4. deploy and wait for `/readyz` to pass;
5. run `railway ssh -- npm run migrate:check`; and
6. verify Discord connectivity and finance mode after restart.

Railway performs deployment health checks before routing traffic. Because the
application uses a persistent volume, a short restart interruption during a
deployment is expected.

## 12. Common failures

### `/readyz` returns 503

Read the `missing` array. Check `DATABASE_URL`, `PUBLIC_BASE_URL`, the database
service health and, outside disabled mode, the Treasury/encryption variables and
guild finance configuration.

### `EACCES` or failure writing `/data`

Confirm the volume mount is `/data` and `RAILWAY_RUN_UID=0` is present. Redeploy
after correcting it.

### The domain returns 404

Confirm Public Networking targets the bot's Railway `PORT`. For a custom domain,
both the `CNAME` and Railway-provided verification `TXT` record must exist.

### The bot is online twice or commands behave inconsistently

Stop the older deployment. Keep one production Discord process and one live
finance worker.

### A Treasury request timed out

Do not create a new operation or idempotency key. Reconcile first and retry only
through `/finance retry`, which reuses the persisted workflow identity.

## Railway references

- [Services and GitHub sources](https://docs.railway.com/services)
- [PostgreSQL on Railway](https://docs.railway.com/databases/postgresql)
- [Variables, references and sealed secrets](https://docs.railway.com/variables)
- [Public and custom domains](https://docs.railway.com/networking/domains/working-with-domains)
- [Health checks](https://docs.railway.com/deployments/healthchecks)
- [Persistent volumes](https://docs.railway.com/volumes)
- [Volume backups](https://docs.railway.com/volumes/backups)
- [Railway SSH](https://docs.railway.com/cli/ssh)

For bot-specific operation and recovery procedures, also read
[OPERATIONS.md](OPERATIONS.md) and [ROLLBACK.md](ROLLBACK.md).
