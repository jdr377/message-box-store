# M4 internal security pre-review

Status: maintainer pre-review for `mbs-8g5.5.2`, based on source and executable
evidence at commit `7d84a74` plus the uncommitted deterministic-runner change.
This is not the independent security review required for release approval.

## Scope and method

The review checked every item in the
[M0 release security gate](M0-THREAT-MODEL.md#release-security-gate) against the
current public surfaces, server/storage implementation, operator recovery path,
tests, and package documentation. It also searched production sources for
dynamic code execution, command execution, interpolated SQL, wallet/payment
entry points, request-body/header logging, and embedded credentials.

The package remains private, `0.0.0`, and `UNLICENSED`. Review of source and
tests does not authorize risk acceptance, a registry release, or deployment.

## Threat-gate trace

| Gate | Control and executable evidence | Pre-review result |
|---|---|---|
| 1. Owner isolation | Verified session identity is the sole owner selector; every route rejects owner overrides. `m2-auth-context`, `m2-capabilities-isolation`, `m2-retrievals`, and repository cross-owner tests cover read/write/delete/quota/capabilities. | No discrepancy found. Operator/auth-dependency compromise remains the documented trust boundary. |
| 2. Signed mutation, sessions, and replay | Auth tests mutate method/path/query/body, remove sessions, replay probe and non-probe requests, test fresh retries, exact handshake exclusion, 5,000-ID FIFO semantics, and post-eviction behavior. | No discrepancy found. Post-eviction acceptance under a still-live session remains explicitly documented. |
| 3. Secret/plaintext/log boundaries | Envelope validation accepts ciphertext only; logging tests scan sentinels across request, cleanup, startup, shutdown, and error events; operational errors are allowlisted/redacted. Backup guidance requires encryption and external deletion receipts. | No discrepancy found. Process/operator compromise and downstream log sinks remain outside the application boundary. |
| 4. Finite work and storage | Exact body, HTTP body, batch, page, response, quota, rate, admission, pool, cleanup, snapshot, and drain bounds are constants/configuration with boundary and saturation tests. Live MySQL exercises accounting, locks, rollback, and bounded cleanup. | Finite behavior is evidenced. This is not a production throughput claim; raising a limit still requires deployment-specific measurement. |
| 5. Cursor/snapshot integrity | HMAC cursors bind owner context, epoch, feed, filters, watermark, position, and expiry. Feed/snapshot tests cover tamper, owner/filter/feed/epoch misuse, gaps, expiry, interruption, and complete resnapshot. | No discrepancy found. Cursors provide integrity, not confidentiality. |
| 6. Delete and restore safety | Deletes atomically purge active bodies and quota, emit body-free convergence events, invalidate snapshots, fence stale epochs, and prune replicas. Offline recovery fails closed without complete external receipts and installs an external fresh epoch. | No discrepancy found. Encrypted backup bytes survive until the operator's finite backup-retention deadline; post-backup writes are not recovered. |
| 7. Free-only transport | Public factories expose an opaque guarded capability, force `checkPermissions:false`, reject payment contexts/headers, block wallet action/key methods, and expose no live-send fallback or retry/reset API. M0/M3 authenticated 402 tests observe zero spend/action and one application-level invocation. | No discrepancy found. SDK redirects and internal session recovery exchanges remain the accepted documented limitations. |
| 8. Claims and accepted limits | README, decisions, threat model, runbook, changelog, upgrade guide, release evidence, and notices consistently state best-effort ciphertext history, visible metadata, unsupported rotation/paid/retry flows, and restore loss boundaries. | No stronger product claim found. Publication and deployment remain separate approvals. |

## Additional source review

- No `eval` or `Function` construction was found. Child-process use is confined
  to development pack/test runners with fixed executables and argument arrays.
- SQL values are parameterized. The inspected interpolations are bounded numeric
  purge limits and the fixed `SEQ_ORDER` expression, not request-controlled SQL.
- Production wallet-payment methods appear only in the deny-list/guard path;
  wallet-action implementations and paid challenge fixtures are test-only.
- The repository lint secret scan passes. No committed production credential was
  identified by this review.
- Browser-conditioned exports exclude the server/database graph, and the packed
  consumer verifies ESM, CommonJS, browser, declarations, and documented files.

## Executable results

On Windows with Node 22.21.1, Bun 1.3.11, MySQL 8, Knex 3.3.0, and mysql2
3.24.4:

- first default concurrent full run: 344 tests, 318 passed, 3 failed, 23
  MySQL-disabled skips; the visible failure was an outbound security test that
  failed during reservation before its expected 402 guard;
- isolated outbound file: 9/9 passed;
- immediate concurrent rerun: 321 passed, 23 intentional skips, 0 failures;
- explicit serial full run: 321 passed, 23 intentional skips, 0 failures;
- explicit serial live-MySQL run: 344/344 passed, 0 skips, 0 failures.

The curated runner now explicitly serializes test files so release evidence does
not depend on process-wide HTTP/auth scheduling. Two clean curated runs are
required before closing the runner-stability child bead.

## Findings and unresolved gates

1. **Independent review required — release blocker.** Another qualified reviewer
   must validate this trace and the underlying M0/M2 evidence, then resolve or
   explicitly accept findings. This document cannot self-certify independence.
2. **External dependency vulnerability audit not run — approval required.** The
   attempted `bun audit` was stopped because it would disclose the locked
   dependency graph to an external registry. Run it only with explicit approval,
   record the service/date/result, and adjudicate any advisory.
3. **Runtime/capacity approval remains narrow.** Node 22.21.1 and the installed
   MySQL/peer versions are executable evidence. Node 24 and broader peer/runtime
   combinations are not verified. Saturation tests prove configured bounds and
   recovery, not production throughput or an SLO.
4. **Release-owner decisions remain open.** The package license, legal approval
   of notices, registry scope, maintainer ownership, first SemVer, and exact
   support matrix require authorized decisions before an immutable candidate.
5. **RC mechanics remain downstream.** After those decisions and independent
   sign-off, produce one tarball, record its SHA-256 and source commit, rerun the
   complete approved matrix against that candidate, and do not publish or deploy
   without separate authority.
