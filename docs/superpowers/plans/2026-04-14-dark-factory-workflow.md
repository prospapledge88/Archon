# Dark Factory Workflow Implementation Plan

> **NOTE**: This plan has been superseded by review fixes in commit `fix/dark-factory-review-findings`. See the design spec for current behavior. The shipped workflow YAML is the authoritative source.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bundled default workflow `archon-dark-factory` that autonomously processes GitHub issues labeled `archon:auto` — demonstrating the full dark factory pattern (issue → plan → implement → validate → PR → success/failure handling).

**Architecture:** Single self-contained YAML with 7 DAG nodes. Uses existing commands (`archon-implement`, `archon-create-pr`) and existing variables (`$PROJECT_KNOWLEDGE`, `$WORKFLOW_ID`, `$ARTIFACTS_DIR`).

**Tech Stack:** YAML (workflow definition), bash (gh CLI for issue/PR ops), TypeScript (bundle registration)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `.archon/workflows/defaults/archon-dark-factory.yaml` | The workflow definition |
| Modify | `packages/workflows/src/defaults/bundled-defaults.ts` | Import + register for binary builds |

---

### Task 1: Create the dark factory workflow YAML

**Files:**
- Create: `.archon/workflows/defaults/archon-dark-factory.yaml`

- [ ] **Step 1: Create the YAML file**

Create `.archon/workflows/defaults/archon-dark-factory.yaml` with this exact content:

```yaml
name: archon-dark-factory
description: |
  Use when: You want archon to autonomously pick up and implement GitHub
  issues labeled `archon:auto`. Designed to run on a cron schedule.

  Triggers: Manual invocation or scheduled trigger (recommended).

  How it works:
  1. Fetches the oldest unassigned GitHub issue with the `archon:auto` label
  2. Plans the implementation using project knowledge from prior runs
  3. Implements in a fresh session
  4. Runs validation loop (tests/lint/type-check) with up to 5 fix iterations
  5. Creates a draft PR
  6. On success: comments on the issue with the PR link
  7. On failure: removes `archon:auto`, adds `archon:failed`, posts error summary

  Exits cleanly when no issues match (no-op run).

  ## Setup

  1. Create the labels (one-time):
     ```
     gh label create archon:auto --description "Archon will auto-implement"
     gh label create archon:failed --description "Archon tried and failed"
     ```

  2. Add to `.archon/config.yaml` to run every 30 minutes:
     ```yaml
     schedules:
       - workflow: archon-dark-factory
         cron: "*/30 * * * *"
     ```

  3. Label an issue to queue it:
     ```
     gh issue edit 123 --add-label archon:auto
     ```

  The scheduler picks it up within 30 minutes.

provider: claude
model: sonnet

nodes:
  # ═══════════════════════════════════════════════════════════════
  # PHASE 1: FETCH
  # ═══════════════════════════════════════════════════════════════

  - id: fetch-issue
    bash: |
      set -euo pipefail
      ISSUE_JSON=$(gh issue list \
        --label "archon:auto" \
        --assignee "" \
        --state open \
        --sort created \
        --limit 1 \
        --json number,title,body,labels,url 2>/dev/null || echo "[]")
      COUNT=$(echo "$ISSUE_JSON" | jq 'length')
      if [ "$COUNT" -eq 0 ]; then
        echo '{"has_issue": false}'
        exit 0
      fi
      ISSUE=$(echo "$ISSUE_JSON" | jq '.[0]')
      echo "{\"has_issue\": true, \"issue\": $ISSUE}"

  # ═══════════════════════════════════════════════════════════════
  # PHASE 2: PLAN (uses project knowledge for context)
  # ═══════════════════════════════════════════════════════════════

  - id: plan
    prompt: |
      You are planning the implementation of a GitHub issue.

      ## Issue Data (JSON)
      $fetch-issue.output

      ## Prior Run History for This Project
      $PROJECT_KNOWLEDGE

      ## Your Task

      1. Parse the issue JSON to understand the title, body, and labels.
      2. Review the prior run history. Note any patterns — recurring failures,
         successful approaches, files that often need changes.
      3. Write a focused implementation plan to `$ARTIFACTS_DIR/plan.md` covering:
         - What file(s) to change
         - What specific change to make
         - How to validate the change worked
         - Any risks or edge cases

      Keep the plan short and concrete. The implementation agent reads this
      in a fresh session with no other context from this run.
    depends_on: [fetch-issue]
    when: "$fetch-issue.output.has_issue == 'true'"

  # ═══════════════════════════════════════════════════════════════
  # PHASE 3: IMPLEMENT (fresh session, reads plan artifact)
  # ═══════════════════════════════════════════════════════════════

  - id: implement
    command: archon-implement
    depends_on: [plan]
    when: "$fetch-issue.output.has_issue == 'true'"
    context: fresh

  # ═══════════════════════════════════════════════════════════════
  # PHASE 4: VALIDATE (loop with up to 5 fix iterations)
  # ═══════════════════════════════════════════════════════════════

  - id: validate
    loop:
      until: "COMPLETE"
      max_iterations: 5
    prompt: |
      Run the project's validation commands and fix any failures.

      Commands to run (adapt to the project's actual setup — check CLAUDE.md
      or package.json scripts if the standard names don't exist):
      1. Type check (e.g., `bun run type-check`, `npm run typecheck`, `tsc --noEmit`)
      2. Lint (e.g., `bun run lint`, `npm run lint`)
      3. Tests (e.g., `bun run test`, `npm test`)

      If any fail, analyze the failure and fix the code. Re-run the failing
      command to verify the fix before moving on.

      When ALL checks pass, output the literal string `COMPLETE` on its own line.
      Do NOT output `COMPLETE` until every check is green.
    depends_on: [implement]
    when: "$fetch-issue.output.has_issue == 'true'"

  # ═══════════════════════════════════════════════════════════════
  # PHASE 5: CREATE PR
  # ═══════════════════════════════════════════════════════════════

  - id: create-pr
    command: archon-create-pr
    depends_on: [validate]
    when: "$fetch-issue.output.has_issue == 'true'"

  # ═══════════════════════════════════════════════════════════════
  # PHASE 6: FINALIZE
  # ═══════════════════════════════════════════════════════════════

  - id: success
    bash: |
      set -euo pipefail
      # Engine substitutes $fetch-issue.output as a shell-escaped single-quoted string,
      # so piping it into jq is safe even when the issue body contains special characters.
      ISSUE_NUM=$(echo $fetch-issue.output | jq -r '.issue.number')
      PR_OUTPUT=$create-pr.output
      # Extract first URL-looking token from PR output (most PR-create tools print the URL)
      PR_URL=$(echo "$PR_OUTPUT" | grep -oE 'https://[^ ]+' | head -1)
      if [ -z "$PR_URL" ]; then
        PR_URL="(PR created; see workflow artifacts for details)"
      fi
      gh issue comment "$ISSUE_NUM" --body "🤖 archon auto-implemented this issue.

      Draft PR: $PR_URL
      Workflow run: $WORKFLOW_ID

      The \`archon:auto\` label has been kept in case you want to rerun after review."
      echo "Success: issue #$ISSUE_NUM → PR $PR_URL"
    depends_on: [create-pr]
    trigger_rule: all_success
    when: "$fetch-issue.output.has_issue == 'true'"

  - id: failure
    bash: |
      set -euo pipefail
      ISSUE_NUM=$(echo $fetch-issue.output | jq -r '.issue.number // empty')
      if [ -z "$ISSUE_NUM" ]; then
        echo "No issue to flag (fetch-issue returned no issue)."
        exit 0
      fi
      # Remove archon:auto, add archon:failed — best-effort (ignore label errors)
      gh issue edit "$ISSUE_NUM" --remove-label "archon:auto" 2>&1 || true
      gh issue edit "$ISSUE_NUM" --add-label "archon:failed" 2>&1 || true
      gh issue comment "$ISSUE_NUM" --body "⚠️ archon attempted to implement this issue but failed.

      Workflow run: $WORKFLOW_ID
      Check the run artifacts for error details.

      The \`archon:auto\` label has been removed. Add it back to retry after investigating."
      echo "Failure flagged: issue #$ISSUE_NUM"
    depends_on: [fetch-issue, plan, implement, validate, create-pr]
    trigger_rule: all_done
    when: "$fetch-issue.output.has_issue == 'true'"
```

- [ ] **Step 2: Validate the workflow loads correctly**

Run: `bun run cli validate workflows archon-dark-factory`
Expected: Validator passes. If it reports errors about the YAML structure, the `when:` conditions, or unknown fields, fix them before proceeding.

- [ ] **Step 3: Commit**

```bash
git add .archon/workflows/defaults/archon-dark-factory.yaml
git commit -m "feat(workflows): add dark-factory reference workflow

New bundled workflow demonstrating autonomous GitHub issue processing.
Fetches issues labeled archon:auto, plans using \$PROJECT_KNOWLEDGE,
implements in a fresh session, validates with a fix loop, creates a
draft PR, and handles success/failure outcomes via issue comments
and label management.

Designed to run on a cron schedule (see description for setup)."
```

---

### Task 2: Register the workflow in the bundle

**Files:**
- Modify: `packages/workflows/src/defaults/bundled-defaults.ts`

- [ ] **Step 1: Add the import**

In `packages/workflows/src/defaults/bundled-defaults.ts`, find the workflow imports section (around lines 43-55). Add the new import alphabetically — `archonDarkFactoryWf` belongs between `archonComprehensivePrReviewWf` and `archonFeatureDevelopmentWf`. Add:

```typescript
import archonDarkFactoryWf from '../../../../.archon/workflows/defaults/archon-dark-factory.yaml' with { type: 'text' };
```

- [ ] **Step 2: Register in BUNDLED_WORKFLOWS**

In the `BUNDLED_WORKFLOWS` export (around lines 91-105), add the new entry alphabetically:

```typescript
export const BUNDLED_WORKFLOWS: Record<string, string> = {
  'archon-assist': archonAssistWf,
  'archon-comprehensive-pr-review': archonComprehensivePrReviewWf,
  'archon-create-issue': archonCreateIssueWf,
  'archon-dark-factory': archonDarkFactoryWf,
  'archon-feature-development': archonFeatureDevelopmentWf,
  // ... rest unchanged
};
```

- [ ] **Step 3: Run type-check and lint**

Run: `bun run type-check && bun run lint --max-warnings 0`
Expected: PASS.

- [ ] **Step 4: Run bundled-defaults tests**

Run: `bun test packages/workflows/src/defaults/bundled-defaults.test.ts`
Expected: All tests PASS. If any test enumerates expected workflows, the new entry may need to be added to the expected list.

- [ ] **Step 5: Run format check**

Run: `bun run format`

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/defaults/bundled-defaults.ts
git commit -m "chore(workflows): register dark-factory workflow in bundle

Adds archon-dark-factory to BUNDLED_WORKFLOWS so it ships with
binary distributions alongside the other 13 bundled workflows."
```

---

### Task 3: Full validation

**Files:** No changes — verification only

- [ ] **Step 1: Verify the workflow appears in `/workflow list`**

Run: `bun run cli workflow list --json | jq '.workflows[] | .name' | grep dark-factory`
Expected: `"archon-dark-factory"`

- [ ] **Step 2: Run full validation**

Run: `bun run validate`
Expected: type-check, lint, format, and tests all pass. Pre-existing `@archon/core` ClaudeClient failures are unrelated.

- [ ] **Step 3: Manual sanity check (optional)**

If a test repo is available with `gh` authenticated and no issues labeled `archon:auto`:
```bash
cd /path/to/test-repo
bun run cli workflow run archon-dark-factory "test"
```

Expected behavior: `fetch-issue` returns `{"has_issue": false}`, all other nodes skip, workflow completes successfully with no side effects.
