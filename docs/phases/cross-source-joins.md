# Cross-source row-level joins

Status: draft for review. Release 1 supports two-source analytical joins in the application worker. The first testbed pair is PostgreSQL encounters and SQL Server charges, matched by their asserted encounter key. The answer identifies the source reads, join type, evidence for the key, and omissions.

## Typed plan (contract 3)

Version the typed combine entry with bounded input references, join type, key pairs, per-input pre-aggregates, output grain, and row, byte and time budgets. Support inner and left equijoins. Pin both source and field IDs and a current, authorized SAME_AS assertion for each key pair. The validator checks the pinned assertion's endpoints, scope, review status and authorization. Reject stale, disputed, rejected or ambiguous assertions. Label probable keys in the answer with their confidence when available.

Join keys appear in read_columns only. They are excluded from exposed_columns and every output projection. Validate each input's grain, pre-aggregation, group version and disclosure policy. Canonical hashing includes join semantics and budgets. A trusted compiler generates bounded parameterized source reads and DuckDB SQL from the validated plan.

## Identifier handling and pre-aggregation (contract 7)

Connectors stream the minimum authorized source projection over authenticated encrypted transport into the application's process. Tokenize IDs at the read boundary in our process using a run-scoped, tenant-derived HMAC key and common typed canonicalization. Drop each raw ID immediately after tokenization. Client SQL performs projection, filtering and eligible pre-aggregation and receives no HMAC key. Raw IDs and tokens stay out of persistence, diagnostics, model calls, exports and response payloads. Null keys never match. Preserve significant leading zeros and reject unsupported normalization.

Pre-aggregate each source by join key and the minimum dimensions needed for the question. Push the pre-aggregate to the source where supported and safe. Otherwise aggregate the bounded stream in memory immediately after tokenization. Carry mergeable measures such as count and sum, and compute averages from their numerator and denominator. Validate measure grain before joining so repeated charge lines cannot multiply encounter measures. Refuse many-to-many joins in Release 1 and tell the user that both inputs have multiple groups for the same key. Left joins preserve the left-side population. Distinguish a successful unmatched key from a missing or failed input.

**Decision required.** Benchmark rows, bytes, distinct keys, fan-out, memory and wall time on both connectors, including an above-limit case. Record measured p95 and peak use and choose hard limits for source rows and bytes, per-key groups, intermediate rows, result cells, memory and time before implementation. An input above its cap stops the join and requests a narrower scope. A truncated result cannot support a complete answer.

## Release 1 worker and disclosure

Use a per-attempt isolated DuckDB process, in memory only, with no spill to disk, extensions, external filesystem access, network or core dumps in Release 1. Memory locking and swap guarantees move to the phase 6 deployment. Use bounded authenticated local IPC, restricted worker privileges, and supervisor-enforced memory and wall-clock limits. Terminate on timeout, cancellation or lease loss. Destroy buffers and the process at the end of each attempt. Gateway execution is outside Release 1 scope. Reject any input whose policy requires the customer gateway.

Apply the highest input classification to joined data. Run tenant disclosure after joining and aggregating, including primary and complementary suppression over the entire release, margins, totals and evidence counts. Count protected units at the declared grain so duplicates cannot inflate cell eligibility. Tagged data without a disclosure policy is blocked. Only cleared aggregates and scrubbed structural evidence may leave compute.

## Failure and retry (contract 5)

A timed-out or failed input, schema mismatch, overflow or worker crash blocks dependent metrics. Use PARTIAL when independent disclosure-cleared evidence remains and name the missing input. Fail when no usable evidence remains. A successful empty join follows disclosure policy. Cancellation and policy rejection follow their existing transitions.

Retrying the ephemeral join unit and re-reading its inputs is approved. Label source read times on every attempt and in the final answer. Explain that retry reads may observe newer source data. Keep previous events, fence late commits and reuse independently cleared results. Release 1 refuses questions that ask to join two sources as of a past point in time and explains that historical cross-source snapshots are unavailable. Date filters over current data remain supported.

## Acceptance tests

| Test | Pass condition |
| --- | --- |
| `c3_cross_source_same_as_read_only_keys` | Keys appear only in read_columns, asserted endpoints are checked, and probable matches are disclosed. |
| `c3_cross_source_inner_left_match_truth` | Both join types agree with independent truth on duplicates, unmatched keys and nulls. |
| `c7_cross_source_tokens_never_leave_read_boundary` | Canary raw IDs and tokens do not reach logs, storage, exports or models. No HMAC material reaches source SQL. |
| `c7_cross_source_preaggregation_preserves_grain` | Duplicate charges preserve encounter counts and charge sums. Input and intermediate caps stop overflow. Many-to-many jobs are refused with a reason. |
| `c7_cross_source_suppresses_after_join` | Small cells, complementary cells and totals cannot disclose the protected count. |
| `c7_cross_source_release_one_worker_isolation` | Isolation, resource limits and teardown hold on success, cancellation and worker failure. Gateway-required plans are blocked. |
| `c5_cross_source_rejects_historical_snapshot` | A past-point-in-time question across two sources is refused with the historical snapshot reason. |
| `c5_cross_source_retry_labels_reads_and_preserves_history` | A stalled input leaves a PARTIAL result when independent evidence exists. The retry labels its new read times and commits once. |

## First testbed pair and truth queries

Use synthetic PostgreSQL encounters and SQL Server charges with a renamed encounter key, duplicate charge lines, unmatched and null IDs, and a small department. Generate expected results independently of the product planner and worker. The fixture truth runner loads both synthetic extracts into a separate local test database.

- **Inner join:** “How many charge lines and how much was charged for linked encounters by department?” The truth query groups charges by encounter key using COUNT and SUM, inner joins to filtered encounter keys, then sums both measures by department.
- **Left join:** “How many encounters had no matching charge by department?” The truth query groups charges to one row per non-null encounter key, left joins from filtered encounters, then counts unmatched encounters by department.
- **Disclosure:** “How many distinct encounters had charges by department and service type?” The truth query counts distinct encounter keys at the final grain, then applies fixture suppression expectations independently.
- **Partial and retry:** Stall the charges source once while asking for overall encounters and linked charge amount. Verify the independently calculated encounter count, the missing charge amount, and the retried joined result against truth with both read times shown.

The independent truth runner loads the synthetic extracts into `pg_encounters(encounter_id, department)` and `sqlserver_charges(visit_id, service_type, amount)`. Select the test period when building the extracts so each query uses the same population.

```sql
-- Linked charge lines and amount by department.
WITH charges AS (
  SELECT visit_id, COUNT(*) AS lines, SUM(amount) AS amount
  FROM sqlserver_charges WHERE visit_id IS NOT NULL GROUP BY visit_id
)
SELECT e.department, SUM(c.lines) AS charge_lines, SUM(c.amount) AS charge_amount
FROM pg_encounters e JOIN charges c ON e.encounter_id = c.visit_id
GROUP BY e.department;

-- Encounters with no charge by department.
WITH charged AS (
  SELECT DISTINCT visit_id FROM sqlserver_charges WHERE visit_id IS NOT NULL
)
SELECT e.department, COUNT(*) AS uncharged_encounters
FROM pg_encounters e LEFT JOIN charged c ON e.encounter_id = c.visit_id
WHERE c.visit_id IS NULL GROUP BY e.department;

-- Protected units before independent fixture suppression checks.
SELECT e.department, c.service_type, COUNT(DISTINCT e.encounter_id) AS encounters
FROM pg_encounters e JOIN sqlserver_charges c ON e.encounter_id = c.visit_id
GROUP BY e.department, c.service_type;

-- Independent evidence when charges are unavailable.
SELECT COUNT(*) AS encounters FROM pg_encounters;
```
