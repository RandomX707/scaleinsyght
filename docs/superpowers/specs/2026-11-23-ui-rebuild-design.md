# UI Rebuild Design

**Status:** approved by the user's detailed UI brief; implementation branch `ui-rebuild`
**Reference:** `docs/prototype/index.html`, with `CLAUDE.md` sections 10–11

## Intent

Bring the React workspace into visual and interaction alignment with the clickable prototype on every existing and requested screen. Keep API routes, database migrations, authorization, and service behavior unchanged. Add a repeatable Riverside Health demo seed, shared UI components, raw-control enforcement, and side-by-side 1440×900 review artifacts.

## Goals

- Port the prototype's `:root` colors and font tokens exactly; centralize measured spacing, radius, shadow, and type scales in `packages/ui`.
- Rebuild the app shell and all requested screens in React using shared, labeled controls and prototype copy/layout.
- Keep current API-backed functionality, adding client-side presentation for existing features without expanding Phase 6 scope.
- Seed repeatable demo content for Riverside Health, its read-only sample PostgreSQL connection, fictional source/BI records, profile, lineage, reports, last-night findings, saved questions, and a pending approval.
- Add a source scan that rejects raw native form controls outside `packages/ui`.
- Add `pnpm screens` to seed, visit each prototype and app route at 1440×900, and save pair images under `docs/ui/screens/`; visually inspect each pair and record intentional differences.
- Add a screen-change screenshot comparison requirement to `CLAUDE.md`'s definition of done.

## Non-goals and constraints

- No API route, server behavior, schema, migration, connector protocol, or authorization change.
- No new service, package dependency, or vendor integration.
- No vendor logos or product names beyond the fictional sources in the prototype. Do not display internal IDs, role names, or the word “synthetic”.
- Demo-only fixture import controls appear under a Controls > Demo data section and only when `DEMO_MODE=true`.
- The prototype is a visual and behavioral reference, not code or state-model to copy.
- All sample database rows remain generated fake data; the source connector stays read-only.

## Approaches considered

1. **Shared UI package with an API-preserving React migration (selected).** Port tokens and primitives first, then migrate the existing app screens and shell to those primitives while retaining current route handlers and API calls. This meets the raw-control guard and preserves tested backend behavior.
2. **Replace the React client with the prototype's vanilla JavaScript.** Rejected because it would copy the prototype's inline state model, discard typed API integration, and weaken the existing E2E coverage.
3. **Restyle each current page in place without shared components.** Rejected because native controls would remain scattered, preventing consistent labels, accessibility, and enforcement of the user's UI rule.

## Design and implementation calls

- `packages/ui` exports React `PageHeader`, `Card`, `Button`, `Input`, `Textarea`, `Select`, `Tabs`, `Badge`, `Table`, `EmptyState`, `Toast`, `Modal`, and `Collapsible`, plus `tokens.css` and global component styles. Only these package components may render native `button`, `input`, `select`, and `textarea` elements.
- App navigation remains on the existing routes where they exist. The profile and ER explorer use the existing discovery/explorer routes. Add frontend routes for any missing prototype surfaces only when no existing endpoint serves them.
- The session API accepts only configured demo emails and exposes no display name. To keep the backend unchanged, the demo seed reuses tenant `golden-tenant-north` and allow-listed email `analyst@north.example`, renames that tenant display to Riverside Health, and the UI presents that signed-in demo person as Yashaswi. This is a UI display name, not a new API user. The existing demo password remains `golden-local-only`.
- The seed script is idempotent. It reuses the existing tenant login mapping, seeds connector and graph/report demo rows with stable keys, and does not reset `si_test` or modify the separate source database.
- The screenshot runner covers Home/chat, Connectors/list and add flow, Profile, ER explorer, Dictionary and procedure tabs, Lineage/table, Lineage/column, ID trace, BI reports, Reports, Agents, My agent, Hub integrations, Approval matrix, Controls, Usage, and sign-in. Each mapped prototype screen gets a 1440×900 side-by-side image; Hub integrations has an app-only image because the prototype has no Hub screen. Existing gateway, governed-definition, and FlowSpec surfaces remain in scope only as currently implemented and are restyled in the same system.

## Acceptance checks

- `ui_tokens_match_prototype_values`: copy exact prototype values for background/surface/sidebar, ink/muted/faint/line, primary and profiler/analytic/good/warn/bad colors and tints; Inter and JetBrains Mono stacks; type sizes; spacing scale; radii; and shadow definitions.
- `ui_shared_components_render_labeled_accessible_controls`: all specified primitives work and labels, keyboard focus, disabled states, and disclosure semantics are present.
- `ui_no_raw_native_controls_outside_shared_package`: raw form controls outside `packages/ui` fail the unit gate.
- `ui_shell_matches_prototype_and_signed_in_identity`: full logo, grouped/collapsible sidebar, bottom Platform and Recent groups, notifications panel, prototype header, Yashaswi name/initials.
- `ui_screens_have_no_internal_ids_or_demo_wording`: UI copy does not expose IDs, roles, or the word “synthetic”; demo import actions are gated under Controls.
- `ui_demo_seed_is_repeatable_and_populates_all_screens`: two seeds preserve row counts and the demo tenant can sign in with its documented account.
- `ui_screens_generates_1440_side_by_side_pairs`: screenshot files and report entries cover every screen and flow listed above, including the separate BI reports and Reports pages; every pair is visually inspected, and intentional differences include their reason.
- `ui_connectors_add_flow_and_scope_navigation`: selecting a source type, advancing through connection setup, setting scope, and returning to the connector list work by keyboard and pointer.
- `ui_profile_to_er_navigation`: Profile summary metrics and category cards navigate to the corresponding ER explorer view.
- `ui_dictionary_navigation_and_tabs`: Standard/Custom dictionary tabs, collapsible object cards, and procedure tabs retain selection and display seeded content.
- `ui_lineage_table_column_and_identifier_trace`: table/column lineage selection renders API results; ID lookup is above the trace results and does not retain the entered value.
- `ui_home_chat_plan_evidence_and_feedback`: greeting includes Yashaswi, seeded conversation shows plan/evidence, and useful/not-useful feedback controls work.
- `ui_notifications_new_and_earlier_groups`: notification panel groups new and earlier notices and supports mark-read actions.
- `ui_demo_seed_screen_inventory`: seed includes local read-only Riverside source, Meridian Lumen, Meridian Harbor, Meridian Aurora Cloud, Report Studio, profiling summaries, ER categories, dictionary entries, table/column lineage, ID trace, distinct BI and governed reports, agent cards, Hub connections, last-night findings, saved questions, and one pending approval.
- Existing API contract tests remain unchanged and pass; E2E tests cover key prototype interactions and the full route inventory.

## Work ordering

Design tokens/components and the raw-control guard first; shell and shared routing second; API-backed screens and interaction polish third; demo seed and demo-only controls fourth; screenshot automation and per-screen visual fixes last; update definition of done, run all gates, and merge from `ui-rebuild` only after CI is green.
