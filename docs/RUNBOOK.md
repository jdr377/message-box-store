# message-box-store operator runbook

One private standalone topology only: a single Node/Bun process against one
MySQL 8 database. No clustering, publication, backup automation, dashboards,
or multi-host deployment is covered here.

Retain only what this document lists. Active records use the enforced
`permanent` retention policy; expired body-free change rows may be purged by
the bounded cleanup pass. There is no finite active-record retention mode.

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
