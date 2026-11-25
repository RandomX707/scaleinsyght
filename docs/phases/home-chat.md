# Home chat rework: spec

Status: **approved 25 Nov 2026 as decision 56**, with the two additions marked *Approved addition* below. Requirements: Yashaswi's brief (moved from Codex to Claude Code on 25 Nov 2026) and CLAUDE.md 10.2 "Home (chat)". Reference: `docs/prototype/index.html` route `#home` (`answerHtml`, `linAnswerBody`). Contracts touched: 4 (claims and evidence), 5 (runs and events), 7 (what is shown and withheld). No new contract fields; one new table (section 5).

## 1. What exists today

- Each turn shows the plan card ("How your question is being answered") above the answer, still expanded after the run ends.
- A grouped answer shows a summary line, a bar chart (only when no cell is withheld) **and always the full table**. So a 12-department answer with some cells withheld is a 12-row table plus an evidence block, taller than the viewport. That is why the restored S2b follow-up fails (known issue K7).
- Evidence (SQL per source, sources, lineage) is an always-expanded block. Trust and probable-link chips are shown.
- Follow-ups always start a new run, including "show that as a table".

## 2. The display rule: code decides, never the model

The form is chosen by code from the result's shape. The model's prose is the answer sentence only.

| Result | Shown | Not shown by default |
|---|---|---|
| One value (count, sum, average), or one group | **Sentence only**: the value in words, with its source | No table, no chart |
| 2 to 5 groups | **Small table** (group, value; the group key beside the label when there is one) | No chart |
| 6 to 20 groups | **Bar chart**, sorted as the query sorted it, with a text alternative (highest, lowest, spread, ties) | No table; "Show as a table" is one click |
| More than 20 rows | **Compact table** of the first 10 rows and "Show all N" | No chart |
| Lineage question | **Flow diagram** (as the prototype's `linAnswerBody`): summary sentence, column flow, evidence-type counts, numbered steps collapsed, Open in Lineage, "Alert me if this path changes" | No SQL table |
| Refusal or failure | **Explanation and a safe alternative** chosen by code from the refusal reason: a tagged column → offer the same count without it, or grouped by an untagged column; an excluded object (`object_out_of_scope`) → name it and point to Controls; an unsupported shape → the nearest supported question built from the same table; budget or source outage → say so and offer retry | Never the generic "couldn't answer" alone |

- **Never a chart and a full table together by default.**
- **Withheld cells:** a chart bar marked "<11" has no length and is labelled "Fewer than 11, withheld"; the text alternative says how many groups are withheld.
- **Comparisons across sources:** one row per source with the difference in the sentence. The 2-to-5 rule applies per source; more than one grouped source uses one table per source, compact.
- **The plan's sort order** is kept: the chart and table never re-sort what SQL ordered.

## 3. The answer card

- **Answer sentence** (the claim), with its evidence references, always first and always visible.
- **The display** chosen by section 2.
- **Trust badge** (route: certified, pack, glossary or exploratory) and **probable-link warnings** stay visible on the card; they are not hidden in the drawer.
- **One collapsed drawer, "SQL, sources and lineage (N queries)"**: per source, its name, the executed SQL with copy, rows returned, and the lineage of the columns used (links to Lineage). Collapsed by default; its state is remembered per turn in the page only.
- **Thumbs up and down** as today (thumbs up offers to save the question; thumbs down asks for the correct answer, or creates an Approval matrix item for a lineage answer).

## 4. The plan card

- While the run is live: the existing "How your question is being answered" card with each agent's state and a tick when done.
- **After completion it collapses to one line**, for example "Answered from SQL Server · 1 query · 8 s" or "Answered from 2 sources · 3 queries · 12 s". Elapsed time comes from the run's first and terminal events. The line expands to the full plan on click.
- A failed or refused run collapses to "Not answered · reason" with the same expand.

## 5. Follow-ups that change the form without rerunning

- A follow-up that only asks for a different form of the previous answer is recognised **by code, not the model**: "as a table", "show all", "as a chart", "just the number", "top N" / "bottom N" (when the previous result already holds those rows), "sorted by name" / "sorted by value".
- *Approved addition (b):* the recogniser accepts natural variants ("can you put that in a table", "table please", "just give me the number"). It is tested with at least 20 phrasings, including ones it must reject (anything that adds a condition, names a new measure or source, or asks a new question). When unsure, it runs the question normally.
- It adds a turn to the conversation that **reuses the previous turn's stored result** (`result_ref`) with the new form: no plan, no source query, no model call. The turn shows "Same answer, shown as a table" and links to the run it reuses.
- Anything else, including "top N" beyond the rows held, starts a new run as today.
- Storage: migration 040 adds `runs.conversation_display_turns` (tenant, conversation, turn id, the run it reuses, the form, the phrase's normalised kind, created at), with row-level security. Conversation history lists runs and display turns in order. Result rows still travel by reference only (non-negotiable 9): the display turn holds no rows.

## 6. Layout

- Conversational: question bubbles on the right, answers on the left with the assistant mark, the composer fixed at the bottom ("All sources" selector and "Analytic mode · read-only").
- *Approved addition (a):* the attach and voice buttons appear only if they work end to end; otherwise they are left out, and the difference from the prototype is listed.
- After an answer arrives, the thread scrolls so the newest answer's sentence is in view. With the displays above, a typical answer fits the viewport, so "scrolled to the newest" and "summary in view" both hold (K7).

## 7. Tests

- **Unit:** the display rule for every row of the table in section 2, including withheld cells and ties; the follow-up phrase recogniser (accepted and rejected phrasings); the plan summary line.
- **Contract:** a display turn makes no model call, no source query and no new run (c5), and stores no rows (c4).
- **Walkthrough `real-product-s11-home-chat.spec.ts`**, one case per rule on the testbed, each checked against SQL truth:
  - a single count;
  - orders by status (3 groups, small table);
  - orders per department (12 groups, chart);
  - a result over 20 rows (compact table and Show all);
  - a lineage question (flow diagram);
  - a refusal on a tagged column with its safe alternative;
  - an excluded-table refusal;
  - follow-ups "show that as a table", "show all" and "just the number" that make no new run;
  - the plan collapsing to its summary line.
- S2b must pass unchanged (K7), which lets K6 (#41) merge.
- **Screens:** 1440×900 app-and-prototype pairs for each form and the collapsed plan, with the differences listed in `docs/ui/ui-report.md`.

## 8. Decision needed

**Decision 56 (approved 25 Nov 2026): the display table in section 2, and recognising form-only follow-ups in code, with the two additions above.**

- *Alternative:* let the model choose the form. Rejected: the form would vary between runs of the same question, and it would cost a model call for a display change.
