# A smaller path to usable encrypted history

Reviewed 2026-09-22 at HEAD `8af3fa9`, including the existing uncommitted M2 working tree. This is an advisory record, not a replacement product contract or task tracker. Beads contain the executable instructions and current status. No implementation was changed in this review.

The package's purpose is sound: keep an identity-owned ciphertext copy after Message Box deletes its delivery copy, and let another device retrieve and decrypt it. The shortest route now is to finish that journey over the server already built. A repository rewrite would postpone the product again.

The imbalance is concrete: more than 10,000 nonblank source lines, three complete repository implementations, and extensive service controls, while `src/client.ts` still contains only placeholder types. The previous M3 HTTP-client issue also required the entire local replica, snapshot staging, lifecycle, cancellation and backoff; inbound and outbound both waited for it. That dependency structure rewards infrastructure completion before useful behavior.

## Recommended shape

Keep one package and four responsibilities:

1. **History client:** authenticated bounded archive/read/delete requests. It knows no local database, conversation model or transport retry policy.
2. **Message Box composition:** one bounded inbound operation and one conservative outbound operation over the proven guarded transport. Archive before ack; archive before send; never resend an ambiguous outbound attempt.
3. **Optional local replica integration:** one injected atomic adapter and one sync operation. Applications choose their local persistence. A thin lifecycle wrapper schedules the same operations.
4. **Existing server and MySQL persistence:** authenticate the owner, enforce finite limits, and store/query ciphertext. Keep current storage semantics while consolidating repeated pure rules later.

Another device can browse/decrypt remote history without waiting for a local-cache framework. Complete replicated-cache deletion guarantees still require the replica implementation; browsing alone must not be advertised as a complete replica.

## Findings and dispositions

All findings below have high confidence from source inspection. Effort estimates include focused tests; they are guidance rather than deadlines.

| Finding | Evidence | Impact and recommended action | Effort / risk |
| --- | --- | --- | --- |
| HTTP client and replica are bundled before user workflows | `src/client.ts:1`; old Bead `mbs-8g5.4.1`; `PRD.md:579` | Split HTTP from replica. Inbound/outbound depend on HTTP, not completed local synchronization. | M / low |
| README runtime helpers are absent from the package root | `README.md:84`, `mod.ts:39`, `src/index.mjs:1`, `package.json` exports | Promote reusable M0 behavior into one browser-safe production implementation; retain proof import compatibility. Do not copy the state machine. | M / medium |
| Completed sync checkpoints cannot start the next HTTP pass | `src/service.ts:1552`; `src/repository.mjs:839`; `src/feeds.mjs:156`; `src/protocol.ts:119` | Current checkpoints are decimal strings; continuation cursors bind an old watermark and terminal pages return null. Add a paired authenticated `afterSequence`/`epoch` starting mode; keep signed fixed-watermark continuation. | M / medium |
| Remote archive cannot emulate a fully observed local send-attempt record | `src/m0-outbound-http-send.mjs:219`; `src/protocol.ts:78`; SQL initial revision inserts | Only fresh `stored` authorizes dispatch. `alreadyPresent` means state unobserved and must neither dispatch nor patch a concurrent winner. Add one claim-result case to the shared helper. | M / medium |
| Repository business rules have multiple implementations | `src/repository.mjs:163`; `src/repository.mysql.mjs:63`; `src/repository.sqlite.mjs:27` | Extract shared pure rules from the memory engine; replace MySQL's duplicate validator while preserving outward results. Keep SQL/locks concrete. | S / low-medium |
| Page assembly is repeated in all adapters | `src/repository.mjs:925`; `src/repository.sqlite.mjs:981`; `src/repository.mysql.mjs:1128`; `src/feeds.mjs:229` | Share two pure finalizers, for changes and snapshots. Keep queries, retention checks and privacy decisions in the adapters. | M / medium |
| Status prose trails implementation | README/PRD/ADR/decisions say M2 is unimplemented; `src/service.ts` and M2 tests exist | Update status and one compiling package example as part of the private proof, without another standalone documentation milestone. | S / low |

The checkpoint fix is a deliberate additive API-contract amendment, not a behavior-preserving extraction. Its Bead specifies the paired fields, fresh watermark selection, invalid combinations, epoch rejection and retention gaps, including explicit checkpoint zero. It updates the canonical documents together with the implementation. No new route, table, unsigned continuation cursor or client-side server secret is needed.

The existing CLI error-redaction issue `mbs-8g5.3.2.2.4.1` is real: `scripts/ops.mjs` emits arbitrary caught error messages. Keep that finite M2 blocker and fix it in its current issue. It does not justify another logging framework or review hierarchy.

## Executable Beads

Seven new implementation/refactor Beads were created; the three existing M3 implementation Beads were rewritten rather than superseded by another tree. Each body includes current context, allowed files, ordered steps, verification commands, explicit non-goals and stop conditions.

| Bead | Deliverable |
| --- | --- |
| `mbs-8g5.4.4` | One browser-safe transport implementation shared with the M0 proof |
| `mbs-8g5.4.5` | Thin authenticated HTTP history client |
| `mbs-8g5.4.2` | Existing issue narrowed to one bounded archive-before-ack operation |
| `mbs-8g5.4.3` | Existing issue specifies remote reservation and the existing-unobserved claim case |
| `mbs-8g5.4.6` | Minimal atomic local-replica adapter plus executable contract |
| `mbs-8g5.4.7` | Public checkpoint-to-next-pass handoff |
| `mbs-8g5.4.1` | Existing issue narrowed to reconciliation and thin lifecycle |
| `mbs-8g5.9` | Packed-package private two-device proof |
| `mbs-8g5.10` | Shared repository rules after the product proof |
| `mbs-8g5.11` | Shared page finalizers after the rules extraction |

The intended order is transport → HTTP → inbound/outbound and replica prerequisites → reconciliation → private proof. Current M2 operations can finish independently; private proof closure still requires that work. The two cleanup refactors are explicitly downstream of the private proof, so cleanup cannot become another prerequisite for seeing the product work.

The proof must demonstrate A archives and acknowledges, B starts empty and decrypts, outbound history is readable, duplicates do not multiply records, archive failure leaves transport pending, and deletion converges without resurrection. Build the inbound version of that fixture early; extend the same fixture instead of inventing separate acceptance systems.

Public-release Bead `mbs-8g5.5.2` remains open, at lower scheduling priority. Its security and recovery requirements are retained. Registry scope, publication ownership and broad ecosystem documentation do not block a local packed-consumer demonstration. This demonstration is **not** deployment approval, real-user rollout readiness, or canonical M4/MVP completion. Recovery remains tracked in `mbs-8g5.5.1`; Application adoption stays a separate downstream task.

## Stop the expansion cycle

Use the updated Bead as the unit of implementation and review. Fix failures introduced by that work inside the same Bead. Create another issue only for a genuinely separate requirement, and state whether it prevents the user workflow. Parent closure should collect existing evidence, not commission another open-ended audit.

Do not add production local-cache adapters, provider registries, generalized repositories, new schedulers, paid transport, automatic resend, conversation models, additional databases, identity migration or application-specific dependencies. Prefer a concrete function that composes the existing capabilities. Preserve privacy, authorization, byte bounds, archive-before-ack and ambiguity handling; brevity does not justify deleting those guarantees.

## Larger reductions considered but not assigned

**Remove the independent memory repository:** potentially worthwhile. SQLite `:memory:` could be the sole local reference adapter, removing much of a third storage engine. Current decisions explicitly promise both memory and SQLite parity, and tests use memory-specific inspection/locking behavior. Inventory consumers and ratify the smaller adapter list first. Do not build a compatibility framework to hide an asynchronous API change.

**Collapse unreleased migration history:** there are checksum-less-journal and legacy migration branches despite private version `0.0.0`. That does not establish that existing databases are disposable. No database inventory or reset was performed, and no reset/migration rewrite was assigned.

**Replace snapshots with simple paged current-history downloads:** this would be a materially smaller greenfield product. It would also change the accepted stable-watermark, concurrent-update and deletion-convergence promises (`ADR-001-durable-history.md:434`). Given the code already exists, that redesign is unlikely to be the fastest finish. If desired later, decide explicitly which guarantees to relinquish before deleting their machinery.

**Split the large service file or shrink public helper exports:** potentially useful maintenance work, but not a blocker to the missing client. Moving code among files alone does not reduce the number of rules being maintained. Avoid another pre-release cleanup campaign.

## Verification and limits of this review

`bun run typecheck` and `bun run lint` passed against the inspected working tree. Source, package surfaces, canonical documents and all issue titles/statuses were inspected; relevant current issues and high-risk paths were read in detail. No source, test, package configuration or canonical contract was edited.

The full runtime suite, real MySQL concurrency, live deployment, capacity/security penetration tests and upstream-version research were not rerun. The default test script forces `MESSAGE_BOX_STORE_MYSQL=0`; a green default suite cannot be reported as production MySQL proof. Existing uncommitted M2 work was preserved. This review makes no claim that the package is already ready to deploy or that its line count has been compared on an equivalent basis with the upstream packages.
