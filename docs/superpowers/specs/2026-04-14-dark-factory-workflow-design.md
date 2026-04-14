# Dark Factory Reference Workflow

**Date**: 2026-04-14
**Status**: Draft
**Scope**: `.archon/workflows/defaults/archon-dark-factory.yaml` + bundle registration

## Problem

Archon has the individual pieces for autonomous code evolution (PIV loop workflow, scheduled triggers, project knowledge, cost tracking) but no bundled reference workflow demonstrating the full dark factory pattern — a workflow that, when scheduled, autonomously processes GitHub issues end-to-end.

## Design

Single self-contained workflow YAML. One-issue-per-run, label-gated, with explicit failure handling.

### Loop

```
fetch-issue → plan → implement → validate → create-pr → success/failure
```

All nodes guarded by `when: "$fetch-issue.output.has_issue == true"` so the workflow exits cleanly when no issues match.

### Issue Selection

- `gh issue list --label "archon:auto" --assignee "" --sort created --limit 1 --json number,title,body,labels,url`
- `archon:auto` label required — explicit human gate
- Oldest unassigned first (FIFO)
- Empty result = clean exit (no downstream errors)

### Failure Handling

- `all_success` nodes (success comment) — run only if everything passed; swaps `archon:auto` → `archon:done` so the issue isn't reprocessed on the next scheduler tick
- `all_done` node (failure handler) — runs after all upstream nodes settle, then uses a bash guard checking `$ARTIFACTS_DIR/.pr-url` to distinguish the success vs. failure case (engine does not support a `one_failed` trigger rule; `all_done` + bash guard is the idiomatic workaround)
- Failed issues won't be re-picked — human must investigate and re-label

### Integration with Prior Improvements

- **#1 Prompt injection defense** — Partial: the issue body flows via `$fetch-issue.output` (node output, not a sanitized context variable). The plan prompt wraps it in an XML trust boundary (`<external_context source="github_issue">`) as Layer-2 defense. Layer-1 pattern stripping is NOT applied to node outputs. See Fix 1 for details.
- **#2 Cost analytics** — Automatic: factory runs appear in cost dashboard
- **#3 Scheduled triggers** — Designed for it: documentation includes schedule config
- **#4 $PROJECT_KNOWLEDGE** — Planning node uses prior run history

## Workflow Structure

```yaml
name: archon-dark-factory
description: |
  ...usage and setup instructions...
provider: claude
model: sonnet

nodes:
  - id: fetch-issue
    bash: ...  # fetches one issue or returns {has_issue: false}
  
  - id: plan
    prompt: ...  # uses $PROJECT_KNOWLEDGE + $fetch-issue.output
    depends_on: [fetch-issue]
    when: "$fetch-issue.output.has_issue == true"
  
  - id: implement
    command: archon-implement
    depends_on: [plan]
    when: "$fetch-issue.output.has_issue == true"
    context: fresh
  
  - id: validate
    loop:
      until: "COMPLETE"
      max_iterations: 5
    prompt: ...  # run tests/lint/type-check, fix failures
    depends_on: [implement]
    when: "$fetch-issue.output.has_issue == true"
  
  - id: create-pr
    command: archon-create-pr
    depends_on: [validate]
    when: "$fetch-issue.output.has_issue == true"
  
  - id: success
    bash: ...  # post PR comment, keep archon:auto label
    depends_on: [create-pr]
    trigger_rule: all_success
    when: "$fetch-issue.output.has_issue == true"
  
  - id: failure
    bash: ...  # remove archon:auto, add archon:failed, post error
    depends_on: [fetch-issue, plan, implement, validate, create-pr]
    trigger_rule: all_done
    when: "$fetch-issue.output.has_issue == true"
```

## Implementation Files

| Action | File | Responsibility |
|---|---|---|
| Create | `.archon/workflows/defaults/archon-dark-factory.yaml` | The workflow YAML |
| Modify | `packages/workflows/src/defaults/bundled-defaults.ts` | Register for binary builds |

## Non-Goals

- No composed workflow (no invoking other workflows via CLI subprocess)
- No multi-issue batch processing
- No AI-based issue classification (label gating only)
- No new commands or components
- No test files (workflow validator catches structural errors at load time)
- No automatic label creation (documented in description)
