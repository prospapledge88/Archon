# Scheduled Workflow Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cron-based scheduled workflow triggers so workflows can fire automatically on a timer, enabling the dark factory pattern without human initiation.

**Architecture:** Per-repo `schedules:` config in `.archon/config.yaml` → lightweight cron parser → 60-second tick loop in a server-side service → direct `executeWorkflow()` dispatch via a logging-only platform adapter.

**Tech Stack:** TypeScript, Bun test runner, `@archon/paths` logger, `@archon/workflows` executor

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/core/src/services/cron-parser.ts` | Parse + match 5-field cron expressions |
| Create | `packages/core/src/services/cron-parser.test.ts` | Tests for cron parsing and matching |
| Create | `packages/core/src/services/schedule-adapter.ts` | Minimal IWorkflowPlatform that logs |
| Create | `packages/core/src/services/workflow-scheduler.ts` | Tick loop, cron evaluation, dispatch |
| Modify | `packages/core/src/config/config-types.ts:110-210` | Add ScheduleEntry to RepoConfig, schedules to MergedConfig |
| Modify | `packages/core/src/config/config-loader.ts:336-412` | Parse schedules in mergeRepoConfig |
| Modify | `packages/core/src/index.ts:113-119` | Export scheduler start/stop |
| Modify | `packages/server/src/index.ts:250-252` | Wire scheduler startup/shutdown |

---

### Task 1: Cron parser with tests (TDD)

**Files:**
- Create: `packages/core/src/services/cron-parser.test.ts`
- Create: `packages/core/src/services/cron-parser.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/services/cron-parser.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { parseCronField, matchesCron } from './cron-parser';

describe('parseCronField', () => {
  test('wildcard matches any value', () => {
    const matcher = parseCronField('*', 0, 59);
    expect(matcher(0)).toBe(true);
    expect(matcher(30)).toBe(true);
    expect(matcher(59)).toBe(true);
  });

  test('literal value matches exactly', () => {
    const matcher = parseCronField('5', 0, 59);
    expect(matcher(5)).toBe(true);
    expect(matcher(6)).toBe(false);
  });

  test('range matches inclusive bounds', () => {
    const matcher = parseCronField('1-5', 0, 59);
    expect(matcher(0)).toBe(false);
    expect(matcher(1)).toBe(true);
    expect(matcher(3)).toBe(true);
    expect(matcher(5)).toBe(true);
    expect(matcher(6)).toBe(false);
  });

  test('step on wildcard matches every N', () => {
    const matcher = parseCronField('*/15', 0, 59);
    expect(matcher(0)).toBe(true);
    expect(matcher(15)).toBe(true);
    expect(matcher(30)).toBe(true);
    expect(matcher(45)).toBe(true);
    expect(matcher(7)).toBe(false);
  });

  test('step on range matches every N within range', () => {
    const matcher = parseCronField('1-10/3', 0, 59);
    expect(matcher(1)).toBe(true);
    expect(matcher(4)).toBe(true);
    expect(matcher(7)).toBe(true);
    expect(matcher(10)).toBe(true);
    expect(matcher(2)).toBe(false);
    expect(matcher(0)).toBe(false);
  });

  test('list matches any listed value', () => {
    const matcher = parseCronField('1,3,5', 0, 59);
    expect(matcher(1)).toBe(true);
    expect(matcher(3)).toBe(true);
    expect(matcher(5)).toBe(true);
    expect(matcher(2)).toBe(false);
    expect(matcher(4)).toBe(false);
  });

  test('throws on invalid field', () => {
    expect(() => parseCronField('abc', 0, 59)).toThrow();
  });
});

describe('matchesCron', () => {
  test('every minute matches any date', () => {
    const date = new Date('2026-04-14T10:30:00Z');
    expect(matchesCron('* * * * *', date)).toBe(true);
  });

  test('specific minute matches only that minute', () => {
    const date30 = new Date('2026-04-14T10:30:00Z');
    const date31 = new Date('2026-04-14T10:31:00Z');
    expect(matchesCron('30 * * * *', date30)).toBe(true);
    expect(matchesCron('30 * * * *', date31)).toBe(false);
  });

  test('every 30 minutes', () => {
    const date0 = new Date('2026-04-14T10:00:00Z');
    const date15 = new Date('2026-04-14T10:15:00Z');
    const date30 = new Date('2026-04-14T10:30:00Z');
    expect(matchesCron('*/30 * * * *', date0)).toBe(true);
    expect(matchesCron('*/30 * * * *', date15)).toBe(false);
    expect(matchesCron('*/30 * * * *', date30)).toBe(true);
  });

  test('9 AM weekdays', () => {
    // 2026-04-14 is a Tuesday (dow=2)
    const tuesdayMorning = new Date('2026-04-14T09:00:00Z');
    const tuesdayAfternoon = new Date('2026-04-14T14:00:00Z');
    // 2026-04-18 is a Saturday (dow=6)
    const saturdayMorning = new Date('2026-04-18T09:00:00Z');
    expect(matchesCron('0 9 * * 1-5', tuesdayMorning)).toBe(true);
    expect(matchesCron('0 9 * * 1-5', tuesdayAfternoon)).toBe(false);
    expect(matchesCron('0 9 * * 1-5', saturdayMorning)).toBe(false);
  });

  test('specific day of month', () => {
    const first = new Date('2026-04-01T12:00:00Z');
    const second = new Date('2026-04-02T12:00:00Z');
    expect(matchesCron('0 12 1 * *', first)).toBe(true);
    expect(matchesCron('0 12 1 * *', second)).toBe(false);
  });

  test('throws on invalid expression (wrong field count)', () => {
    expect(() => matchesCron('* * *', new Date())).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/services/cron-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cron parser**

Create `packages/core/src/services/cron-parser.ts`:

```typescript
/**
 * Lightweight 5-field cron expression parser and matcher.
 * Fields: minute (0-59) hour (0-23) day-of-month (1-31) month (1-12) day-of-week (0-6, 0=Sun)
 *
 * Supports: literals, wildcards (*), ranges (1-5), steps (~/15, 1-5/2), lists (1,3,5).
 * No extended syntax (seconds, @hourly, named days/months).
 */

type FieldMatcher = (value: number) => boolean;

/**
 * Parse a single cron field into a matcher function.
 * @param field - The cron field string (e.g., "*/15", "1-5", "1,3,5")
 * @param min - Minimum valid value for this field
 * @param max - Maximum valid value for this field
 */
export function parseCronField(field: string, min: number, max: number): FieldMatcher {
  // Wildcard
  if (field === '*') return () => true;

  // List (must check before range/step since lists can contain ranges)
  if (field.includes(',')) {
    const matchers = field.split(',').map(part => parseCronField(part.trim(), min, max));
    return (value: number) => matchers.some(m => m(value));
  }

  // Step (*/N or range/N)
  if (field.includes('/')) {
    const [base, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${field}`);

    if (base === '*') {
      return (value: number) => value % step === 0;
    }
    // Range with step
    const rangeMatcher = parseRange(base, min, max);
    return (value: number) => {
      if (!rangeMatcher.inRange(value)) return false;
      return (value - rangeMatcher.start) % step === 0;
    };
  }

  // Range (N-M)
  if (field.includes('-')) {
    const range = parseRange(field, min, max);
    return (value: number) => value >= range.start && value <= range.end;
  }

  // Literal
  const num = parseInt(field, 10);
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid cron field value: ${field} (expected ${String(min)}-${String(max)})`);
  }
  return (value: number) => value === num;
}

function parseRange(
  field: string,
  min: number,
  max: number
): { start: number; end: number; inRange: (v: number) => boolean } {
  const [startStr, endStr] = field.split('-');
  const start = parseInt(startStr, 10);
  const end = parseInt(endStr, 10);
  if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
    throw new Error(`Invalid cron range: ${field} (expected ${String(min)}-${String(max)})`);
  }
  return {
    start,
    end,
    inRange: (v: number) => v >= start && v <= end,
  };
}

/**
 * Check if a cron expression matches a given date.
 * @param expression - 5-field cron expression (minute hour dom month dow)
 * @param date - The date to check against
 * @returns true if the expression matches the date
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${String(fields.length)}`);
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minute = parseCronField(minuteField, 0, 59);
  const hour = parseCronField(hourField, 0, 23);
  const dom = parseCronField(domField, 1, 31);
  const month = parseCronField(monthField, 1, 12);
  const dow = parseCronField(dowField, 0, 6);

  return (
    minute(date.getUTCMinutes()) &&
    hour(date.getUTCHours()) &&
    dom(date.getUTCDate()) &&
    month(date.getUTCMonth() + 1) &&
    dow(date.getUTCDay())
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/services/cron-parser.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/cron-parser.ts packages/core/src/services/cron-parser.test.ts
git commit -m "feat(core): add lightweight cron expression parser

5-field cron parser supporting wildcards, ranges, steps, and lists.
Used by the workflow scheduler to evaluate schedule triggers."
```

---

### Task 2: Schedule adapter (logging-only IWorkflowPlatform)

**Files:**
- Create: `packages/core/src/services/schedule-adapter.ts`

- [ ] **Step 1: Create the schedule adapter**

Create `packages/core/src/services/schedule-adapter.ts`:

```typescript
/**
 * Minimal IWorkflowPlatform for scheduled workflow runs.
 * Logs messages via Pino instead of sending to a chat platform.
 */
import type { IWorkflowPlatform, WorkflowMessageMetadata } from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('schedule.adapter');
  return cachedLog;
}

export class SchedulePlatformAdapter implements IWorkflowPlatform {
  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: WorkflowMessageMetadata
  ): Promise<void> {
    getLog().debug(
      { conversationId, messageLength: message.length },
      'schedule.message'
    );
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'schedule';
  }
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/services/schedule-adapter.ts
git commit -m "feat(core): add schedule platform adapter

Minimal IWorkflowPlatform that logs workflow messages via Pino
instead of sending to a chat platform. Used for scheduled runs."
```

---

### Task 3: Config type and loader changes

**Files:**
- Modify: `packages/core/src/config/config-types.ts`
- Modify: `packages/core/src/config/config-loader.ts`

- [ ] **Step 1: Add ScheduleEntry to config types**

In `packages/core/src/config/config-types.ts`, add the `ScheduleEntry` interface and update both `RepoConfig` and `MergedConfig`.

Add before the `RepoConfig` interface (around line 106):

```typescript
/**
 * A scheduled workflow trigger entry.
 * Defined in per-repo .archon/config.yaml under `schedules:`.
 */
export interface ScheduleEntry {
  /** Workflow name — resolved via findWorkflow() at load time */
  workflow: string;
  /** Standard 5-field cron expression (minute hour dom month dow) */
  cron: string;
  /** Whether this schedule is active. @default true */
  enabled?: boolean;
}
```

Add to the `RepoConfig` interface (after the `allow_target_repo_keys` field, around line 182):

```typescript
  /**
   * Scheduled workflow triggers for this repository.
   * Each entry specifies a workflow name and cron expression.
   */
  schedules?: ScheduleEntry[];
```

Add to the `MergedConfig` interface (after `allowTargetRepoKeys`, around line 273):

```typescript
  /**
   * Active scheduled workflow triggers collected from repo config.
   * Empty array when no schedules are configured.
   */
  schedules: ScheduleEntry[];
```

- [ ] **Step 2: Update config loader defaults and merge**

In `packages/core/src/config/config-loader.ts`:

In `getDefaults()` (around line 190), add `schedules: []` to the returned object (after `allowTargetRepoKeys: false`):

```typescript
    allowTargetRepoKeys: false,
    schedules: [],
```

In `mergeRepoConfig()` (around line 398, after the `allow_target_repo_keys` block and before `return result`), add:

```typescript
  // Propagate schedule entries from repo config
  if (repo.schedules && Array.isArray(repo.schedules)) {
    result.schedules = repo.schedules
      .filter(s => s.workflow && s.cron)
      .map(s => ({
        workflow: s.workflow,
        cron: s.cron,
        enabled: s.enabled ?? true,
      }));
  }
```

- [ ] **Step 3: Verify type-check and lint pass**

Run: `bun run type-check && bun run lint --max-warnings 0`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/config-types.ts packages/core/src/config/config-loader.ts
git commit -m "feat(core): add schedules config to RepoConfig and MergedConfig

New ScheduleEntry type with workflow, cron, and enabled fields.
Parsed from per-repo .archon/config.yaml schedules: array.
Invalid entries (missing workflow or cron) are filtered out."
```

---

### Task 4: Workflow scheduler service

**Files:**
- Create: `packages/core/src/services/workflow-scheduler.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Create the scheduler service**

Create `packages/core/src/services/workflow-scheduler.ts`:

```typescript
/**
 * Workflow scheduler service — fires workflows on cron schedules.
 *
 * Follows the cleanup-service.ts lifecycle pattern:
 * - startWorkflowScheduler() / stopWorkflowScheduler()
 * - Single setInterval tick loop (60s)
 * - Scans registered codebases for schedule configs
 * - Dispatches via executeWorkflow() with a logging-only adapter
 */
import { createLogger } from '@archon/paths';
import { matchesCron } from './cron-parser';
import { SchedulePlatformAdapter } from './schedule-adapter';
import { loadConfig } from '../config/config-loader';
import * as codebaseDb from '../db/codebases';
import { createWorkflowDeps } from '../workflows/store-adapter';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow } from '@archon/workflows/router';
import { executeWorkflow } from '@archon/workflows/executor';
import * as conversationDb from '../db/conversations';
import type { ScheduleEntry } from '../config/config-types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.scheduler');
  return cachedLog;
}

/** Tick interval: 60 seconds (cron minimum granularity) */
const TICK_INTERVAL_MS = 60_000;
/** Rescan interval: every 5 minutes, reload codebase configs */
const RESCAN_INTERVAL_TICKS = 5;

interface ResolvedSchedule {
  codebaseId: string;
  codebaseName: string;
  cwd: string;
  entry: ScheduleEntry;
}

let tickIntervalId: ReturnType<typeof setInterval> | undefined;
let resolvedSchedules: ResolvedSchedule[] = [];
let tickCount = 0;

/**
 * Scan all registered codebases and collect active schedule entries.
 */
async function rescanSchedules(): Promise<void> {
  try {
    const codebases = await codebaseDb.listCodebases();
    const schedules: ResolvedSchedule[] = [];

    for (const cb of codebases) {
      try {
        const config = await loadConfig(cb.default_cwd);
        for (const entry of config.schedules) {
          if (entry.enabled === false) continue;
          schedules.push({
            codebaseId: cb.id,
            codebaseName: cb.name,
            cwd: cb.default_cwd,
            entry,
          });
        }
      } catch (error) {
        getLog().debug(
          { err: error as Error, codebaseId: cb.id, cwd: cb.default_cwd },
          'scheduler.config_load_failed'
        );
      }
    }

    resolvedSchedules = schedules;
    if (schedules.length > 0) {
      getLog().info(
        { count: schedules.length, codebases: [...new Set(schedules.map(s => s.codebaseName))] },
        'scheduler.rescan_completed'
      );
    }
  } catch (error) {
    getLog().error({ err: error as Error }, 'scheduler.rescan_failed');
  }
}

/**
 * Process a single tick: check all schedules and dispatch due workflows.
 */
async function tick(): Promise<void> {
  tickCount++;

  // Rescan configs periodically
  if (tickCount % RESCAN_INTERVAL_TICKS === 0) {
    await rescanSchedules();
  }

  if (resolvedSchedules.length === 0) return;

  const now = new Date();
  const deps = createWorkflowDeps();
  const adapter = new SchedulePlatformAdapter();

  for (const schedule of resolvedSchedules) {
    try {
      if (!matchesCron(schedule.entry.cron, now)) continue;

      // Check for active run on same path (skip if already running)
      const activeRun = await deps.store.getActiveWorkflowRunByPath(schedule.cwd);
      if (activeRun) {
        getLog().debug(
          {
            workflowName: schedule.entry.workflow,
            codebase: schedule.codebaseName,
            activeRunId: activeRun.id,
          },
          'scheduler.skip_active_run'
        );
        continue;
      }

      // Discover workflows for this codebase
      const config = await loadConfig(schedule.cwd);
      const { workflows } = await discoverWorkflowsWithConfig(schedule.cwd, config);
      const workflow = findWorkflow(schedule.entry.workflow, [...workflows]);
      if (!workflow) {
        getLog().warn(
          { workflowName: schedule.entry.workflow, codebase: schedule.codebaseName },
          'scheduler.workflow_not_found'
        );
        continue;
      }

      // Create a synthetic conversation for this scheduled run
      const conversationId = `schedule-${schedule.entry.workflow}-${Date.now()}`;
      const conversation = await conversationDb.createConversation(
        'schedule',
        conversationId,
        schedule.codebaseId
      );
      // Mark as hidden (worker conversation) so it doesn't clutter the UI listing
      await conversationDb.updateConversation(conversation.id, { hidden: true });

      const userMessage = `Scheduled run (${schedule.entry.cron})`;

      getLog().info(
        {
          workflowName: workflow.name,
          codebase: schedule.codebaseName,
          cron: schedule.entry.cron,
          conversationId: conversation.id,
        },
        'scheduler.dispatch_started'
      );

      // Fire-and-forget — don't block the tick loop
      executeWorkflow(
        deps,
        adapter,
        conversationId,
        schedule.cwd,
        workflow,
        userMessage,
        conversation.id,
        schedule.codebaseId
      )
        .then(result => {
          getLog().info(
            {
              workflowName: workflow.name,
              codebase: schedule.codebaseName,
              success: result.success,
              runId: result.workflowRunId,
            },
            'scheduler.dispatch_completed'
          );
        })
        .catch(error => {
          getLog().error(
            { err: error as Error, workflowName: workflow.name, codebase: schedule.codebaseName },
            'scheduler.dispatch_failed'
          );
        });
    } catch (error) {
      getLog().error(
        {
          err: error as Error,
          workflowName: schedule.entry.workflow,
          codebase: schedule.codebaseName,
        },
        'scheduler.tick_error'
      );
    }
  }
}

/**
 * Start the workflow scheduler. Scans codebases for schedule configs
 * and begins the 60-second tick loop.
 */
export async function startWorkflowScheduler(): Promise<void> {
  if (tickIntervalId) {
    getLog().warn('scheduler.already_running');
    return;
  }

  await rescanSchedules();

  if (resolvedSchedules.length === 0) {
    getLog().info('scheduler.no_schedules_configured');
  }

  tickIntervalId = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  getLog().info(
    { tickIntervalMs: TICK_INTERVAL_MS, scheduleCount: resolvedSchedules.length },
    'scheduler.started'
  );
}

/**
 * Stop the workflow scheduler.
 */
export function stopWorkflowScheduler(): void {
  if (tickIntervalId) {
    clearInterval(tickIntervalId);
    tickIntervalId = undefined;
    resolvedSchedules = [];
    tickCount = 0;
    getLog().info('scheduler.stopped');
  }
}
```

- [ ] **Step 2: Export from @archon/core index**

In `packages/core/src/index.ts`, find the Services section (around line 113) and add:

```typescript
export {
  startWorkflowScheduler,
  stopWorkflowScheduler,
} from './services/workflow-scheduler';
```

- [ ] **Step 3: Wire into server startup/shutdown**

In `packages/server/src/index.ts`, find the import from `@archon/core` (the large destructured import). Add `startWorkflowScheduler` and `stopWorkflowScheduler` to it.

Find `startCleanupScheduler();` (around line 251) and add after it:

```typescript
  // Start workflow scheduler (fires workflows on cron schedules)
  void startWorkflowScheduler();
```

Find `stopCleanupScheduler();` in the shutdown handler and add after it:

```typescript
    stopWorkflowScheduler();
```

- [ ] **Step 4: Verify type-check and lint pass**

Run: `bun run type-check && bun run lint --max-warnings 0`
Expected: PASS.

- [ ] **Step 5: Format and commit**

Run: `bun run format`

```bash
git add packages/core/src/services/workflow-scheduler.ts packages/core/src/services/schedule-adapter.ts packages/core/src/index.ts packages/server/src/index.ts
git commit -m "feat(core,server): add workflow scheduler service

60-second tick loop evaluates cron schedules from per-repo config.
Dispatches workflows via executeWorkflow() with a logging-only adapter.
Skips if a run is already active for the same workflow+path.
Rescans codebase configs every 5 minutes."
```

---

### Task 5: Add cron-parser.test.ts to core test batch and run full validation

**Files:**
- Modify: `packages/core/package.json` (add test file to existing batch)

- [ ] **Step 1: Add cron-parser.test.ts to the test script**

In `packages/core/package.json`, find the large `bun test` batch that includes `src/config/` and `src/state/`. It looks like:

```
bun test src/db/adapters/sqlite.test.ts ... src/config/ src/state/
```

Add `src/services/cron-parser.test.ts` to the end of this batch (before the `&&`):

```
src/config/ src/state/ src/services/cron-parser.test.ts
```

The cron parser test has zero `mock.module()` calls, so it's safe in this batch.

- [ ] **Step 2: Run the full validation**

Run: `bun run validate`
Expected: type-check, lint, format all pass. Tests pass (except pre-existing @archon/core ClaudeClient failures).

- [ ] **Step 3: Run just the cron parser tests to confirm they're in the batch**

Run: `bun --filter @archon/core test 2>&1 | grep -E "cron|services"`
Expected: Shows cron-parser tests running within the batch.

- [ ] **Step 4: Commit if package.json changed**

```bash
git add packages/core/package.json
git commit -m "chore(core): add cron-parser tests to test batch"
```
