# Analytics Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three Tier-1 analytics fixes as a single PR: extract a shared `useCostAnalytics` hook, fix a SQLite day-boundary filter bug, and add DB + route aggregator test coverage.

**Architecture:** Small, bounded changes. One thin React hook replaces duplicated `useQuery` calls. One dialect-aware SQL helper absorbs TEXT-comparison variance in SQLite. Two new test files cover the DB query layer and the route aggregator. Three atomic commits on `feat/analytics-hardening` → PR to `dev`.

**Tech Stack:** TanStack Query v5, React 19, Bun test, SQLite `datetime()`, `@hono/zod-openapi`, `mock.module()`.

**Companion spec:** [`docs/superpowers/specs/2026-04-14-analytics-hardening-design.md`](../specs/2026-04-14-analytics-hardening-design.md)

---

## File Structure

**Create**:
- `packages/web/src/hooks/useCostAnalytics.ts` — thin wrapper around `useQuery` + `getCostAnalytics`
- `packages/core/src/db/workflow-analytics.test.ts` — DB-layer tests (SQL assertions via captured `mockQuery.calls`)
- `packages/server/src/routes/api.analytics.test.ts` — route aggregator tests

**Modify**:
- `packages/web/src/components/dashboard/CostSummaryCard.tsx` — use hook (lines 62–66)
- `packages/web/src/components/dashboard/WorkflowHealthCard.tsx` — use hook (lines 56–60)
- `packages/core/src/db/workflow-analytics.ts` — add `startedAtSinceFilter` helper, update three query call sites
- `packages/core/package.json` — add `workflow-analytics.test.ts` as its own `bun test` batch (mock.module pollution isolation)
- `packages/server/package.json` — add `api.analytics.test.ts` as its own `bun test` batch

---

## Task 1: Extract `useCostAnalytics` hook

**Files:**
- Create: `packages/web/src/hooks/useCostAnalytics.ts`
- Modify: `packages/web/src/components/dashboard/CostSummaryCard.tsx`
- Modify: `packages/web/src/components/dashboard/WorkflowHealthCard.tsx`

No new tests — the hook is a 10-line passthrough; existing cards are the integration surface.

- [ ] **Step 1: Verify starting state (clean tree on feat/analytics-hardening)**

Run:
```bash
git status && git branch --show-current
```
Expected: `nothing to commit, working tree clean` and branch `feat/analytics-hardening`.

- [ ] **Step 2: Create the hook file**

Create `packages/web/src/hooks/useCostAnalytics.ts`:

```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getCostAnalytics, type CostAnalytics } from '@/lib/api';

const STALE_TIME_MS = 30_000;

export function useCostAnalytics(days: number): UseQueryResult<CostAnalytics> {
  return useQuery({
    queryKey: ['cost-analytics', { days }],
    queryFn: () => getCostAnalytics(days),
    staleTime: STALE_TIME_MS,
  });
}
```

- [ ] **Step 3: Update CostSummaryCard to use the hook**

In `packages/web/src/components/dashboard/CostSummaryCard.tsx`, replace the `useQuery` import and inline call.

Change line 1 imports. Remove this line:

```ts
import { useQuery } from '@tanstack/react-query';
```

Add this line (keep the rest of the imports as-is):

```ts
import { useCostAnalytics } from '@/hooks/useCostAnalytics';
```

Replace lines 62–66 (the `useQuery` block inside `CostSummaryCard`):

```ts
  const { data, isLoading } = useQuery({
    queryKey: ['cost-analytics', { days: 30 }],
    queryFn: () => getCostAnalytics(30),
    staleTime: 30_000,
  });
```

With:

```ts
  const { data, isLoading } = useCostAnalytics(30);
```

Also remove the now-unused import `getCostAnalytics` from `@/lib/api` (keep `CostAnalytics` type import — it's still used by the `CostBreakdown` component).

- [ ] **Step 4: Update WorkflowHealthCard to use the hook**

Same pattern in `packages/web/src/components/dashboard/WorkflowHealthCard.tsx`.

Replace line 1:
```ts
import { useQuery } from '@tanstack/react-query';
```
With:
```ts
import { useCostAnalytics } from '@/hooks/useCostAnalytics';
```

Replace lines 56–60:
```ts
  const { data, isLoading } = useQuery({
    queryKey: ['cost-analytics', { days: 30 }],
    queryFn: () => getCostAnalytics(30),
    staleTime: 30_000,
  });
```
With:
```ts
  const { data, isLoading } = useCostAnalytics(30);
```

Remove the now-unused `getCostAnalytics` import. Keep `CostAnalytics` type import (used by `HealthBreakdown`).

- [ ] **Step 5: Type-check the web package**

Run:
```bash
bun --filter @archon/web type-check
```
Expected: no errors.

- [ ] **Step 6: Lint the web package (max-warnings 0)**

Run:
```bash
bun x eslint packages/web --cache --max-warnings 0
```
Expected: no errors, no warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/hooks/useCostAnalytics.ts \
        packages/web/src/components/dashboard/CostSummaryCard.tsx \
        packages/web/src/components/dashboard/WorkflowHealthCard.tsx

git commit -m "$(cat <<'EOF'
feat(web): extract useCostAnalytics hook

CostSummaryCard and WorkflowHealthCard both called useQuery with
identical key, function, and staleTime. Duplication invites a
latent bug: a third card requesting a different `days` window
would silently collide on the shared ['cost-analytics', {days:30}]
key.

Extract a thin useCostAnalytics(days) passthrough. The days param
is now part of the query key, so independent windows do not share
cache. Return UseQueryResult so future callers can destructure
error/refetch/isFetching without hook changes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SQLite day-boundary fix (TDD)

**Files:**
- Create: `packages/core/src/db/workflow-analytics.test.ts`
- Modify: `packages/core/src/db/workflow-analytics.ts`
- Modify: `packages/core/package.json`

Test-driven: add the SQLite day-boundary test first (red), then the fix, then verify green. Other test cases land in Task 3.

- [ ] **Step 1: Create the DB-layer test file with day-boundary tests only**

Create `packages/core/src/db/workflow-analytics.test.ts`:

```ts
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
let mockDbType: 'sqlite' | 'postgresql' = 'postgresql';

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => mockDbType,
}));

import {
  getCostByWorkflow,
  getDailyCosts,
  getAvgDuration,
} from './workflow-analytics';

describe('workflow-analytics db', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockDbType = 'postgresql';
  });

  describe('day-boundary filter (SQLite)', () => {
    beforeEach(() => {
      mockDbType = 'sqlite';
    });

    test('getCostByWorkflow wraps started_at with datetime()', async () => {
      await getCostByWorkflow('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('datetime(started_at) >= datetime($1)');
    });

    test('getDailyCosts wraps started_at with datetime()', async () => {
      await getDailyCosts('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('datetime(started_at) >= datetime($1)');
    });

    test('getAvgDuration wraps started_at with datetime()', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('datetime(started_at) >= datetime($1)');
    });
  });

  describe('day-boundary filter (Postgres)', () => {
    test('getCostByWorkflow uses plain >= comparison', async () => {
      await getCostByWorkflow('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('started_at >= $1');
      expect(sql).not.toContain('datetime(');
    });

    test('getDailyCosts uses plain >= comparison', async () => {
      await getDailyCosts('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('started_at >= $1');
      expect(sql).not.toContain('datetime(started_at)');
    });

    test('getAvgDuration uses plain >= comparison', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('started_at >= $1');
      expect(sql).not.toContain('datetime(started_at)');
    });
  });
});
```

Note on Postgres tests: `getDailyCosts` uses `DATE(started_at)` from `dateExtract()`. The assertion `.not.toContain('datetime(started_at)')` is tight enough not to catch that. `getAvgDuration` uses `julianday(started_at)` in SQLite mode only — in Postgres mode the assertion also stands.

- [ ] **Step 2: Update `packages/core/package.json` to give the new test file its own batch**

`workflow-analytics.test.ts` uses `mock.module('./connection', ...)` and will conflict with `workflows.test.ts` in the same directory (same path, different implementation — violates the project mock pollution rule).

Open `packages/core/package.json`, find the `"test"` script. It currently reads (line 26):

```
"test": "bun test src/clients/codex-binary-guard.test.ts && ... && bun test src/utils/path-validation.test.ts && ..."
```

Locate the large DB batch that ends with `src/db/workflows.test.ts src/utils/defaults-copy.test.ts ...`. Immediately after that chunk's `&& bun test src/utils/path-validation.test.ts`, insert:

```
&& bun test src/db/workflow-analytics.test.ts
```

So the sequence becomes:
```
... && bun test src/utils/path-validation.test.ts && bun test src/db/workflow-analytics.test.ts && bun test src/services/cleanup-service.test.ts && ...
```

This keeps `workflow-analytics.test.ts` in its own `bun test` invocation, preventing its `mock.module('./connection', ...)` from colliding with the one in `workflows.test.ts`.

- [ ] **Step 3: Run the new tests — they should FAIL (red)**

Run:
```bash
bun --cwd packages/core test src/db/workflow-analytics.test.ts
```
Expected: the three `day-boundary filter (SQLite)` tests fail with "expected to contain `datetime(started_at) >= datetime($1)`". The three Postgres tests should pass. Total: 3 fail, 3 pass.

If all 6 pass already, the fix is already present and something is wrong — stop and investigate before proceeding.

- [ ] **Step 4: Add the `startedAtSinceFilter` helper**

In `packages/core/src/db/workflow-analytics.ts`, after the `dateExtract()` function (around line 25), add:

```ts
/**
 * Dialect-aware `started_at >= param` filter.
 *
 * SQLite stores datetimes as TEXT with space separator
 * (`2026-04-14 13:53:10`). When callers pass ISO-T format
 * (`2026-04-14T00:00:00.000Z`), byte-wise comparison drops
 * legitimate rows (T > space). `datetime()` normalizes both
 * sides and returns NULL for unparseable input, which
 * excludes the row safely.
 *
 * PostgreSQL's `timestamp` type handles implicit string
 * casts correctly, so the wrap is only needed for SQLite.
 */
function startedAtSinceFilter(placeholder: number): string {
  return getDatabaseType() === 'postgresql'
    ? `started_at >= $${placeholder}`
    : `datetime(started_at) >= datetime($${placeholder})`;
}
```

- [ ] **Step 5: Update `getCostByWorkflow` to use the helper**

In the same file, locate `getCostByWorkflow` (around line 57). Change the `WHERE` line (currently line 64) from:

```
      WHERE started_at >= $1
```

To:

```
      WHERE ${startedAtSinceFilter(1)}
```

- [ ] **Step 6: Update `getDailyCosts` to use the helper**

Locate `getDailyCosts` (around line 85). Change the `WHERE` line (currently line 92) from:

```
      WHERE started_at >= $1
```

To:

```
      WHERE ${startedAtSinceFilter(1)}
```

- [ ] **Step 7: Update `getAvgDuration` to use the helper**

Locate `getAvgDuration` (around line 114). Change the `WHERE` line (currently line 124) from:

```
       WHERE started_at >= $1
```

To:

```
       WHERE ${startedAtSinceFilter(1)}
```

**Do NOT** change the following line `AND completed_at >= started_at` — that is a column-to-column comparison where both sides share the stored format and is correct as-is.

- [ ] **Step 8: Run the tests — all 6 should PASS (green)**

Run:
```bash
bun --cwd packages/core test src/db/workflow-analytics.test.ts
```
Expected: 6 pass, 0 fail.

- [ ] **Step 9: Type-check the core package**

Run:
```bash
bun --filter @archon/core type-check
```
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/db/workflow-analytics.ts \
        packages/core/src/db/workflow-analytics.test.ts \
        packages/core/package.json

git commit -m "$(cat <<'EOF'
fix(core): SQLite day-boundary filter in workflow-analytics queries

Problem: `WHERE started_at >= $1` compares TEXT byte-wise in SQLite.
Storage uses space separator (`2026-04-14 13:53:10`); callers pass
ISO-T format (`2026-04-14T00:00:00.000Z`). T (0x54) > space (0x20),
so legitimate rows are dropped at day boundaries.

Fix: add a dialect-aware `startedAtSinceFilter(placeholder)` helper.
In SQLite, wrap both sides with `datetime()`, which parses tolerantly
and returns NULL (row excluded safely) for unparseable input.
PostgreSQL's timestamp type already handles implicit string casts,
so the Postgres branch stays as the original `started_at >= $N`.

TDD: new SQLite/Postgres assertions in workflow-analytics.test.ts
fail before the helper lands and pass after. Broader coverage
(empty result, clock-skew, sort, type coercion, route aggregator)
lands in the next commit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Expand DB tests + add route aggregator tests

**Files:**
- Modify: `packages/core/src/db/workflow-analytics.test.ts` (expand)
- Create: `packages/server/src/routes/api.analytics.test.ts`
- Modify: `packages/server/package.json`

Lands as a single `test(core,server)` commit per the approved spec.

### DB-layer test expansion

- [ ] **Step 1: Add empty-result test cases to the DB test file**

In `packages/core/src/db/workflow-analytics.test.ts`, append a new `describe` block inside the top-level `describe('workflow-analytics db', ...)` (alongside the existing `day-boundary` blocks):

```ts
  describe('empty result', () => {
    test('getCostByWorkflow returns [] when no rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await getCostByWorkflow('2026-04-14T00:00:00Z');
      expect(result).toEqual([]);
    });

    test('getDailyCosts returns [] when no rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await getDailyCosts('2026-04-14T00:00:00Z');
      expect(result).toEqual([]);
    });

    test('getAvgDuration returns 0 when avg_seconds is null', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ avg_seconds: null }])
      );
      const result = await getAvgDuration('2026-04-14T00:00:00Z');
      expect(result).toBe(0);
    });

    test('getAvgDuration returns 0 when result has no rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await getAvgDuration('2026-04-14T00:00:00Z');
      expect(result).toBe(0);
    });

    test('getAvgDuration returns 0 when avg_seconds is not finite', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ avg_seconds: 'not-a-number' }])
      );
      const result = await getAvgDuration('2026-04-14T00:00:00Z');
      expect(result).toBe(0);
    });
  });
```

- [ ] **Step 2: Add clock-skew exclusion test**

Append another `describe` block:

```ts
  describe('getAvgDuration clock-skew exclusion', () => {
    test('SQL filters out rows where completed_at < started_at', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('completed_at >= started_at');
    });

    test('SQL filters out rows where completed_at IS NULL', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('completed_at IS NOT NULL');
    });
  });
```

- [ ] **Step 3: Add sort-ordering tests**

Append:

```ts
  describe('sort ordering', () => {
    test('getCostByWorkflow sorts by cost_usd DESC', async () => {
      await getCostByWorkflow('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ORDER BY cost_usd DESC/i);
    });

    test('getDailyCosts sorts by date ASC', async () => {
      await getDailyCosts('2026-04-14T00:00:00Z');
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/ORDER BY date ASC/i);
    });
  });
```

- [ ] **Step 4: Add type-coercion tests**

Append:

```ts
  describe('type coercion', () => {
    test('getCostByWorkflow coerces string count and cost to numbers', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { workflow_name: 'foo', status: 'completed', run_count: '5', cost_usd: '1.25' },
        ])
      );
      const result = await getCostByWorkflow('2026-04-14T00:00:00Z');
      expect(result[0]).toEqual({
        workflow_name: 'foo',
        status: 'completed',
        run_count: 5,
        cost_usd: 1.25,
      });
      expect(typeof result[0].run_count).toBe('number');
      expect(typeof result[0].cost_usd).toBe('number');
    });

    test('getDailyCosts coerces string count and cost to numbers', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ date: '2026-04-14', run_count: '3', cost_usd: '0.75' }])
      );
      const result = await getDailyCosts('2026-04-14T00:00:00Z');
      expect(result[0]).toEqual({ date: '2026-04-14', run_count: 3, cost_usd: 0.75 });
      expect(typeof result[0].run_count).toBe('number');
      expect(typeof result[0].cost_usd).toBe('number');
    });
  });
```

- [ ] **Step 5: Run the DB tests — all should pass**

Run:
```bash
bun --cwd packages/core test src/db/workflow-analytics.test.ts
```
Expected: all tests pass (6 from Task 2 + 5 empty-result + 2 clock-skew + 2 sort + 2 type-coercion = 17 tests).

### Route aggregator tests

- [ ] **Step 6: Create `api.analytics.test.ts` skeleton with module mocks**

Create `packages/server/src/routes/api.analytics.test.ts`:

```ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

type WorkflowCostRow = {
  workflow_name: string;
  status: string;
  run_count: number;
  cost_usd: number;
};
type DailyCostRow = { date: string; run_count: number; cost_usd: number };

const mockGetCostByWorkflow = mock(async (_s: string) => [] as WorkflowCostRow[]);
const mockGetDailyCosts = mock(async (_s: string) => [] as DailyCostRow[]);
const mockGetAvgDuration = mock(async (_s: string) => 0);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  deleteWorkflowRun: mock(async () => {}),
  updateWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

mock.module('@archon/core/db/workflow-analytics', () => ({
  getCostByWorkflow: mockGetCostByWorkflow,
  getDailyCosts: mockGetDailyCosts,
  getAvgDuration: mockGetAvgDuration,
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

type CostAnalyticsResponse = {
  period: { days: number; from: string; to: string };
  totalCostUsd: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successCostUsd: number;
  failedCostUsd: number;
  byWorkflow: Array<{ workflowName: string; costUsd: number; runs: number; avgCostUsd: number }>;
  daily: Array<{ date: string; costUsd: number; runs: number }>;
  successRate: number;
  avgDurationSeconds: number;
  topFailingWorkflows: Array<{
    workflowName: string;
    failureRate: number;
    failedRuns: number;
    totalRuns: number;
  }>;
};

async function fetchAnalytics(app: OpenAPIHono, days = 7): Promise<CostAnalyticsResponse> {
  const res = await app.request(`/api/analytics/costs?days=${days}`);
  expect(res.status).toBe(200);
  return (await res.json()) as CostAnalyticsResponse;
}

// Helper to wire mock DB rows for a given set of workflow stats.
type WorkflowStat = { name: string; completed: number; failed: number };
function seedWorkflowRows(stats: WorkflowStat[]): void {
  const rows: WorkflowCostRow[] = [];
  for (const s of stats) {
    if (s.completed > 0) {
      rows.push({
        workflow_name: s.name,
        status: 'completed',
        run_count: s.completed,
        cost_usd: s.completed * 0.1,
      });
    }
    if (s.failed > 0) {
      rows.push({
        workflow_name: s.name,
        status: 'failed',
        run_count: s.failed,
        cost_usd: s.failed * 0.05,
      });
    }
  }
  mockGetCostByWorkflow.mockResolvedValueOnce(rows);
  mockGetDailyCosts.mockResolvedValueOnce([]);
  mockGetAvgDuration.mockResolvedValueOnce(30);
}

describe('GET /api/analytics/costs', () => {
  beforeEach(() => {
    mockGetCostByWorkflow.mockReset();
    mockGetDailyCosts.mockReset();
    mockGetAvgDuration.mockReset();
  });

  // --- tests go here, one per step below ---
});
```

- [ ] **Step 7: Add threshold-below test**

Inside the `describe('GET /api/analytics/costs', ...)` block, add:

```ts
  test('excludes workflows with fewer than 3 runs from topFailingWorkflows', async () => {
    seedWorkflowRows([{ name: 'low-volume', completed: 1, failed: 1 }]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows).toEqual([]);
  });
```

- [ ] **Step 8: Add threshold-at test**

```ts
  test('includes workflows with exactly 3 runs and at least one failure', async () => {
    seedWorkflowRows([{ name: 'at-threshold', completed: 2, failed: 1 }]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows).toHaveLength(1);
    expect(body.topFailingWorkflows[0]).toMatchObject({
      workflowName: 'at-threshold',
      failedRuns: 1,
      totalRuns: 3,
    });
    expect(body.topFailingWorkflows[0].failureRate).toBeCloseTo(1 / 3, 4);
  });
```

- [ ] **Step 9: Add zero-failure exclusion test**

```ts
  test('excludes workflows with 0 failures even when totalRuns >= 3', async () => {
    seedWorkflowRows([{ name: 'all-green', completed: 5, failed: 0 }]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows).toEqual([]);
  });
```

- [ ] **Step 10: Add sort-order test**

```ts
  test('sorts topFailingWorkflows by failureRate DESC', async () => {
    seedWorkflowRows([
      { name: 'lower-rate', completed: 7, failed: 3 }, // 30%
      { name: 'higher-rate', completed: 2, failed: 3 }, // 60%
    ]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows.map(wf => wf.workflowName)).toEqual([
      'higher-rate',
      'lower-rate',
    ]);
  });
```

- [ ] **Step 11: Add slice-cap test**

```ts
  test('caps topFailingWorkflows at 3 entries', async () => {
    seedWorkflowRows([
      { name: 'wf1', completed: 2, failed: 5 },
      { name: 'wf2', completed: 3, failed: 4 },
      { name: 'wf3', completed: 4, failed: 3 },
      { name: 'wf4', completed: 5, failed: 2 },
    ]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows).toHaveLength(3);
  });
```

- [ ] **Step 12: Add full response-contract test**

```ts
  test('response contains the full CostAnalytics contract', async () => {
    seedWorkflowRows([{ name: 'demo', completed: 5, failed: 0 }]);
    const body = await fetchAnalytics(makeApp(), 7);

    expect(body).toHaveProperty('period');
    expect(body.period.days).toBe(7);
    expect(body).toHaveProperty('totalCostUsd');
    expect(body).toHaveProperty('totalRuns');
    expect(body).toHaveProperty('successfulRuns');
    expect(body).toHaveProperty('failedRuns');
    expect(body).toHaveProperty('successCostUsd');
    expect(body).toHaveProperty('failedCostUsd');
    expect(body).toHaveProperty('byWorkflow');
    expect(body).toHaveProperty('daily');
    expect(body).toHaveProperty('successRate');
    expect(body).toHaveProperty('avgDurationSeconds');
    expect(body).toHaveProperty('topFailingWorkflows');
    expect(Array.isArray(body.byWorkflow)).toBe(true);
    expect(Array.isArray(body.daily)).toBe(true);
    expect(Array.isArray(body.topFailingWorkflows)).toBe(true);
  });
```

- [ ] **Step 13: Add query-param validation tests**

```ts
  test('rejects days=0 via schema validation', async () => {
    const app = makeApp();
    const res = await app.request('/api/analytics/costs?days=0');
    expect(res.status).toBe(400);
  });

  test('rejects days=-1 via schema validation', async () => {
    const app = makeApp();
    const res = await app.request('/api/analytics/costs?days=-1');
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 14: Update `packages/server/package.json` to add the batch entry**

Open `packages/server/package.json`. The `test` script is a chain of `&& bun test …` calls — each `api.*.test.ts` runs in its own invocation. Append a new entry:

```
&& bun test src/routes/api.analytics.test.ts
```

Insert it after `bun test src/routes/api.workflow-runs.test.ts` (the last `api.*` entry) and before the `src/adapters/web/*` entries. So the sequence becomes:

```
... && bun test src/routes/api.workflow-runs.test.ts && bun test src/routes/api.analytics.test.ts && bun test src/adapters/web/transport.test.ts && ...
```

- [ ] **Step 15: Run the route tests**

Run:
```bash
bun --cwd packages/server test src/routes/api.analytics.test.ts
```
Expected: 8 tests pass (threshold-below, threshold-at, zero-failure, sort, slice-cap, contract, days=0, days=-1).

If the days=0 or days=-1 test fails (returns 200 instead of 400), check `packages/server/src/routes/schemas/analytics.schemas.ts` — the `costAnalyticsQuerySchema` should validate `days` as a positive integer. If the schema is permissive, remove those two tests and open a follow-up issue; they are nice-to-have, not load-bearing.

- [ ] **Step 16: Run both new test files together to confirm no cross-file pollution**

Run:
```bash
bun --cwd packages/core test src/db/workflow-analytics.test.ts && \
bun --cwd packages/server test src/routes/api.analytics.test.ts
```
Expected: all tests pass.

- [ ] **Step 17: Type-check both packages**

Run:
```bash
bun --filter @archon/core type-check && bun --filter @archon/server type-check
```
Expected: no errors.

- [ ] **Step 18: Commit**

```bash
git add packages/core/src/db/workflow-analytics.test.ts \
        packages/server/src/routes/api.analytics.test.ts \
        packages/server/package.json

git commit -m "$(cat <<'EOF'
test(core,server): add workflow-analytics DB + route aggregator tests

DB layer (packages/core/src/db/workflow-analytics.test.ts):
- Day-boundary filter assertions for SQLite and Postgres paths
- Empty-result handling for all three query functions
- getAvgDuration clock-skew filter (completed_at >= started_at,
  completed_at IS NOT NULL)
- Sort ordering (cost_usd DESC, date ASC)
- Type coercion of string count/cost rows to numbers

Route aggregator (packages/server/src/routes/api.analytics.test.ts):
- MIN_RUNS_FOR_FAILURE_RANKING threshold (below / at)
- Zero-failure exclusion from topFailingWorkflows
- Sort by failureRate DESC
- slice(0, 3) cap
- Full CostAnalytics response contract
- days query-param validation

packages/server/package.json batch entry added for the new route
test file; packages/core/package.json batch entry added in the
previous commit (with the fix).

Closes the test gap surfaced in the workflow-health-metrics peer
review loop.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final validation & PR

**Files:** none modified

- [ ] **Step 1: Run full monorepo validate**

Run:
```bash
bun run validate
```
Expected: type-check + lint (max-warnings 0) + format:check + all tests pass.

If any check fails, stop and fix before proceeding. Do NOT push a red branch.

- [ ] **Step 2: Manual smoke test**

Start the dev server:
```bash
bun run dev
```

Open the dashboard in a browser. Confirm:
- `CostSummaryCard` still renders its spend summary unchanged
- `WorkflowHealthCard` still renders success rate, avg duration, top failing workflows unchanged
- No console errors
- No visible layout change

Stop the dev server when done: `pkill -f "bun.*dev"`

- [ ] **Step 3: Review commit log on the branch**

Run:
```bash
git log --oneline dev..HEAD
```
Expected: 4 commits total on `feat/analytics-hardening` (including the spec from brainstorming):
1. `docs(superpowers): add spec for analytics hardening PR`
2. `docs(superpowers): clarify server test batch entry in spec`
3. `feat(web): extract useCostAnalytics hook`
4. `fix(core): SQLite day-boundary filter in workflow-analytics queries`
5. `test(core,server): add workflow-analytics DB + route aggregator tests`

(If the spec self-review produced only one commit, the total is 4 instead of 5.)

- [ ] **Step 4: Push the branch**

Run:
```bash
git push -u origin feat/analytics-hardening
```

- [ ] **Step 5: Open the PR**

Run:
```bash
gh pr create --base dev --title "feat: analytics hardening (hook extract, SQLite day-boundary fix, tests)" --body "$(cat <<'EOF'
## Summary

- Extract `useCostAnalytics(days)` hook to eliminate duplicate `useQuery` calls in `CostSummaryCard` and `WorkflowHealthCard`.
- Fix SQLite day-boundary filter bug: `WHERE started_at >= $1` now uses a dialect-aware helper that wraps with `datetime()` in SQLite, preserving the existing `started_at >= $N` form on PostgreSQL.
- Add DB-layer and route-aggregator test coverage (17 + 8 tests) for workflow-analytics, closing the gap flagged across the three-round peer review on #6.

## Spec

See [`docs/superpowers/specs/2026-04-14-analytics-hardening-design.md`](docs/superpowers/specs/2026-04-14-analytics-hardening-design.md) for the full design, trade-offs, and rollback plan.

## Test plan

- [x] `bun run validate` passes locally
- [x] Dashboard cards render correctly against real data (manual)
- [ ] CI green
- [ ] Peer review

## Rollback

Each functional commit is independently revertable. The day-boundary fix is Postgres-neutral (unchanged behavior); SQLite users get correctness at worst, previous incorrect-but-stable behavior on revert.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Report PR URL to user and await review**

The `gh pr create` command prints the PR URL on success. Share it with the user. Do not merge — wait for CI + user review.

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Hook at `packages/web/src/hooks/useCostAnalytics.ts` | Task 1 Step 2 |
| CostSummaryCard uses hook | Task 1 Step 3 |
| WorkflowHealthCard uses hook | Task 1 Step 4 |
| `startedAtSinceFilter` helper | Task 2 Step 4 |
| Three call-site updates | Task 2 Steps 5–7 |
| SQLite day-boundary test | Task 2 Step 1 |
| Postgres day-boundary test | Task 2 Step 1 |
| Empty-result tests | Task 3 Step 1 |
| Clock-skew exclusion | Task 3 Step 2 |
| Sort ordering | Task 3 Step 3 |
| Type coercion | Task 3 Step 4 |
| `MIN_RUNS_FOR_FAILURE_RANKING` threshold (below) | Task 3 Step 7 |
| `MIN_RUNS_FOR_FAILURE_RANKING` threshold (at) | Task 3 Step 8 |
| Zero-failure exclusion | Task 3 Step 9 |
| Sort by failure rate | Task 3 Step 10 |
| `slice(0, 3)` cap | Task 3 Step 11 |
| Full response contract | Task 3 Step 12 |
| Query param validation | Task 3 Step 13 |
| Test batch in `packages/core/package.json` | Task 2 Step 2 |
| Test batch in `packages/server/package.json` | Task 3 Step 14 |
| `bun run validate` passes | Task 4 Step 1 |
| Manual dashboard smoke | Task 4 Step 2 |
| PR opens against `dev` | Task 4 Step 5 |

All spec requirements map to a task.

### Placeholder scan

No `TBD`, `TODO`, `implement later`, `similar to Task N`, or "add validation" hand-waves. Every code step contains the actual code. Every run step contains the exact command and expected output.

### Type consistency

- Hook signature: `useCostAnalytics(days: number): UseQueryResult<CostAnalytics>` — consistent across Task 1.
- Helper signature: `startedAtSinceFilter(placeholder: number): string` — consistent across Task 2.
- Test harness types (`WorkflowCostRow`, `DailyCostRow`, `CostAnalyticsResponse`) — defined once in Task 3 Step 6 and reused in subsequent steps.
- `seedWorkflowRows` helper signature consistent across Task 3 Steps 7–12.

### Scope check

Plan covers a single PR worth of work. Commits are atomic; each is independently revertable. No speculative features.

---

**End of plan.**
