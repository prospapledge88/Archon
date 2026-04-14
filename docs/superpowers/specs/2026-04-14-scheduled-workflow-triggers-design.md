# Scheduled Workflow Triggers

**Date**: 2026-04-14
**Status**: Draft
**Scope**: `@archon/core` (scheduler service, cron parser, config), `@archon/server` (startup wiring)

## Problem

Archon is purely reactive — someone must send a message or @mention to trigger a workflow. The dark factory pattern (autonomous code evolution where AI manages all PRs) requires periodic triggers: "every 30 minutes, check for new GitHub issues and triage them." No mechanism exists for this.

## Configuration

New `schedules` key in per-repo `.archon/config.yaml`:

```yaml
schedules:
  - workflow: fix-github-issue
    cron: "*/30 * * * *"
    enabled: true
  - workflow: validate-pr
    cron: "0 9 * * *"
    enabled: false
```

Each entry:
- `workflow` (required) — workflow name, resolved via `findWorkflow()` at load time
- `cron` (required) — standard 5-field cron expression (minute hour dom month dow)
- `enabled` (optional, default `true`) — disables without deleting

Validation at load time: workflow must exist in the repo, cron must parse. Invalid entries logged as warnings and skipped (resilient loading pattern).

## Scheduler Architecture

### Service: `WorkflowScheduler`

Follows the `cleanup-service.ts` pattern.

**Lifecycle:**
1. `startWorkflowScheduler()` called from `startServer()` alongside `startCleanupScheduler()`
2. Startup: scan all registered codebases, load `.archon/config.yaml`, collect schedule entries
3. Start a `setInterval` tick loop every 60 seconds (cron minimum granularity)
4. Each tick: evaluate which schedules are due, dispatch matching workflows
5. `stopWorkflowScheduler()` called during graceful shutdown

**Per-tick logic:**
1. For each active schedule, match cron expression against current minute/hour/day/month/weekday
2. If due: call `getActiveWorkflowRunByPath()` — skip if a run is active for same workflow + cwd
3. If clear: dispatch via direct `executeWorkflow()` call
4. Log dispatch at `info`, skip at `debug`

**Rescan:** Every 5 minutes, re-read codebase configs to pick up new/changed schedules without server restart.

### Cron Parser

Lightweight, no external dependencies. A cron expression is 5 fields; matching against current time is ~30 lines. Supports:
- Literal values: `5`, `30`
- Wildcards: `*`
- Ranges: `1-5`
- Steps: `*/15`, `1-5/2`
- Lists: `1,3,5`

No extended syntax (seconds field, `@hourly`, day names). Standard 5-field only.

### Dispatch

The scheduler calls `executeWorkflow()` directly with:
- A synthetic conversation ID: `schedule-{workflowName}-{timestamp}`
- A `SchedulePlatformAdapter` — minimal `IWorkflowPlatform` that logs via Pino instead of sending to a platform (~20 lines)
- Workflow deps from `createWorkflowDeps()`
- Workflow resolved via `findWorkflow()` + `discoverWorkflowsWithConfig()`
- `userMessage` set to `"Scheduled run ({cron expression})"`

### Overlap Prevention

Before dispatching, check `getActiveWorkflowRunByPath()`. If a run is active for the same workflow name + working path, skip and log at `debug` level. This is defense-in-depth — the executor also has this check.

### Result Handling

After `executeWorkflow()` returns, log the result (success/failure, runId, cost). No platform notification — runs appear in the dashboard like any other run, distinguished by `platform_type: 'schedule'`.

## Implementation Files

| Action | File | Responsibility |
|---|---|---|
| Create | `packages/core/src/services/cron-parser.ts` | Parse + match 5-field cron expressions |
| Create | `packages/core/src/services/cron-parser.test.ts` | Tests for cron parsing and matching |
| Create | `packages/core/src/services/schedule-adapter.ts` | Minimal IWorkflowPlatform that logs |
| Create | `packages/core/src/services/workflow-scheduler.ts` | Tick loop, cron evaluation, dispatch |
| Modify | `packages/core/src/config/config-types.ts` | Add ScheduleEntry type and schedules to MergedConfig |
| Modify | `packages/core/src/config/config-loader.ts` | Parse schedules from YAML |
| Modify | `packages/core/src/index.ts` | Export scheduler functions |
| Modify | `packages/server/src/index.ts` | Wire startup/shutdown |

## Package Boundaries

- `@archon/core` — all new code (scheduler, cron, adapter, config)
- `@archon/server` — two-line wiring (start/stop calls)
- `@archon/workflows` — no changes
- `@archon/web` — no changes (no UI for schedules in v1)
- Database — no new tables

## Non-Goals

- No web UI for schedule management (YAML config only)
- No per-schedule run history table (uses existing workflow_runs)
- No CLI commands for schedule management
- No distributed locking (single-server assumed)
- No extended cron syntax (seconds, @hourly, named days)
- No webhook/trigger source intelligence (workflows fetch their own context)
