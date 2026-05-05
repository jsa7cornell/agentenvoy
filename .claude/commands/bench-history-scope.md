---
description: Run the conversation-history scope detector bench corpus.
argument-hint: [filter substring]
---

Run the history-scope detector bench corpus.

Source: `app/src/__tests__/unit/history-scope.test.ts` (proposal `2026-05-05_conversation-history-scope_decided-2026-05-05.md`).

The bench corpus covers:
- 20 continuation shapes (anaphora, re-name, additive-connective, ambiguous default, onboarding) — all must classify `continue`.
- 20 pivot shapes (trigger bundle Bryan→Katie→Paul, Reports 2/7/10, fresh-name patterns) — all must classify `pivot`.
- Signal-level unit tests (anaphora, additive, proper-noun extraction, closed-task narration).

**Steps:**

1. Optionally accept a filter substring as $ARGUMENTS to narrow which test shapes run.

2. Invoke the runner:
   ```bash
   cd app && npx vitest run --config vitest.unit.config.ts \
     src/__tests__/unit/history-scope.test.ts \
     ${ARGUMENTS:+-t "$ARGUMENTS"}
   ```

3. Format the result back into chat:
   - Header: **X/Y passed, Z failed**
   - For failures: list the test name + expected vs received mode.
   - If all pass, confirm "All N history-scope shapes pass".

4. If failures involve a NEW shape that the corpus doesn't yet cover, propose extending the corpus — but **wait for John's confirmation before editing the test file**.

**When to run:**
- After modifying `src/agent/modules/_shared/history-scope.ts`
- After thumbs-down reports tagged `historyScope.mode === "pivot"` in production
- Before merging any change touching conversation-history wiring
