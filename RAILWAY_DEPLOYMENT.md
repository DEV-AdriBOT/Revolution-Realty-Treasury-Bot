# Deploying Revolution Realty on Railway

This guide deploys the complete Revolution Realty Discord and Treasury system
to Railway. It is written for the project owner and assumes no prior Railway
experience.

The finished Railway project contains:

- one application service named `Revolution-Realty-Treasury-Bot` built from
  this GitHub repository;
- one private PostgreSQL service;
- one HTTPS domain for Treasury webhooks, health checks and single-use account
  connection pages.

Keep exactly one application replica. Running two finance workers could create
duplicate real-money operations.

## Current client project: exact activation walkthrough

Use this section when the developer has already created the Railway project and
the client only needs to add their credentials.

1. Open the Railway project.
2. On the project canvas, click the container named
   **Revolution-Realty-Treasury-Bot**. Do not click `Revolution-Realty-Bot`,
   `sincere-growth` or `Postgres`.
3. In the service navigation, click the **Variables** tab.
4. Click **New Variable** for each missing value, or click an existing variable
   row to edit it. Enter the following client-controlled values:

   | Variable | What the client enters |
   |---|---|
   | `DISCORD_TOKEN` | Newly regenerated Discord bot token |
   | `TREASURY_BUSINESS_TOKEN` | Revolution Realty BUSINESS Treasury token |
   | `DC_API_TOKEN` | DemocracyCraft API token used by IGN verification |
   | `VERIFY_ACCOUNT_ID` | Verification account ID used by the existing Discord verification flow |
   | `REALTY_PLUGIN_SYSTEM` | Exact value taken from a genuine confirmed Realty posting |

5. Never send these values through Discord, GitHub, a ticket or a normal chat.
   Enter them directly into Railway. Use the variable three-dot menu to
   **Seal** the Discord and Treasury tokens after saving.
6. Leave `FINANCE_MODE=disabled` while entering the credentials. Review the
   staged changes and click the pink **Deploy** button at the top of Railway.
7. Open **Deployments**, wait for the newest deployment to show **Active**, and
   open **View logs**. Confirm that the log contains both the internal HTTP
   listener and the Discord login message. A secret value must never appear in
   the log.
8. Check the public endpoints:

   ```text
   https://revolution-realty-treasury-bot-production.up.railway.app/healthz
   https://revolution-realty-treasury-bot-production.up.railway.app/readyz
   ```

   Both must return HTTP 200. `/readyz` must return
   `{"ok":true,"missing":[]}`.
9. In Discord, run `/setup`, then
   `/finance account account_id:120294`. The second command validates that the
   BUSINESS token owns the active account and registers its signed webhook.
10. Have Servalot and summerock verify their Minecraft accounts and run
    `/finance connect`. Each owner enters their PERSONAL token only on the
    private, single-use HTTPS page. PERSONAL tokens never belong in Railway.
11. Run `/finance connections`, `/finance status` and `/finance reconcile`.
    Confirm the two personal connections, account `120294`, no reconciliation
    mismatch and no unexpected classified posting.
12. Trigger one genuine low-value Realty event while finance remains disabled.
    Confirm its signature, exact memo, account direction and `pluginSystem`.
    Ambiguous or unmatched activity must remain unclassified.
13. Return to **Revolution-Realty-Treasury-Bot → Variables**, edit
    `FINANCE_MODE` from `disabled` to `live`, save and click **Deploy**. Do this
    only after every previous check passes.
14. Immediately run `/finance status` again. Keep
    `/finance emergency-disable confirm:DISABLE` available as the kill switch.

The old `Revolution-Realty-Bot` service is not a dependency after
`DISCORD_TOKEN` and `VERIFY_ACCOUNT_ID` contain real values in the Treasury
service. A Railway workspace administrator may then delete the old service and
its old volume. Never delete `Revolution-Realty-Treasury-Bot`, `Postgres` or
`sincere-growth`.

## 1. Before starting

Have the following ready:

- access to the Railway workspace;
- access to the Discord Developer Portal for the bot;
- the public GitHub repository
  `DEV-AdriBOT/Revolution-Realty-Treasury-Bot`;
- a newly reset Discord bot token;
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
3. Rename the service to `Revolution-Realty-Treasury-Bot`.
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

## 4. Storage for this fresh installation

This client installation starts with a clean PostgreSQL database and does not
import the obsolete bot's `data.json`. Financial and Discord state is stored in
PostgreSQL. Do not attach the old `revolution-realty-bot-volume` to the Treasury
service.

Keep the `Postgres` volume created by Railway. Configure Railway PostgreSQL
backups before enabling real money movement.

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
| `PGSSLMODE` | `disable` for Railway private networking | Yes |
| `DISCORD_TOKEN` | Leave absent until the client enters a newly reset token | Yes to start Discord |
| `ENABLE_MESSAGE_CONTENT_INTENT` | `true` when the Discord intent is enabled; otherwise `false` | Yes |
| `FINANCE_MODE` | `disabled` | Yes for the first deployment |
| `PUBLIC_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` or the final custom HTTPS origin | Yes |
| `TREASURY_BASE_URL` | `https://api.democracycraft.net/economy` | Yes |
| `TOKEN_ENCRYPTION_ACTIVE_VERSION` | `v1` | Yes |
| `TOKEN_ENCRYPTION_KEYS` | `v1:<32-byte-base64-key>` | Yes |
| `DATA_DIR` | `/tmp/revolution-realty` | Yes |
| `BACKUP_DIR` | `/tmp/revolution-realty/backups` | Yes |
| `DB_POOL_SIZE` | `8` | Recommended |
| `PORT` | `3000` | Yes for the current generated domain target |

Generate the encryption key on a trusted computer:

```sh
openssl rand -base64 32
```

Prefix the generated value with `v1:` when entering
`TOKEN_ENCRYPTION_KEYS`. Seal `DISCORD_TOKEN` and `TOKEN_ENCRYPTION_KEYS` from
their three-dot menus after saving them. A sealed value cannot be read back
from the Railway UI or API.

Do not add `POSTGRES_PASSWORD` to the application service; it is only used by
the local Docker Compose setup.

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

## 8. Initialise the fresh Discord installation

This deployment deliberately does not migrate the obsolete bot's state. Run
`/setup` in the target Discord server and confirm the manager roles, private
finance/audit channel, tickets, listings, contracts and verification flows.
Then verify the real shareholder accounts before importing properties.

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
   disabled. Startup writes the verified value to guild finance
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

## 10. Enable financial processing

This client rollout moves directly from `disabled` to `live`. Disabled mode
still receives and persists events without executing transfers, so use it to
complete the preflight rather than enabling money movement blindly.

1. While still disabled, run `/finance reconcile` and compare Treasury
   postings with the real account history.
2. Verify a genuine signed webhook, replay deduplication, transaction-feed
   recovery, the exact Realty memo and the exact `pluginSystem`.
3. Confirm account `120294`, ownership snapshots, refund matching, reserve
   accounting, encrypted PERSONAL connections and restart recovery.
4. Set `FINANCE_MODE=live` and deploy only after all checks pass.
5. Run `/finance status`, confirm that the database and process both report
   `live`, and monitor the first real rental through its seven-day hold and
   payout.

At any time, `/finance emergency-disable confirm:DISABLE` latches the emergency
stop in PostgreSQL while webhooks and reconciliation continue recording events.
If Discord is unavailable, set `FINANCE_MODE=disabled` in Railway and deploy the
change.

## 11. Backups and updates

Configure Railway backups for the PostgreSQL service. Use daily, weekly and
monthly schedules appropriate to the account plan, and periodically test a
restore into a separate recovery database. Keep at least one encrypted
off-platform PostgreSQL dump. Financial records are reversed through status and
ledger entries, never removed manually.

Each push to `main` triggers a new application deployment. Before accepting an
update:

1. confirm GitHub Actions is green;
2. create a database backup;
3. keep the application at one replica;
4. deploy and wait for `/readyz` to pass;
5. run `railway ssh -- npm run migrate:check`; and
6. verify Discord connectivity and finance mode after restart.

Railway performs deployment health checks before routing traffic. A short
restart interruption during a deployment is expected.

## 12. Common failures

### `/readyz` returns 503

Read the `missing` array. Check `DATABASE_URL`, `PUBLIC_BASE_URL`, the database
service health and, outside disabled mode, the Treasury/encryption variables and
guild finance configuration.

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
