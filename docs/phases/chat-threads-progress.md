# Chat threads progress

Branch `chat-threads`, draft PR #18, built on `planner-robustness` (#17).

Done:
- Reproduced the review-app bug with `tests/e2e/real-product-s2b-chat-threads.spec.ts`. It failed before the fix (a duplicated question in the thread) and passes after.
- Idempotent sends with client request ids (`runs.run_requests`, migration 030), with a contract test that sends the same id twice at once.
- A conversation is created only with its first run. Send is disabled while a request is in flight.
- One chat key across Home and `/conversations/<id>`.
- Resolved source-choice runs are not repeated, and an open choice is restored on reload.
- Recent conversations lists answered threads only and refreshes when a run finishes.
- Answer titles come from the question, every bar shows its value, and singular and plural copy is correct.
- Deleted 8 empty duplicate conversations for `riverside-health` in the dev database.

Verification: all gates pass locally, CI is green, and `pnpm test:testbed` passed 3 times in a row.

Not merged: depends on #17, which has 1 wrong in the planner evaluation.
