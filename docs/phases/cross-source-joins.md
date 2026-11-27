# Cross-source row-level joins

Status: proposed, pending approval. This phase specification covers two-source analytical joins such as counting charges by the department of the associated encounter. The join and aggregation execute in DuckDB. The answer shows the source reads, the join, the evidence for the key, and any limits or omissions.

## Plan and validation (contract 3)

Version the typed plan's `combine` entry. Add a stable combine ID, typed input references to bounded read steps, `join_type`, typed key pairs, an aggregate projection and output schema, and row, byte and time budgets. Start with an inner equijoin. Each key pair pins the two source and field IDs, the versioned `SAME_AS` assertion ID, and a supported canonicalization version. The validator resolves assertion status and confidence from the pinned graph and checks that the assertion names exactly those fields. Historical versions remain replayable under the applicable authorization and disclosure policies. Disputed, rejected, stale, ambiguous and out-of-scope keys fail validation. Mark every probable key in answer prose and evidence, including confidence when available. Steward acceptance does not imply independent verification.

Include these fields in canonical hashing and check dependency order, output types, tenant and principal access, source scope, movement policy, and connector capabilities before execution. Keep existing plans valid under their existing schema. Each source read pins its group version and collating agent. A same-group join belongs to that group's collator. A cross-group join belongs to the orchestrator. Trusted compilers generate parameterized SQL from the validated plan using a fixed operator set. A plan contains neither arbitrary SQL nor connection credentials.

## Identifier handling and execution (contract 7 and non-negotiable 6)

Derive a run-scoped HMAC key from the tenant secret with a versioned domain separator. Each eligible source read computes HMAC over the same canonical identifier bytes in the approved source-side execution boundary. Stream tokens and only the necessary permitted columns directly into the isolated worker over authenticated, encrypted channels. The two inputs share a token domain for a given asserted key. Separate runs and unrelated keys use different domains. Bind secrets as parameters through an audited path that avoids query and parameter logging. Strip identifiers and tokens from the projection before anything leaves the worker. Exclude both from plan payloads, durable step outputs, events, caches, diagnostics, exports and model calls. Tokens receive the same handling restrictions inside the computation as raw identifiers. Nulls never match. Preserve significant leading zeroes, use explicit compatible types, and reject unsupported normalization. Many-to-many fan-out must respect the intermediate cap and the metric's declared grain.

DuckDB runs in a per-attempt isolated process with an in-memory database, no spill, no external access, no extensions or network, and bounded IPC. Disable core dumps and ensure the worker's memory cannot be swapped to disk. A supervisor enforces memory and wall-clock caps and terminates the worker on timeout, cancellation or lease loss. The process exits after each attempt and all buffers are discarded. Gateway-only inputs require both inputs to be legally co-locatable in one authorized customer-side gateway. Only cleared output leaves that gateway. Reject connector pairs that cannot tokenize within the approved boundary or satisfy movement policy. Never send a row set to another source.

**Decision required.** Approve where tokenization may run, how short-lived keys are provisioned without exposure to driver or database logging, and the initial connector pairs. Raw identifiers are classified `RESTRICTED` under contract 7. A connector that cannot satisfy source-side tokenization remains ineligible. A connector-local tokenization exception would require a separate explicit contract decision.

## Disclosure and resource bounds

Treat joined data at the highest input classification. Aggregate inside the worker, then run the tenant's disclosure checks on the entire release, including totals, margins and evidence counts. Determine cell eligibility from the configured protected unit rather than joined row counts when fan-out can inflate a cell. Apply primary and complementary suppression so visible cells and totals cannot reconstruct withheld counts. Tagged data without a disclosure policy fails closed. Charge the tagged-data query budget before execution. Only policy-cleared aggregate output and scrubbed structural evidence can reach storage, the UI or a model.

Push filters and projection down, bound reads at the source and detect overflow with a bounded additional row. Enforce separate hard limits for per-input rows and bytes, total streamed bytes, intermediate join rows, result cells, worker memory and elapsed time. Cancel reads when any limit is breached. Return an explicit safe reason for overflow and require narrower scope. A truncated join cannot support a complete answer.

**Decision required.** Approve initial numerical caps, the supported multiplicities and protected-unit counting rules, and whether a later plan version should support outer joins. Proposed initial caps for validation are 10,000 rows and 8 MiB per input, 16 MiB combined, 100,000 intermediate join rows, 1,000 result cells, 256 MiB worker memory and 30 seconds for a join attempt. These require benchmarking and policy review.

## Failures and durable runs (contract 5)

A failed or timed-out input, mismatched schema, quota breach or worker crash blocks the dependent join. Independent successful steps can contribute only their own disclosure-cleared evidence in a `PARTIAL` run. The answer identifies the missing source or join and withholds all dependent metrics. A run with no successful read evidence fails. Authorization or disclosure rejection follows the existing policy-blocked transition. Explicit cancellation follows the cancellation transition. A valid empty join follows disclosure policy and does not stand in for a failed read.

Keep durable events and fencing tokens, but store only safe status, references and cleared aggregates. Ephemeral read outputs and their join are one replay unit with an attempt ID. On lease loss or a child retry, reload all ephemeral inputs needed by the failed unit under current authorization. Reuse independent cleared results and preserve the parent's events. Reject late commits with the fencing token. Emit at most one committed outcome per join.

**Decision required.** Approve replaying successful ephemeral reads as part of the failed join unit under contract 5's retry rule. Reads may observe changed source data. Label the retry's read time and decide whether an explicitly requested historical snapshot requires a source snapshot capability.

## Acceptance tests

| Test | Pass condition |
| --- | --- |
| `c3_cross_source_join_pins_authorized_same_as` | Reject missing, mismatched, stale, disputed and out-of-scope assertions. An accepted plan pins the assertion version and its hash covers join semantics. |
| `c3_probable_cross_source_key_is_disclosed` | The answer and evidence label a probable match. Changing a field name leaves a valid assertion-backed join working. |
| `c3_cross_source_join_routes_by_group` | Same-group and cross-group plans pin their source collators and execute through the correct owner. |
| `c7_cross_source_join_keeps_identifiers_inside_approved_boundary` | Canary IDs and tokens are absent from storage, IPC outside the authorized path, logs, exports and model traffic after success and failure. |
| `c7_cross_source_join_enforces_gateway_policy` | Prohibited routing fails before reads. Gateway-only inputs never leave the gateway. |
| `c7_cross_source_join_suppresses_after_join` | Two separately releasable aggregates produce a small cell after joining. Primary and complementary suppression block reconstruction from totals. Duplicate charges cannot inflate the protected-unit count. |
| `c7_cross_source_join_aborts_on_volume_or_fanout` | Overflow cancels active reads and leaves no row artifacts or truncated aggregate. |
| `c5_cross_source_join_timeout_reports_partial` | One hung source times out. Independent evidence survives, dependent metrics are absent, and the worker accepts the next job. |
| `c5_cross_source_join_replays_ephemeral_inputs_after_lease_loss` | A killed worker leaves no intermediate data. The retry reloads its join unit, commits once and preserves the parent's events. |

## Testbed questions

Use generated truth with renamed keys, unrelated keys of the same format, duplicate charge rows, unmatched and null IDs, and a group below the configured threshold. Keep deterministic truth queries outside the planner and use the same questions for same-group and cross-group routing where applicable.

- How many charge lines and how much total charge amount were linked to encounters by department last month?
- How many distinct encounters had at least one charge last month, by department? Compare with charge-line counts to catch fan-out.
- What is the linked charge total by department when the shared encounter key is only probable? Verify the answer names the uncertainty even when the totals match truth.
- How many encounters had charges by department and service type? Verify that small cells and complementary cells are suppressed even when source aggregates are individually releasable.
- How many encounters were recorded last month, and how much was charged against them? With the charge source stalled, verify the independent encounter count and explicit missing charge total.
- How much was charged against encounters across the full date range? With fixture volume above the cap, verify the answer asks for a narrower range and publishes no truncated total.
