# Independent security review — 28 October 2026

**Scope note:** the original findings below describe source `b9ac834` and published 0.1.2 before repairs. The separately authorized [remediation addendum](#remediation-addendum--28-october-2026) records local working-tree changes and validation. Finding Beads remain in progress pending coordinator verification. Published 0.1.2 is unchanged.

Five actionable findings were verified: one High and four Medium. They concern pre-authentication resource admission, recovery epoch validity, browse pagination, snapshot materialization, and permanent deletion-marker capacity. No cross-owner disclosure, wallet-key exposure, ciphertext decryption bypass, or unauthorized spend was demonstrated. The findings apply to the originally reviewed `b9ac834` checkout and the supplied published 0.1.2 runtime. They require maintainer disposition; this review does not establish universal security or deployment acceptance.

Reviewer: independent AI reviewer, GPT-6.1 Sol with xhigh reasoning, dispatched with a fresh task and no inherited implementation discussion. This is an AI code review, not professional human certification. The coordinator accepted the repairs and completed review parent `mbs-8g5.5.2.4`; see the final acceptance section. Publication remains separate.

## Findings

### F1 — High: body ingestion precedes admission and IP-rate enforcement

Bead: `mbs-8g5.5.2.4.1` (open, P1).

**Trigger and effect.** An unauthenticated caller sends concurrent partial JSON bodies or repeated malformed JSON. The service mounts `express.json()` and raw-body copying at [service.ts:2300](../../src/service.ts#L2300), before request admission at [service.ts:2344](../../src/service.ts#L2344) and the IP limiter at [service.ts:2377](../../src/service.ts#L2377). Consequently, those limits do not govern buffering, inflation, or parsing. Malformed JSON exits through the parser error path before consuming the IP bucket. The 4 MiB per-body ceiling still applies, but it does not bound aggregate concurrent ingress. This permits shared-process memory/CPU exhaustion when untrusted requests can reach the app. No deployed exposure or process crash was measured.

**Reproduction/result.** Against the extracted package's actual `createServiceApp`, eight unconnected `IncomingMessage` streams each supplied 131,084 bytes with `maxConcurrentRequests: 1`. All eight had active body readers while `admission.active()` was zero and IP-limiter calls were zero. Four completed invalid-JSON requests separately returned 400 with zero IP-limiter calls. The fixture opened no listener and connected no socket.

**Small repair.** Keep cheap origin/length validation and public liveness ahead of expensive work, then acquire admission and consume the IP allowance before JSON parsing. Preserve slot release on parsing errors, aborts, normal completion, and shutdown. Add partial-body and malformed-body assertions that excess requests do not enter the parser.

### F2 — Medium: delete-all after a custom recovery epoch commits an invalid epoch

Bead: `mbs-8g5.5.2.4.2` (open, P2).

**Trigger and effect.** The documented restore flow accepts and persists `restore_2026_09_22_a` as a recovery epoch ([restore-recovery.mjs:39](../../src/restore-recovery.mjs#L39), [line 173](../../src/restore-recovery.mjs#L173)). A subsequent owner delete-all calls `rotateOwnerEpoch()`, whose non-`gen-N` branch appends `#` and a timestamp ([repository-contract.mjs:90](../../src/repository-contract.mjs#L90)). That character violates the canonical epoch grammar. MySQL commits the result at [repository.mysql.mjs:638](../../src/repository.mysql.mjs#L638); SQLite and memory use the same helper. The delete succeeds, but the recovered owner's normal history operations become unusable: capabilities fail their epoch check ([service.ts:2697](../../src/service.ts#L2697)), clients reject returned epochs, and subsequent archives fail validation. Other owners are unaffected.

**Reproduction/result.** A published in-memory SQLite fixture installed exactly the custom epoch accepted by the recovery validator, then called `deleteAll` with its expected epoch. The stored result was `restore_2026_09_22_a#<timestamp>`. `validateEpoch` rejected it; an archive using that current epoch returned `invalid / ERR_INVALID_RECORD`. Installing recovery output in this disposable fixture is not a production repair. No MySQL connection was made; the shared helper and production persistence path were inspected.

**Small repair.** Generate a fresh canonical epoch of bounded length for arbitrary valid recovery epochs and validate the generated value before committing. Cover recovery → delete-all → capabilities/archive/snapshot across adapters.

### F3 — Medium: browse lacks byte-aware paging and reaches the upstream response cap late

Bead: `mbs-8g5.5.2.4.3` (open, P2).

**Trigger and effect.** A legitimate browse request selects several near-1 MiB records. Browse limits record count but does not fit serialized bytes: [MySQL:932–981](../../src/repository.mysql.mjs#L932), [SQLite:850–876](../../src/repository.sqlite.mjs#L850), and [memory:584–607](../../src/repository.mjs#L584). The route passes the result directly to JSON output. Ordinary count-based reads can therefore fail rather than return bounded progress, after fetching and allocating far more than the advertised page budget. At `limit=1000`, bodies can approach the ordinary 1 GiB owner quota; that maximum is inferred from source, not a load-test result.

**Reproduction/result.** Nine individually admitted bodies below 1 MiB produced a 9,442,972-byte browse result in both published memory and SQLite adapters, above `MAX_PAGE_BYTES = 8,388,608`. Changes paging over the same rows returned seven records plus continuation. A deterministic MySQL raw-row fixture produced the same discrepancy.

**Important installed-dependency qualification.** Stock `@bsv/auth-express-middleware@2.2.10` has an 8 MiB final response cap. Its `ResponseWriterWrapper.json()` serializes and converts the entire response before checking that cap (`node_modules/@bsv/auth-express-middleware/dist/src/index.mjs`, lines 354–408). A direct test of the actual exported `ExpressTransport` with a fake peer observed `413 / ERR_RESPONSE_TOO_LARGE`. Thus this review does **not** claim the stock service sends an oversized authenticated wire response. The defect is missing byte-aware paging and oversized allocation before the final rejection. No wallet or signing operation was used in this wrapper test.

**Small repair.** Fit browse pages by bytes, including response and continuation overhead; return the next keyset position for the last emitted record. Bound fetched body bytes as well as output bytes. Retain the upstream final cap as a backstop.

### F4 — Medium: snapshot creation reads every ciphertext body before checking capacity

Bead: `mbs-8g5.5.2.4.4` (open, P2).

**Trigger and effect.** Snapshot creation executes `SELECT r.*` across the owner's matching archive ([repository.mysql.mjs:712](../../src/repository.mysql.mjs#L712)), although it retains only membership metadata. The anchor/item capacity check follows that read at [line 750](../../src/repository.mysql.mjs#L750). SQLite has the same projection/order ([line 626](../../src/repository.sqlite.mjs#L626)). Even a request destined for quota denial fetches all matching ciphertext first. The ordinary owner quota permits up to 1 GiB of body bytes, creating unnecessary shared-process heap and database-transfer exposure from a small request. Repetition or admitted concurrency magnifies it. Snapshot storage itself is bounded; this finding concerns work before that bound is checked.

**Reproduction/result.** A deterministic transaction/SQL seam for the extracted MySQL adapter reported the maximum 32 existing snapshot anchors. The captured statement order was full-row `SELECT r.*`, then the capacity query, then `ERR_QUOTA_EXCEEDED`. The exact query and ordering are verified. Actual large-MySQL allocations, throughput, or out-of-memory failure were not measured.

**Small repair.** Project only the metadata actually needed. Reject exhausted anchor capacity first and bound/count membership before materializing it under the existing transaction. Preserve the fixed-watermark and deletion-lock semantics; no new storage architecture is needed.

### F5 — Medium: permanent deletion markers grow outside live quotas

Bead: `mbs-8g5.5.2.4.5` (open, P2).

**Trigger and effect.** One authenticated owner repeatedly archives a new small message ID and deletes it. Deletion releases live record/byte quota while retaining one permanent `history_tombstones` row for each distinct key ([MySQL:600](../../src/repository.mysql.mjs#L600), [SQLite:497](../../src/repository.sqlite.mjs#L497)). New archive admission does not reserve a finite deletion-marker budget. Change-retention cleanup deletes changes/details, not these fences ([MySQL:1190](../../src/repository.mysql.mjs#L1190)); explicit delete-all is the only ordinary clearing operation. One owner can therefore grow durable physical metadata indefinitely while reporting zero live usage. Request rates reduce growth speed without imposing a lifetime capacity bound. No disk-exhaustion incident was tested.

**Reproduction/result.** With published SQLite and default limits, 10,001 valid archive/delete cycles all succeeded. After advancing the cleanup clock and purging the change feed, usage was:

```json
{"recordCount":0,"byteCount":0,"changeCount":0,"changeDetailCount":0,"idempotencyCount":0,"tombstoneCount":10001}
```

The small reproduction demonstrates growth beyond the 10,000 live-record budget; source inspection establishes that no separate marker cap or cleanup path stops continued accumulation. These body-free fences correctly prevent reupload of deleted ciphertext.

**Small repair.** Establish a finite marker budget and reserve capacity when admitting new distinct keys, so deletion remains possible at full quota. Document the lifetime/admission consequence. Do not simply expire fences: any compaction must preserve the no-resurrection contract. This issue is separate from the repaired idempotency, snapshot-storage, and audit-event bounds.

## Source, artifact, and independence

Source: `main`, HEAD `b9ac834412881d01f71b0f24740bb1841291e011`; checkout initially clean. Published artifact reviewed:

```text
.local/sdk4-refresh-20261027/final/jdr377-message-box-store-0.1.2.tgz
SHA-256 dc08b8a624b360a9d5751e2b7214310425797cdbd1ab49c4efcd933f3bd1701d
```

The hash was freshly verified. All 76 archive files existed in the checkout: 71 were byte-identical; the only five differences were `README.md`, `CHANGELOG.md`, `docs/RELEASE_EVIDENCE.md`, `docs/SECURITY_PRE_REVIEW.md`, and `docs/UPGRADING.md`. All shipped runtime files, package metadata, and built ESM/CJS/declarations matched. Current tests are not shipped in the archive. Documentation/test reconciliation after publication does not imply a runtime fix for these findings.

Reviewed package contracts/source and recorded the initial assessment before reading the September audit, prior pre-review, review Bead, or earlier reviewer conclusions. The source-first record is in `.local/independent-security-review-20261028/initial-assessment.md`. Only then were historical claims reconciled.

Installed versions inspected: Node 22.23.4, SDK 4.0.0, auth middleware 2.2.10, Message Box Client 2.6.1, Express 5.3.0, Knex 3.3.0, mysql2 3.24.4. Disposable behavior checks import the extracted artifact; dependency resolution uses the repository's installed packages. No clean reinstall or new advisory scan was performed.

## Threat boundaries covered

| Boundary / threat-model gate | Disposition and limits |
| --- | --- |
| 1. Owner authorization | Verified identity is the route owner; body/query/path claims cannot select another partition. SQL scopes values by owner. Fresh repository checks rejected other-owner reads, writes, deletes, and snapshot access. No bypass found. Cryptographic HTTP signature/session negatives were inspected in installed code and existing evidence, not rerun with wallets/signatures. |
| 2. Method/path/query/body binding and replay | Inspected installed middleware request framing, verified identity assignment, SDK nonce claims, and the Store replay window. SDK 4.0.0 claims signed-message nonces per live session; removing sessions removes their claims. Store's 5,000-ID FIFO is supplementary. No replay bypass demonstrated. Historical descriptions of older SDK post-eviction behavior are not fresh SDK 4 evidence. |
| 3. Ciphertext, keys, and logs | Canonical envelope structure and exact hashing remain enforced; pure negative tests passed. Logging emits bounded route/status fields; middleware logging is disabled by default. No key/plaintext logging path found in reviewed supported flows. Arbitrary bytes and false peer metadata uploaded by an owner remain an accepted limitation; encoding alone cannot prove honest encryption. No production logs/backups were inspected. |
| 4. Resource controls | Findings F1, F3, F4, F5 qualify the finite-resource claims. Body, batch, live quota, process-local rates, pool, snapshot-storage, idempotency, and conflict-audit limits exist. Present limits are not throughput certification. |
| 5. Cursors and snapshots | Fresh artifact checks rejected cross-owner, wrong-feed/filter, tampered and expired cursors. Repository checks rejected other-owner snapshot access and invalidated snapshots after deletion. Snapshot count/item caps exist; creation's unnecessary body materialization is F4. No live MySQL lock/race test was run. |
| 6. Deletion, reconciliation, recovery | Fresh checks showed body removal, deletion fencing, immutable conflict handling, and snapshot invalidation. Existing atomic replica tests passed. Supported post-recovery delete-all fails as F2; permanent fence growth is F5. Recovery still relies on independently complete external deletion receipts, a fresh epoch, offline operation and encrypted backup expiry. The package cannot discover missing receipts or recover post-backup writes. |
| 7. Free-only transport and uncertain sends | Reviewed payment-disabled wallet facade, origin/route restrictions, branded outbound capability, reservation-before-send, archive-before-ack, and unknown/no-retry behavior. Installed SDK transport rejects redirects. No action/spend bypass found. No fresh HTTP 402 challenge, wallet access, signing, actual send, acknowledgement, or broadcast was performed. |
| 8. Claims and deployment assumptions | Single process, dedicated MySQL 8, explicit HTTPS client origins, configured proxy/CORS behavior, trusted client wallets and best-effort retention are explicit. Metadata is visible to the operator; identity rotation/key-loss recovery are unsupported. No professional certification, new enterprise controls, missing sign-off vulnerability, or deployment/SLO claim is inferred. |

## Focused verification and evidence

Fresh checks, all without network listeners, service/database changes, wallet access, or environment-file loading:

```text
node --test --test-concurrency=1 .local/independent-security-review-20261028/review-checks.test.mjs
11 passed; 0 failed; 0 skipped; exit 0

node --test --test-concurrency=1 tests/m1-protocol.test.mjs tests/m1-envelope-strict.test.mjs tests/m1-vectors.test.mjs tests/m3-replica-store.test.mjs
26 passed; 0 failed; 0 skipped; exit 0
```

The eleven new disposable tests include positive cursor/owner/immutable/deletion checks and direct reproductions of all five findings. MySQL tests use deterministic driver seams, not an actual database. The stock response-wrapper check uses a fake peer without cryptography. Protocol/envelope/replica tests use pure/disposable fixtures. No full suite, production credentials, `.env`, runtime data, publication, commit, push, remote sync, or capacity flood was used.

Evidence under `.local/independent-security-review-20261028/`:

- `review-checks.test.mjs`, `review-checks.log`, `review-check-results.json`: final reproductions and results.
- `artifact-comparison.json`, extracted `package/`, `initial-assessment.md`: provenance and source-first record.
- `existing-focused-checks.log`: the 26-test existing-file result.
- `review-checks-first-churn-attempt.log`: retained fixture failure. Its purge assertion originally used an incorrect clock assumption; correcting the disposable cleanup clock to 2099 made the intended expiry check pass. This was a reproduction correction, not a product fix or a hidden test-suite failure.
- `tombstone-check.log`: isolated corrected churn result.

Historical September findings `mbs-bij.1`–`.3` concerned unbounded idempotency, snapshot storage, and conflict audits. Current source contains the later 24-hour/1,024-row idempotency limit, 32-anchor/40,000-member snapshot limit, and newest-200 audit cap. Their historical MySQL remediation results were not rerun here. F4 concerns data read before the snapshot cap, and F5 concerns a different permanent table; neither reopens those completed fixes.

The review is complete as an evidence report. All five new finding Beads remain open for the coordinator; the review parent was not closed. No production code, manifests/locks, existing tests, configuration, or runtime data were changed.


## Remediation addendum — 28 October 2026

After completing the independent review, the owner authorized the same reviewer
to implement all five small repairs. The changes below are uncommitted local
working-tree changes based on `b9ac834`, not a newly qualified release. The
original findings, reproductions and artifact were retained. Published 0.1.2
still has the reviewed behavior; its SHA-256 was rechecked unchanged as
`dc08b8a624b360a9d5751e2b7214310425797cdbd1ab49c4efcd933f3bd1701d`.

### Repairs and proposed disposition

| Finding | Local repair | Regression evidence / proposed disposition |
| --- | --- | --- |
| F1 / `mbs-8g5.5.2.4.1` | Existing admission and IP controls now precede JSON body reads/inflation/parsing. Slots release on parser errors, response finish/close and request abort. Cheap origin/declared-length rejection and liveness precede the controls; allowed CORS preflight retains its existing short circuit. Exact parsed/retained auth-body framing is preserved. | Three tests in `tests/m2-ingress-admission.test.mjs` exercise partial streams at a one-request limit, parser exclusion for rejected requests, abort release, malformed-body rate use, drain/liveness, CORS, handshake routing, and exact array-body bytes. Coordinator verified; see the acceptance section below. |
| F2 / `mbs-8g5.5.2.4.2` | Non-generational epochs rotate to a fresh canonical `epoch-<UUID>` value (42 characters), validated before use. Existing `gen-N` rotation/exhaustion semantics remain intact. | Memory and SQLite tests install valid recovery output, including a 128-character epoch, rotate twice, reject stale writes, then archive and snapshot successfully. A production-MySQL seam verifies the persisted value and stale expected-epoch refusal. Coordinator verified; see the acceptance section below. |
| F3 / `mbs-8g5.5.2.4.3` | A shared browse-specific builder checks exact serialized record/array/continuation bytes. SQL adapters select at most limit+1 keys without body columns, then fetch individual owner-bound rows only until count/byte fit. Fetched body data is bounded by the 8 MiB page budget plus at most one 1 MiB body, independent of a requested 1,000-record limit. MySQL uses one consistent read transaction and preserves microsecond keyset timestamps. The upstream final response cap remains enabled. | Exact-byte boundary and single-row failure checks; nine large-record round trips without omissions/duplicates on memory/SQLite; count and cross-owner checks; MySQL seam confirms seven first-page records, three continuation records, bounded fetched bytes and exact microseconds. Coordinator verified; see the acceptance section below. |
| F4 / `mbs-8g5.5.2.4.4` | Snapshot anchor capacity is checked first under existing owner locking. SQL counts filtered membership against the remaining item allowance before materializing metadata. The projection omits bodies, and the query has a finite membership limit. Memory parity applies the same early anchor/item admission. Fixed watermark, invalidation and deletion-lock behavior remain unchanged. | Actual SQLite SQL capture proves metadata-only selection and no membership read on exhausted anchors. Concurrent memory/SQLite requests admit exactly 32 anchors. MySQL seams cover exhausted anchors/items, insufficient remaining items and valid membership. Coordinator verified; see the acceptance section below. |
| F5 / `mbs-8g5.5.2.4.5` | The separate `MAX_RESERVED_RECORD_KEYS_PER_OWNER = 1,000,000` default bounds live rows plus permanent deletion markers. A new distinct archive reserves its future deletion slot; deletion transfers it. Counts are taken once per batch under the existing owner transaction/lock. A batch-local key map ensures duplicate inputs reserve only once and immutable conflicts precede quota decisions. | Default declaration/runtime check; small-limit exact-boundary, duplicate/conflict, retry/state/delete-at-capacity, rollback and concurrent-admission tests across memory/SQLite; MySQL seam verifies one marker count after owner locking. Existing SQLite files reopen above a lowered test bound with the same migration history and preserved read/retry/delete access. Coordinator verified; see the acceptance section below. |

The F5 default is a finite implementation policy, not a measured storage or
throughput claim. It is separate from the 10,000 active-record quota. Existing
or restored owners already over the bound retain reads, state updates, exact
archive retries and deletions; only new distinct-key admission is refused.
Permanent markers are neither expired nor silently cleared. Explicit owner
delete-all retains its existing destructive clearing/epoch behavior. No automatic
quota repair or ambiguous-send retry was introduced.

No schema column/index change, migration rewrite, additive migration, or data
backfill is needed: existing indexed live/marker rows supply the count. No
runtime provider/configuration, dependency, version, package manifest or lockfile
was changed. The marker-count metric in the memory adapter was corrected to
count its existing owner-prefixed map keys; duplicate batch planning also keeps
SQLite's byte accounting exact before capacity decisions. These changes support
the same reservation boundary rather than adding a second storage system.

### Final validation

On Node 22.23.4 with the installed versions recorded above:

- `bun run build`: passed. The neutral-platform bundler emits Node-built-in
  external-import warnings for server-only modules; build exit was zero.
- `bun run typecheck`: passed.
- `bun run lint`: passed, including browser graph/export/secret checks.
- Final focused selection: **86 passed, zero failures, zero skips, exit zero**.
  This includes the two maintained regression files plus the ten applicable
  existing files listed below, rather than the complete curated suite.
- A small TypeScript consumer resolved the new literal limit through the public
  package declaration. Built public ESM and CommonJS exports both reported
  `1,000,000`. The original qualified tarball hash remains unchanged.

Exact focused command:

```text
node --test --test-concurrency=1 tests/m1-security-remediation.test.mjs tests/m2-ingress-admission.test.mjs tests/m1-protocol.test.mjs tests/m1-envelope-strict.test.mjs tests/m1-vectors.test.mjs tests/m1-mysql-unit.test.mjs tests/m1-sqlite.test.mjs tests/m1-repository.test.mjs tests/m3-replica-store.test.mjs tests/m1-properties.test.mjs tests/m1-schemas.test.mjs tests/m1-scaffold.test.mjs
```

Maintained regression sources are `tests/m1-security-remediation.test.mjs` and
`tests/m2-ingress-admission.test.mjs`. Final logs remain under
`.local/independent-security-review-20261028/`:

- `remediation-final-focused.log`: final 86-test result.
- `remediation-build.log`, `remediation-typecheck.log`,
  `remediation-lint.log`: package quality checks.
- `remediation-public-types.log`, `public-limit-check.ts`: public declaration check.
- `remediation-regressions.log` and `remediation-existing-focused.log`:
  earlier focused 16-test and 58-test runs, retained as intermediate evidence.

### Implementer handoff and scope (before coordinator validation)

**At implementer handoff, live MySQL was not yet qualified.** Existing live
helpers load dotenv/credentials; this repair scope expressly forbids accessing
those sources, and no credential-free disposable helper was available. MySQL
claims above are limited to deterministic SQL seams and source inspection;
SQLite concurrency/parity does not establish InnoDB execution or query-plan
performance. The coordinator can decide whether additional disposable validation
is needed before release.

No real service was started/stopped/reloaded, no production database or data was
touched, and no wallet, credential/environment file, payment, signature,
broadcast, full suite, throughput campaign, publication, Git commit/push,
remote sync or Beads remote setup was used. Disposable request tests use
unconnected streams and a fake authentication middleware only.

At implementer handoff, the five findings and review parent remained **in progress** for coordinator
verification. Proposed disposition is implemented locally with focused evidence,
pending that verification; no finding was closed by its implementer. A capacity
or deployment statement is outside this repair.

## Coordinator acceptance — 28 October 2026

All five source repairs are accepted for the reviewed scope. The independent
review was performed by a fresh GPT-6.1 Sol xhigh agent, followed by repairs by
that reviewer and coordinator source inspection and executable validation. This
is an AI review, not a claim of independent human certification. It does not
authorize publication, deployment or a throughput guarantee.

### Final executable evidence

| Check | Result |
| --- | --- |
| Complete package script, `bun run test`, delegated to GPT-6 Luna low | **342 passed, 0 failed, 25 skipped**, 367 reported tests, exit 0; about 2m48s. The script deliberately disables gated MySQL tests. |
| New maintained MySQL regression file, enabled explicitly | **7 test nodes passed** (six functional cases and their parent), no failures or skips; final run 38.4s. |
| Existing MySQL feed, snapshot and restore-recovery selection | Four actual integration cases passed: feed parity, deletion/read lock ordering, snapshot primitives, and rollback with two-device reconciliation. Node also reports three empty filtered-file containers; these are not additional behavioral checks. |
| Coordinator rerun of the two new non-MySQL regression files | 16 passed, no failures/skips. |
| Final package lint; JavaScript syntax and diff checks | Passed. Previously qualified build, typecheck and public declarations remain applicable because product source did not change during coordinator validation. |

The fresh MySQL cases ran on **MySQL 8.4.13 / InnoDB** through the existing
restricted test account. Its grants cover the two dedicated package test schemas
only; it has no global CREATE or live MapApp history schema grant. No new server,
container, account, credential or administrator connection was needed.

The new maintained test is `tests/m1-security-remediation.mysql.test.mjs`:

- F2 uses the actual restore-recovery operation, including a 128-character
  recovery epoch, then rotates twice and proves stale-write refusal, fresh
  writes and usable snapshots.
- F3 forces a byte-limited multi-page browse of ten large synthetic ciphertext
  records at the same exact microsecond timestamp. Every record is returned
  exactly once; each serialized envelope fits the page budget. Count limits,
  filters and owner separation also pass.
- F4 runs real concurrent snapshot admission, proves the metadata query excludes
  bodies, and verifies anchor refusal before membership reads. A separate
  synthetic 40,000-item fixture proves item refusal before materialization.
- F5 proves duplicate/conflict handling, future deletion reservations, updates
  and deletion at capacity, reconnecting above a lowered limit, rollback and
  concurrent admission. No marker expiry or history clearing is used to evade
  the limit.

Each fresh fixture owner is checked absent before use, then its rows and
snapshot membership are removed and verified absent. Existing migration
versions/checksums compare unchanged. Tests used disposable data in dedicated
test schemas; live history, wallets, configuration and owner-run services were
not modified. This proves the repaired execution paths, not production capacity
or all possible MySQL failure modes. The other gated MySQL tests are not claimed
as executed merely because the standard full script passed.

Reproduce with a dedicated test configuration and MESSAGE_BOX_STORE_MYSQL set
to 1 in the test process environment:

```text
node --test --test-concurrency=1 tests/m1-security-remediation.mysql.test.mjs
```

Retained logs under `.local/independent-security-review-20261028/`:
`coordinator-full-store-suite.log`, `coordinator-mysql-security-final.log`,
`coordinator-mysql-existing.log`, `coordinator-focused.log`, and
`coordinator-final-lint.log`. The earlier MySQL run is preserved separately.

The coordinator closes `mbs-8g5.5.2.4.1` through `.4.5` and the review parent
`mbs-8g5.5.2.4` on this evidence. The separate concise deployment/support
statement remains `mbs-8g5.5.2.5`. All repairs remain local source changes;
published **0.1.2** is unchanged and does not contain them. No commit, push,
release or service cutover was performed.