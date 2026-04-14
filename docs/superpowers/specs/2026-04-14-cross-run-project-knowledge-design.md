# Cross-Run Project Knowledge

**Date**: 2026-04-14
**Status**: Draft
**Scope**: `@archon/core` (knowledge writer), `@archon/workflows` (variable substitution + executor hook)

## Problem

Archon starts every workflow session cold. Run 50 workflows against a repo, and the 51st has zero institutional knowledge from the prior 50. Common failure patterns, successful approaches, and project-specific conventions are lost between runs.

## Design

### Knowledge Capture (Deterministic)

After each workflow run completes (success or failure), extract a structured summary from existing data:

- `workflow_runs`: name, status, started_at, completed_at, metadata.total_cost_usd
- `workflow_events`: node_completed/node_failed events with output snippets and error messages

Entry format:
```markdown
---
### 2026-04-14 10:30 — fix-github-issue (completed, 4m 23s, $0.1234)

**Nodes:** 5 completed, 0 failed, 1 skipped
**Errors:** (none)
**Files modified:** src/auth/login.ts, src/auth/login.test.ts
**PR:** https://github.com/owner/repo/pull/42
---
```

For failed runs:
```markdown
---
### 2026-04-14 11:15 — feature-development (failed, 12m 07s, $0.3421)

**Nodes:** 3 completed, 1 failed, 2 skipped
**Errors:**
- implement: "Test suite failed: 3 assertions in auth.test.ts"
**Files modified:** src/auth/signup.ts
---
```

### Storage

Single file: `.archon/knowledge/run-history.md`

- Reverse chronological order (newest first)
- Capped at 50 entries
- File header with brief description
- Directory created on first write if it doesn't exist
- File rewritten on each append (read → prepend → truncate → write)

### Variable Injection

New variable `$PROJECT_KNOWLEDGE` in `substituteWorkflowVariables()`:

- Only read from disk when the prompt contains `$PROJECT_KNOWLEDGE`
- If file exists: substitute with file contents
- If file missing/empty: substitute with empty string
- Trusted content (locally generated) — no sanitization

### Workflow Author Usage

```yaml
nodes:
  - id: implement
    prompt: |
      Implement the feature.
      
      Prior run history for this project:
      $PROJECT_KNOWLEDGE
```

## Implementation Files

| Action | File | Responsibility |
|---|---|---|
| Create | `packages/core/src/services/knowledge-writer.ts` | Extract run summary, read/write/cap knowledge file |
| Create | `packages/core/src/services/knowledge-writer.test.ts` | Tests for extraction and file operations |
| Modify | `packages/workflows/src/executor-shared.ts` | Add $PROJECT_KNOWLEDGE substitution |
| Modify | `packages/workflows/src/executor-shared.test.ts` | Test for new variable |
| Modify | `packages/workflows/src/executor.ts` | Call knowledge writer after completion |

## Non-Goals

- No AI summary layer (deterministic only)
- No database tables or migrations
- No web UI changes
- No config/opt-in flag (always-on)
- No per-workflow knowledge files
- No cross-project knowledge sharing
- No search capability beyond reading the file
