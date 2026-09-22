# message-box-store operator runbook

One private standalone topology only: a single Node/Bun process against one
MySQL 8 database. No clustering, publication, backup automation, dashboards,
or multi-host deployment is covered here.

Retain only what this document lists. Active records use the enforced
`permanent` retention policy; expired body-free change rows may be purged by
the bounded cleanup pass. There is no finite active-record retention mode.

## Offline restore recovery drill

The database provider owns encrypted, access-controlled, transaction-consistent
backups. Keep the finite backup-retention date and deletion receipts outside the
backed-up database. The service is best-effort history storage: a restored image
cannot recover writes committed after that image, and permanent loss of the
wallet identity key makes ciphertext undecryptable.

For a rollback restore, keep the service offline and:

1. Restore a consistent MySQL image into a disposable or isolated target and
   run the ordinary migration/schema verification.
2. Prepare a receipt bundle containing the owner, the epoch found in the image,
   a new externally generated epoch, the backup and receipt-coverage instants,
   the finite backup-retention deadline, and every post-backup record deletion.
   Set `deletionReceiptsComplete` to `true` only after independently proving the
   receipt interval is complete. If that proof is unavailable, do not serve the
   restored database; discard it or keep it offline. A post-backup bulk deletion
   must be expanded into receipts for every record in the restored owner image;
   otherwise the completeness assertion is false and recovery must stop.

   ```json
   {
     "version": 1,
     "recoveryId": "restore_2026_09_22_a",
     "owner": "02...compressed identity key...",
     "restoredEpoch": "gen-4",
     "recoveryEpoch": "restore_2026_09_22_a",
     "deletionReceiptsComplete": true,
     "backupCreatedAt": "2026-09-22T00:00:00.000Z",
     "receiptsCompleteThrough": "2026-09-22T02:00:00.000Z",
     "backupRetentionUntil": "2026-10-22T00:00:00.000Z",
     "deletions": [
       { "recordKey": "...64 lowercase hex...", "deletedAt": "2026-09-22T01:00:00.000Z" }
     ]
   }
   ```
3. With the service still stopped, run:

   ```text
   MESSAGE_BOX_STORE_RECOVERY_ENABLED=1 bun run recover:restore -- receipts.json --confirm-service-offline
   ```

4. Confirm the command reports the new epoch and `postBackupWritesRecovered` as
   `false`. Restart the service only after this succeeds. Old cursors and writes
   then fail their epoch checks; clients must perform a complete snapshot.
5. Destroy the disposable drill database. Ensure encrypted backup media expires
   no later than the bundle's `backupRetentionUntil`; active deletion cannot
   erase bytes already retained in an older operator backup.

The command does not restore a database, discover missing receipts, generate an
epoch, contact wallets, or recover post-backup writes. It transactionally
reapplies the supplied record deletions, reinstalls their body-free tombstones,
invalidates restored snapshots and idempotency results, recalculates live quota,
and switches to the supplied epoch. Re-running the same recovery ID is safe.

The executable disposable drill is `bun run test:m4:mysql`. It proves that a
rollback would resurrect deleted ciphertext before fencing; the recovery step
removes it, preserves backup-resident inbound/outbound ciphertext, rejects a
stale writer, reports the post-backup loss boundary, and forces a second-device
replica through complete snapshot reconciliation.

## Prerequisites

- Bun 1.x (Node.js 22+ also works for the gate scripts)
- MySQL 8 with a dedicated database and user
- Environment variables (secrets from env only, never committed):

```bash
export MESSAGE_BOX_STORE_SERVER_SECRET='at-least-16-chars'
export MYSQL_HOST='127.0.0.1'
export MYSQL_PORT='3306'
export MYSQL_USER='mbs'
export MYSQL_PASSWORD='…'
export MYSQL_DATABASE='message_box_store'
export MESSAGE_BOX_STORE_HOST='127.0.0.1'   # optional, default 127.0.0.1
export MESSAGE_BOX_STORE_PORT='8080'         # optional, default 8080
```

Optional: a git-ignored `.env` file with the same keys is loaded by
`scripts/ops.mjs` when `dotenv` is installed.

## Install and build

```bash
bun install --frozen-lockfile
bun run build
```

## Configuration validation

```bash
bun run config:check
```

Prints one redacted JSON line (`status: "ok"`) with non-secret effective
bounds (retention, version, admission, rates, pool, cleanup, drain). Exits
non-zero with `{"status":"error","code":"ERR_…","description":"…"}` when
configuration is invalid. Never prints secrets or connection values.
External driver and database failures are reduced to an allowlisted code and
generic description; their raw messages are never emitted.

## Migration

```bash
bun run migrate
```

Applies the ordered MySQL migration chain, verifies schema checksums and
structure, prints `{"status":"ok","migrations":["…"]}`, and exits. Safe to
re-run (idempotent).

## Start

```bash
bun run start
```

Does **not** apply migrations. Verifies the schema already applied by
`bun run migrate`, then listens on `MESSAGE_BOX_STORE_HOST:MESSAGE_BOX_STORE_PORT`.
Emits one structured `startup` JSON line. If verification fails, liveness
still works and readiness stays closed with a redacted warning.

## Liveness

```bash
curl -fsS "http://127.0.0.1:${MESSAGE_BOX_STORE_PORT:-8080}/healthz"
```

Expect HTTP 200 `{"status":"ok","version":"…"}`. No dependencies; bypasses
admission and rate limits.

## Readiness

```bash
curl -fsS "http://127.0.0.1:${MESSAGE_BOX_STORE_PORT:-8080}/ready"
```

Expect HTTP 200 `{"status":"ready","version":"…"}` only after migrations are
verified in-process and the database probe succeeds. Otherwise HTTP 503
`ERR_UNAVAILABLE` with a generic description (no host, port, user, password,
or driver text).

## Graceful stop

Send `SIGTERM` or `SIGINT` to the `bun run start` process (Ctrl+C in the
foreground). The service:

1. begins admission drain (new requests fail typed 503 `ERR_UNAVAILABLE`)
2. stops the cleanup scheduler
3. waits up to `MESSAGE_BOX_STORE_SHUTDOWN_DRAIN_TIMEOUT_MS` (default 10000)
   for in-flight requests
4. closes the HTTP server and destroys the owned Knex pool

A structured `shutdown` JSON line reports `drained` and duration.

## Common redacted failures

| Symptom | Code / status | Action |
| --- | --- | --- |
| `config:check` / `start` / `migrate` exit non-zero | `ERR_STORAGE_CONFIGURATION` or `ERR_MYSQL_CONFIG` | Fix env (secret ≥16 chars; MySQL user/password/database present). Output never echoes values. |
| `migrate` refuses schema | `ERR_MIGRATION_CHECKSUM` or `ERR_MIGRATION_STRUCTURE` | Do not force-apply; restore a consistent history or contact maintainers. |
| `start` warns, `/ready` is 503 | `ERR_MIGRATION_STRUCTURE` | Run `bun run migrate`, then restart `bun run start`. |
| `/ready` 503 while process is up | `ERR_UNAVAILABLE` | Migrations not verified in this process, or database probe failed. Check MySQL and restart after `bun run migrate`. |
| Application route 503 under load | `ERR_UNAVAILABLE` | Admission bound (`MESSAGE_BOX_STORE_MAX_CONCURRENT_REQUESTS`) or shutdown drain. `/healthz` still returns 200. |
| Application route 429 | `ERR_RATE_LIMITED` + `retryAfterSeconds` | Pre-auth IP or post-auth identity window exhausted. Wait for the window; adjust rate env only if intentional. |
| Application route 401 | `ERR_AUTHENTICATION_REQUIRED` | Missing/invalid BRC-103/BRC-104 headers (unsigned requests never reach routes). |
| Process exits on config typo | `ERR_STORAGE_CONFIGURATION` | Description is generic; never echoes the bad input. |

All failure envelopes and operational log lines are redacted: no ciphertext,
bodies, identity keys, auth/wallet material, passwords, or connection strings.

## Gates (development checkout)

```bash
bun run build
bun run typecheck
bun run lint
bun run test:pack
bun run test
bun run test:m0
bun run test:m1
```
