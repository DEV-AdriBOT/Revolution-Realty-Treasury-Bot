# Revolution Realty finance operations

## Safety model

`FINANCE_MODE` is the kill switch:

- `disabled`: HTTP, Discord and incoming-event persistence run; any proposed transfer remains non-executable and the live worker is stopped.
- `shadow`: signed events and feed postings are imported and proposed operations are recorded as `SHADOW`; no transfer is sent.
- `live`: the single worker may execute transactionally claimed operations.

Change mode in the deployment secret file and restart the app. Never edit operation rows to bypass the state machine. A posting remains importable while transfers are disabled.

For an immediate stop, a manager runs `/finance emergency-disable
confirm:DISABLE`. This latches `emergency_disabled` in PostgreSQL, stops new work
claims within one worker tick, and survives restarts even if the environment
still says `live`. Webhooks and feed reconciliation continue. Clearing it with
`/finance clear-emergency confirm:CLEAR` leaves finance disabled; inspect the
incident and restart with the intended server-side mode to resume.

## First deployment

1. Back up the old Railway volume and `data.json` before migration. If access is unavailable, do not claim migration completion and do not enable finance.
2. Set a random PostgreSQL password and AES-256 key in `.env` with mode `0600`.
3. Start with `docker compose up -d --build`; migrations run before the process starts.
4. Confirm `/healthz`, `/readyz`, the Discord commands, database health, and restart recovery.
5. Run `npm run properties:preview`. Only run `properties:apply` after verified Servalot and summerock shareholder records exist. Imported properties remain disabled; C193/C194 remain `REVIEW_REQUIRED`.

Enable the Discord Developer Portal `Message Content Intent` and set `ENABLE_MESSAGE_CONTENT_INTENT=true` to retain the raid guard. A test bot may use `false` for slash-command-only testing; the startup log states that automod is inactive.

## Shareholder connections and revocation

A verified shareholder runs `/finance connect` and receives an ephemeral, single-use 10-minute HTTPS URL. The submitted token must be PERSONAL and its `ownerUuid` must equal the stored verified UUID. The bot registers a Treasury webhook and stores token and webhook secret as AES-256-GCM ciphertext.

For rotation, run `/finance connect` again with the replacement key. The new
key/webhook commit atomically before the old subscription is disabled; remote
cleanup is best effort. For disconnection, the bot deletes the remote webhook
when reachable, erases all encrypted credential fields and instructs the
shareholder to revoke the old key in-game. Treasury auth metadata does not expose
the original issuance timestamp, so the displayed 180-day deadline is a
conservative estimate from connection time; rotate earlier if the in-game key
screen shows an earlier expiry.

## Business account changes

Use `/finance account account_id:<id>`. The bot calls `GET /api/v1/firms/me/accounts` with the BUSINESS key and rejects archived or foreign accounts. New events use the selected account. Rentals and monetary operations already created retain their original source/custody account.

## Ownership

Use `/property ownership` with the full replacement split. The command rejects totals other than exactly 100%, previews old and new allocations, and requires confirmation. Confirmation creates an immutable ownership version. Existing rentals/refunds retain their snapshot.

## Refund reserve and landlord funding

Refund reimbursements are prioritized oldest-first. If Treasury reports
insufficient balance, the oldest reimbursement remains unpaid, blocks newer
reimbursements, alerts once per day and retries on a bounded schedule with the
same idempotency key.

For a manual contribution, deposit into the active business account, reconcile,
locate the exact positive item in `unclassified_transactions`, then run
`/finance reserve-deposit posting_id:<internal-id>`. This atomically resolves
that posting into the refund-reserve ledger and cannot be applied twice.

If a refund is `REVIEW_REQUIRED`, inspect compatible rental IDs in `/finance
holds` and use `/finance match-refund refund_id:<id> rental_id:<id>`. The command
rechecks property, landlord snapshot, settlement order and remaining refundable
amount under a serializable transaction before creating any reimbursement.

For the pre-refund edge case, use `/finance fund-landlord` with a unique manager reference. Reusing the reference is rejected by the database and retries reuse the same Treasury idempotency key.

## Reconciliation

`/finance reconcile` consumes each connected account feed from its exact int64
cursor, including old custody accounts still referenced by unfinished work.
Every business posting is imported. Unknown activity appears in
`unclassified_transactions` and never alters distributable funds. Daily balance
baselines compare Treasury balance plus imported posting totals; mismatches and
inactive/failing webhooks alert the private finance channel. A missing or
unverified Realty `pluginSystem` deliberately leaves Realty-shaped memos
unclassified.

## Leaseholds

`/leasehold create` binds a property to an exact payer UUID, amount, interval and unique reference. A payment is accepted only when incoming, exact amount, exact reference and exact payer all match. It is posted entirely to company retained revenue. Update affects future billing; close retains all history.

## Backup and rollback

Run `scripts/backup.sh` from an environment containing `pg_dump`, `DATABASE_URL` and the backup volume. Verify with `scripts/restore-check.sh`. Keep the pre-migration `data.json` and contract files separately.

Application rollback: set `FINANCE_MODE=disabled`, deploy the previous image/commit, and keep the PostgreSQL/legacy volumes mounted read-only until diagnosis. Database rollback is restore-forward into a fresh database; financial/audit rows are never deleted in place.

## Incident response

1. Run `/finance emergency-disable confirm:DISABLE`. If Discord is unavailable,
   set `FINANCE_MODE=disabled` and restart the app.
2. Preserve incoming webhook/feed data and database volumes.
3. Capture operation IDs, statuses and Treasury transaction IDs without Authorization headers.
4. Reconcile before retrying. `UNKNOWN` means Treasury may have accepted the request; retry only through the same stored operation/idempotency key.
5. Revoke affected Treasury keys and rotate AES keys by adding a new version, re-encrypting records, then retiring the old version only after no rows reference it.
