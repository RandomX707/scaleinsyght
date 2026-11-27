# test_emr profiling report

Prepared 27 Nov 2026 from Scale Insyght's own job records on the review deployment, and updated at 08:10 after the last run. Times are India Standard Time (IST).

test_emr is a PostgreSQL test database with a copy of a real EMR schema. Scale Insyght only reads it. This report holds no credentials and no data values, only counts and timings.

## Summary

- **Now:** full profiles complete in **28 to 32 minutes**, depending on how fast test_emr answers:
  - 28 minutes at 04:55, with nothing skipped;
  - 32 minutes at 07:32, when test_emr answered about three times more slowly. 11 identifier columns and parts of the statistics for 4 large tables ran past its time limit; they were skipped and counted, and the profile still completed.
- **Before today's fixes:** the first full profile took **73 minutes**. The two runs after it did not finish.
- **Overall:** 9 hours 46 minutes passed between adding the connection and the first complete profile. Most of that was failures, not profiling. Each failure is explained below with its fix.

## Timeline

| When | What happened |
|---|---|
| 26 Nov, 15:38 and 15:40 | test_emr was added twice. The 15:38 copy was later removed. Its agent is retired and its history kept. |
| 26 Nov, 15:40 to 17:17 | Profiling then ran inside the web request. It failed with no reason recorded, and the Profile page cycled between "being prepared" and "not available". |
| 26 Nov, 17:17 | Profiling moved to a background worker. |
| 26 Nov, 20:49 | First background attempt: the database couldn't be reached. Nothing was answering at its network address. |
| 27 Nov, 00:12 | Three more attempts within a minute, still unreachable. |
| 27 Nov, 00:13 to 01:26 | **First complete profile: 73 minutes.** 14 large tables had no statistics. |
| 27 Nov, 02:20 to 03:00 | Second run, after the large-table fix: stopped at 92%. The identifier step hit the database's time limit. |
| 27 Nov, 03:04 to 03:36 | Third run: failed after a software update restarted it partway through. |
| 27 Nov, 04:55 to 05:23 | **Run after the sampling and identifier fixes: complete in 28 minutes.** |
| 27 Nov, 06:02 and 06:20 | Two runs after the standard and custom update failed just after sampling. One relationship check ran past test_emr's time limit. |
| 27 Nov, 07:32 to 08:04 | **Run after the relationship fix: complete in 32 minutes**, with test_emr answering more slowly than at 04:55. |

## Time per stage

Each run's stages come from its job record. The first three runs don't record where catalog discovery ends, so it is shown together with sampling for them.

| Stage | First complete run (00:13) | Second run (02:20) | After the ID fixes (04:55) | After the relationship fix (07:32) |
|---|---|---|---|---|
| Catalog discovery (finding tables and columns) | 12 min 4 s, with sampling | 3 min 8 s, with sampling | 21 s | 45 s |
| Sampling and statistics | (included above) | (included above) | 1 min 52 s | 5 min 51 s (test_emr slower) |
| Saving the profile and inferring relationships | 1 min 57 s | 4 min 33 s | 2 min 48 s | 1 min 25 s |
| Function code and identifiers (IDs) | 58 min 53 s | 31 min 31 s, then stopped (258 of 890 steps) | 23 min 4 s (890 of 890 steps) | 24 min 3 s (894 of 894 steps; 11 columns skipped) |
| **Total** | **72 min 54 s** | **39 min 12 s, incomplete** | **28 min 5 s** | **32 min 6 s** |

What made the difference:
- **Sampling and statistics:** large tables are now measured from a fixed-size sample. Row counts for the largest tables come from the database's own catalog estimates, labelled as estimates. Before, 14 tables ended up with no statistics; now none do.
- **Identifiers:**
  - The step now works through the columns one at a time, saving each one as it goes, and shows its progress on the Profile page.
  - Large identifier columns are compared through a consistent sample: about 1 in 16 values, chosen by the same rule in every source. Columns with up to 20,000 distinct values are still taken whole.
  - The step now stores 2.6 million keyed fingerprints instead of about 17.3 million. It finished all 890 steps in 23 minutes. The 02:20 run managed only 258 steps in 31 minutes.
- **Relationships:** each proposed relationship is now checked on at most 10,000 values, looked up by key, instead of joining two whole tables. This step took 1 min 25 s at 07:32, against 2 min 48 s at 04:55, even though test_emr was slower.

## What test_emr contains

| Item | Count |
|---|---|
| Schemas | 1 |
| Tables | 272 |
| Views | 0 |
| Procedures | 0 |
| Functions | 119 |
| Columns | 6,895 |
| Total rows | 117,078,908 |
| Of which estimated | 100,650,796, in the 24 largest tables (exact counts for the other 248) |
| Sensitive columns found | 205 |
| Inferred relationships between tables | 385, all inferred (the database declares no foreign keys) |
| Identifier columns tagged as identifiers | 22 |
| Columns checked as possible identifiers | 445 (the 22 above, plus key-like columns) |
| Of which compared through a sample | 93 (each has more than 20,000 distinct values) |
| Identifier matches with other connected sources | 15 |

Notes on the counts:
- All 15 identifier matches are on columns small enough to be read whole. The 8 matches found by the first complete run are all still found.
- Inferred relationships are proposals to review. None is treated as verified.

## What failed at first, and what was fixed

| # | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| 1 | Adding test_emr never produced a profile, and the page cycled between "being prepared" and "not available". | Profiling ran inside the web request. One slow table failed the whole profile and no reason was saved. | Profiling runs in the background. A slow or unreadable table is noted and skipped instead of failing everything. A failed profile shows its reason with Retry. | Fixed 26 Nov |
| 2 | Attempts at 20:49 and 00:12 failed. | The database wasn't reachable from the app at those times. | Nothing to fix in the product. The page showed "The server couldn't be reached" with Retry, and the next attempt worked. | Resolved |
| 3 | The first profile took 73 minutes, and 14 large tables had no statistics. | Large tables were read in full and hit the database's 10-second limit per query. The identifier step ran as one long transaction with no visible progress. | Sampling and catalog estimates for large tables. The identifier step saves column by column and shows progress. | Fixed 27 Nov |
| 4 | The 02:20 run stopped at 92% ("relationships and lineage could not be mapped"). | One identifier column hit the database's time limit, and that ended the whole run. | A column that times out is skipped and counted; the run carries on. Large identifier columns are now sampled, and the step now runs about 4.7 times faster than in the 02:20 run. | Fixed 27 Nov |
| 5 | The 03:04 run failed at 03:36. | A software update restarted the worker partway through the run. The old worker kept running the earlier code until it was stopped. The run then started again and tripped over the records its first attempt had already saved. | A restarted run now saves safely over its earlier attempt; tested by stopping a run and restarting it. Updates now wait for the worker to stop and confirm the new one is running. | Fixed 27 Nov |
| 6 | The 06:02 and 06:20 runs failed just after sampling, and nothing was saved. | Each proposed relationship was checked by joining two whole tables. On tables of tens of millions of rows one check ran past test_emr's time limit, and that ended the whole run. The 04:55 run had stayed just under the limit. | Each check now reads at most 10,000 values and looks each up by key. A check that still times out skips that one proposal and is counted. | Fixed 27 Nov |

## Open items

1. **Standard and custom objects: changed by decision 64, not yet seen on test_emr.** Standard and Custom now follow the object type, automatically, with no classifying to do. Once this change is deployed, test_emr should show:
   - Standard: the 272 tables;
   - Custom: the 119 functions, of which 52 carry a "Copy" badge (near-identical to another function, 91% to 100% similar).

   A function's inputs are now listed apart from the columns it returns (test_emr's e02_a1c showed "Parameters 16" for 3 inputs). Stored functions are corrected on the next profile or nightly run.
2. **Nightly refresh repeats the full profile.** The nightly run doesn't yet remember which tables are unchanged, so it re-profiles all 272 (about 28 minutes a night).
3. **The identifier step still takes 23 minutes.** It reads every identifier column again on each run. Reusing what earlier runs already fingerprinted is the next improvement.
4. **Stage times aren't stored.** The times for the 04:55 run were read from the job record while it ran. Recording each stage's start and end, and the time per table, is planned.
5. **24 row counts are estimates.** They come from the database's statistics and are labelled as estimates in the product.
6. **test_emr's speed varies.** At 07:32 it answered about three times more slowly than at 04:55. 11 identifier columns and parts of the statistics for 4 large tables were skipped and counted, not lost silently. They are picked up again on the next run.
7. **No client-side time limit on source queries.** One query through the network tunnel to test_emr waited over 5 minutes with no answer. A stalled connection could hold the profiler until it is restarted.
