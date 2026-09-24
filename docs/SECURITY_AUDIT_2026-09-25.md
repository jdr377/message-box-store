# Message Box Store security audit — 2026-09-25

Status: package-maintainer code audit. This is **not** the qualified independent
human sign-off tracked by `mbs-8g5.5.2.4`, nor publication or deployment approval.
The reviewed checkout has uncommitted refactor and validation changes. No
production code was changed during this audit.

## Scope and method

Reviewed the accepted PRD, ADR, M0 threat model, internal pre-review, release
evidence, current package exports, HTTP service, client transport, protocol,
memory/SQLite/MySQL repositories, schemas, and recovery path. Traced untrusted
requests from authentication through owner selection, validation, persistent
effects, and cleanup. No consumer application was part of the audit. No external
service or vulnerability registry was queried.

Fresh executable evidence: Node 22.21.1; 50 focused transport, snapshot,
auth-context, ingress, and logging tests passed with zero failures/skips.
An isolated in-memory SQLite reproduction (below) made no network or production
database requests. The earlier 346-test MySQL-enabled result in release work
was not rerun because this audit made no production behavior change.

## Findings

### F1 — High: idempotency rows bypass the live-storage quota (`mbs-bij.1`)

An authenticated owner can send repeated `DELETE /v1/history/records/{key}`
requests for a nonexistent record, each with a new idempotency key. The route
accepts an optional key ([service](../src/service.ts), `validateDeleteOneInput`),
and both SQL adapters persist a replay result even for the no-op branch
([MySQL](../src/repository.mysql.mjs), lines 553–570;
[SQLite](../src/repository.sqlite.mjs), lines 449–470). Their
`history_idempotency` tables have an index on creation time but no admission
budget or routine purge ([schema](../src/migrations.mjs), lines 239–263).
`record_count` and `byte_count` remain zero, so the advertised per-owner
quota cannot stop this growth. The memory adapter also retains idempotency
entries without a bound. Ordinary cleanup covers snapshots and changes, not
idempotency ([service](../src/service.ts), lines 1816–1841).

Proof on disposable in-memory SQLite: 20 unique no-op deletes produced
`idempotencyRows: 20, recordCount: 0, byteCount: 0`. Each call is valid for the
same authenticated owner; the 20-call proof is a small demonstration, not an
upper bound. A valid identity can continue until database capacity is exhausted.
Process-local request rates slow this path but do not establish a finite
storage bound. This violates the finite physical-capacity requirement in
[PRD](../PRD.md) and the resource gate in the
[threat model](./M0-THREAT-MODEL.md).

Reproduction core (run against `createSqliteStore()` with its default
`:memory:` database, using any valid 66-character owner key):

```js
for (let i = 0; i < 20; i++) {
  await store.deleteRecord({ owner, recordKey: 'a'.repeat(64), idempotencyKey: `probe-${i}` })
}
const idempotencyRows = store.db.prepare(
  'SELECT COUNT(*) AS n FROM history_idempotency WHERE owner_identity_key = ?'
).get(owner).n
const usage = await store.getUsage({ owner })
// idempotencyRows === 20; usage.recordCount === 0; usage.byteCount === 0
```

Remediation: define and enforce a finite idempotency retention or per-owner
budget in all adapters, document exactly when a replay key stops being valid,
and include this table in physical usage metrics. Preserve atomic replay
semantics within the chosen window. Test the no-op path and expiry/budget edge
against MySQL and SQLite.

### F2 — High: repeated snapshots multiply storage and work (`mbs-bij.2`)

`POST /v1/history/snapshot` is authenticated, but has no per-owner snapshot
count or materialized-item budget ([service](../src/service.ts), lines
2642–2653). Each call copies one membership row per matching live record,
up to the 10,000-record owner limit ([MySQL](../src/repository.mysql.mjs),
lines 693–752; [SQLite](../src/repository.sqlite.mjs), lines 607–657).
The snapshots expire after one hour
([snapshots](../src/snapshots.mjs), lines 13 and 149–150); default cleanup is
hourly and deletes a bounded number of items per pass
([service](../src/service.ts), lines 285–289 and 1816–1841). The live-record
quota does not count copied membership rows.

Proof on disposable SQLite: after archiving three records, five successive
snapshot requests produced `snapshots: 5, items: 15, recordCount: 3,
byteCount: 81`. At the allowed 10,000 live records, a single request can
materialize 10,000 items. Repetition can outpace cleanup and consume database
space and transaction time. The impact is availability, not a demonstrated
cross-owner read or plaintext leak.

Reproduction core (after archiving three valid encrypted records for `owner`):

```js
for (let i = 0; i < 5; i++) await store.createSnapshot({ owner })
const snapshots = store.db.prepare(
  'SELECT COUNT(*) AS n FROM history_snapshots WHERE owner_identity_key = ?'
).get(owner).n
const items = store.db.prepare('SELECT COUNT(*) AS n FROM history_snapshot_items').get().n
// snapshots === 5; items === 15; (await store.getUsage({ owner })).recordCount === 3
```

Remediation: enforce a finite active-snapshot and/or membership budget per
owner, or safely reuse equivalent snapshots. Keep the fixed-watermark and
invalidated-cursor semantics. Capacity tests should compare admitted work with
cleanup throughput on MySQL and SQLite; saturation must fail with a typed
bounded response.

### F3 — Medium: MySQL immutable-conflict audit events are unbounded (`mbs-bij.3`)

An authenticated owner can archive one valid record and repeatedly submit the
same canonical key with a different encrypted body. Each immutable conflict
inserts a new `history_audit_events` row in MySQL
([adapter](../src/repository.mysql.mjs), lines 378–387). There is no MySQL
cap or purge for this table; the schema only provides an owner/time index
([schema](../src/migrations.mjs), lines 79–87). SQLite caps audit events at
200 per owner ([adapter](../src/repository.sqlite.mjs), lines 210–216), and
the [ADR](../ADR-001-durable-history.md) calls these events bounded. The
MySQL production path differs from that contract. Conflict requests do not
increase live-record quota, and `getStorageStats` omits audit and
idempotency rows ([adapter](../src/repository.mysql.mjs), lines 1159–1170).

This is a persistent availability risk from any valid identity. The code path
is direct; a live MySQL conflict-flood reproduction was not run during this
read-only audit to avoid adding data to a shared test service.

Remediation: apply a bounded MySQL audit policy compatible with the intended
forensic window (SQLite's 200-row policy is a candidate), test repeated
conflicts, and include audit rows in physical usage reporting.

## Boundaries checked without a new discrepancy

| Boundary | Code and evidence | Limit of this conclusion |
| --- | --- | --- |
| Identity and owner | Verified middleware identity selects the owner; archive direction is checked before repository access ([service](../src/service.ts), lines 1064–1127, 2397–2601). Signed-request, cross-owner and replay tests passed in the focused run. | Trusts pinned BRC-103 middleware and its session manager. The 5,000-ID replay window is process-local and permits post-eviction reuse under a live session, as the threat model already states. |
| Encrypted body and logs | Canonical envelope validation rejects non-envelope bodies; request logging uses route patterns and allowlisted fields ([canonical](../src/canonical.js), `validateEncryptedBody`; [service](../src/service.ts), lines 2207–2239). Sentinel logging tests passed. | A valid owner may upload arbitrary bytes encoded as ciphertext; the server does not prove sender honesty or encryption strength. |
| Free-only transport | Guarded wallet blocks payment derivation and action methods; local authenticated HTTP 402 tests passed ([transport](../src/free-only-transport.mjs), lines 78–145). | The pinned SDK's redirect behavior and internal BRC-103 recovery exchanges are accepted documented limits; no claim of one physical request or redirected-host refusal is made. |
| CORS and ingress | Exact HTTPS origin allowlist, 4 MiB JSON bound, batch bounds, admission, and request-rate gates are present ([service](../src/service.ts), lines 2244–2410). Focused ingress tests passed. | CORS is not authentication; rate/admission state is per process. These gates do not bound the durable auxiliary tables in F1–F3. |
| Cursor, deletion, recovery | Cursor HMAC binds owner/feed/filter/epoch; snapshot reads lock metadata against deletion; recovery reapplies external deletion receipts before service resumes ([protocol](../src/protocol.mjs), `createCursor`; [MySQL](../src/repository.mysql.mjs), lines 1054–1157; [recovery](../src/restore-recovery.mjs), lines 101–186). Focused snapshot tests passed. | Operator receipt completeness is an external assertion; a compromised operator or an incomplete bundle cannot be proved complete by this package. Encrypted backups retain deleted bytes until their documented expiry. |
| Package surface | Browser-conditioned exports select browser-safe root/client/protocol; server and raw repository subpaths are explicit ([manifest](../package.json)). Existing pack evidence covers import/require/browser/declarations. | No fresh packed-artifact audit or external dependency advisory query was performed. |

## Disposition and remaining review

F1 and F2 are release-blocking for a publicly available multi-tenant service
under the package's own finite-capacity contract. F3 is a contract discrepancy
and should be resolved or explicitly accepted before release. The package is
currently private (`0.0.0`, `UNLICENSED`); this report is not evidence of an
incident in a deployed service. Dedicated Beads track fixes. After behavior
changes, run the complete MySQL-enabled suite against verified disposable test
databases with zero skips, plus typecheck, lint, build, and pack verification.

A qualified reviewer independent of the implementation must still validate
this report and the prior pre-review, decide whether to authorize external
dependency-vulnerability checking or an approved alternative, and explicitly
dispose of each finding and accepted residual risk. The human sign-off Bead
`mbs-8g5.5.2.4` remains open.
