# S2 Conversation, Answer, Identifier, and ER Fix Design

**Intent.** Make the existing S2 app behave like a real, inspectable conversation product. Keep every question and answer in an owner-scoped thread, show what the model planned and which models/tokens were used, answer only supported typed plans against connected sources, preserve exact source identifiers, and render the ER view from true declared and sufficiently confident inferred relationships.

**Goals.** Persist conversations and turns using the existing run records; pass earlier turns to planning; create a new thread explicitly; list/reopen the user's recent conversations in newest-first order; clear the composer after send; match the prototype greeting. Persist and render plan/answer model provenance and the validated typed plan. Extend the typed query intent without breaking existing intent shapes to cover filtered joins, top-N grouping, grouped averages, source comparisons and contextual follow-up filters. Return exact source names in every screen. Return relationship confidence/evidence and field types; show only declared foreign keys and inferred links meeting the configured threshold. Use shared UI controls for the dictionary upload.

**Non-goals.** No S3 work, no changes to PostgreSQL or SQL Server source data, no new runtime service, no raw identifier disclosure, and no fabricated fallback answer when the plan is unsupported or validation fails.

**Approaches considered.**

1. Keep a single current run and add browser-only transcript state. This is small, but loses history on reload and cannot produce real recent conversations.
2. Add owner-scoped conversation records and associate existing analytic runs with them. This reuses durable run plans, answers and evidence, supports reload/reopen, and preserves existing run APIs. **Chosen.**
3. Replace the run engine with a separate chat subsystem. This duplicates authorization, evidence and lifecycle behavior and is not justified.

For model execution, keep the existing OpenAI-compatible gateway and safety boundary. The model emits a semantic typed query plan; the server validates its schema, source scope, asset/column existence, relationship evidence and query limits before building the durable run DAG. The worker executes read-only SQL and asks the same gateway to compose one answer sentence from aggregate-only results. Store both calls' actual model/token metadata and the validated typed plan with the run; never substitute a template answer when the model fails.

**Design calls.** Conversation ownership is the authenticated principal within a tenant. A run belongs to one conversation and is ordered by creation time. The first question becomes its title. Follow-up context consists of the preceding user questions and model answers from that conversation only. The answer provenance panel reports planner and answer calls separately, plus combined tokens and the exact validated semantic plan. Exact qualified names are rendered as supplied. ER inference displays only confidence at or above the documented cutoff, with evidence method, confidence and evidence description; containment relations are not counted as ER links. `testbed/truth.json` remains the SQL-derived oracle for acceptance.

**Acceptance evidence.** Contract tests cover ownership, ordering, transcript/context, typed-plan validation and provenance persistence. Real-source Playwright walkthrough steps cover each requested answer and SQL evidence, reload/reopen and follow-up context, exact identifier rendering, ER edge set/confidence/type/layout, and shared file controls. Gap-audit items for conversation behavior and model provenance stay **Fake** until the full testbed walkthrough passes; only then may the audit mark them Real.
