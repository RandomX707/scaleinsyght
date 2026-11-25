# Controls prototype

Approved by agent, pending review. The prototype defines the Controls page layout.

- Per connector, show effective scope totals and a measured nightly estimate. Use the previous completed refresh when available.
- Evaluate per-object overrides, then the first matching ordered name rule, then the group default. Enforce scope before counts, samples or analytic queries. Controls cannot widen the connector credential's grants.
- Store pending changes for review. Apply a reviewed version through the Approval matrix. Check current scope again before executing an already queued typed query.
- Preserve historical graph assets and assertions under contract 6. Keep history and mark it out of scope, as confirmed by Yashaswi.

## Acceptance cases

- `controls_exclusion_blocks_profile_and_query` proves that an approved exclusion blocks refresh collection and also blocks execution of a saved query for the excluded object (contracts 3 and 6).
- `controls_requests_review_from_sticky_bar` walks through the grouped scope, ordered and column rules, and the Approval matrix (contracts 1 and 6).
- Capture the production and prototype screens at 1440 × 900 and list intentional differences.
