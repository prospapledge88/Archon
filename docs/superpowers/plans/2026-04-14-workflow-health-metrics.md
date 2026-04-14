# Workflow Health Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing cost analytics API with success rate, average duration, and top failing workflows data. Add a `WorkflowHealthCard` dashboard widget consuming the same API response.

**Architecture:** New DB query for avg duration; extend existing API handler aggregation; new Zod schema fields; new React component using shared TanStack Query cache.

**Tech Stack:** TypeScript, Hono + Zod, React 19, TanStack Query v5, Tailwind v4, dialect-aware SQL

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/core/src/db/workflow-analytics.ts` | Add `getAvgDuration()` function |
| Modify | `packages/server/src/routes/schemas/analytics.schemas.ts` | Add 3 new response fields |
| Modify | `packages/server/src/routes/api.ts:2543-2615` | Extend handler with duration query + health aggregation |
| Modify | `packages/web/src/lib/api.ts` | Extend `CostAnalytics` interface + add `TopFailingWorkflow` |
| Create | `packages/web/src/components/dashboard/WorkflowHealthCard.tsx` | Dashboard widget |
| Modify | `packages/web/src/routes/DashboardPage.tsx` | Render new card after `<CostSummaryCard />` |

---

### Task 1: Add `getAvgDuration()` database query

**Files:**
- Modify: `packages/core/src/db/workflow-analytics.ts`

- [ ] **Step 1: Add the new function**

Read `packages/core/src/db/workflow-analytics.ts` first. Append this function after `getDailyCosts`:

```typescript
/**
 * Get the average duration (in seconds) of terminal workflow runs in the period.
 * Dialect-aware: SQLite uses julianday() arithmetic, PostgreSQL uses EXTRACT(EPOCH FROM ...).
 * Returns 0 when no terminal runs exist.
 */
export async function getAvgDuration(sinceDate: string): Promise<number> {
  try {
    const durationExpr = getDatabaseType() === 'postgresql'
      ? 'EXTRACT(EPOCH FROM (completed_at - started_at))'
      : '(julianday(completed_at) - julianday(started_at)) * 86400';

    const result = await pool.query<{ avg_seconds: string | number | null }>(
      `SELECT AVG(${durationExpr}) as avg_seconds
       FROM remote_agent_workflow_runs
       WHERE started_at >= $1
         AND status IN ('completed', 'failed')
         AND completed_at IS NOT NULL`,
      [sinceDate]
    );
    const raw = result.rows[0]?.avg_seconds;
    return raw == null ? 0 : Number(raw);
  } catch (error) {
    getLog().error({ err: error as Error, sinceDate }, 'avg_duration_query_failed');
    throw error;
  }
}
```

- [ ] **Step 2: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/db/workflow-analytics.ts
git commit -m "feat(core): add getAvgDuration analytics query

Dialect-aware query for average workflow run duration in seconds.
Powers the Workflow Health dashboard card."
```

---

### Task 2: Extend Zod schemas

**Files:**
- Modify: `packages/server/src/routes/schemas/analytics.schemas.ts`

- [ ] **Step 1: Add new schema + extend response**

Read `packages/server/src/routes/schemas/analytics.schemas.ts` first.

Add a new schema before `costAnalyticsResponseSchema`:

```typescript
const topFailingWorkflowSchema = z.object({
  workflowName: z.string(),
  failureRate: z.number(),
  failedRuns: z.number(),
  totalRuns: z.number(),
});
```

Extend `costAnalyticsResponseSchema` by adding three new fields inside the `z.object({...})` block (alongside existing fields, before the `.openapi(...)` call):

```typescript
    successRate: z.number(),
    avgDurationSeconds: z.number(),
    topFailingWorkflows: z.array(topFailingWorkflowSchema),
```

- [ ] **Step 2: Verify type-check and lint**

Run: `bun run type-check && bun run lint --max-warnings 0`

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/routes/schemas/analytics.schemas.ts
git commit -m "feat(server): extend cost analytics schema with health fields

Adds successRate, avgDurationSeconds, and topFailingWorkflows to
the CostAnalyticsResponse schema. Response name unchanged to
preserve compatibility with existing CostSummaryCard."
```

---

### Task 3: Extend API handler

**Files:**
- Modify: `packages/server/src/routes/api.ts` (around lines 2543-2615)

- [ ] **Step 1: Read the existing handler**

Read `packages/server/src/routes/api.ts` lines 2543-2615 to understand current structure.

- [ ] **Step 2: Replace the handler body**

Replace the entire `registerOpenApiRoute(getCostAnalyticsRoute, async c => { ... })` block (lines 2543-2615) with:

```typescript
  registerOpenApiRoute(getCostAnalyticsRoute, async c => {
    try {
      const daysRaw = Number(c.req.query('days') ?? '30');
      const days = Number.isNaN(daysRaw) ? 30 : Math.min(Math.max(1, daysRaw), 365);
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - days);
      const sinceDate = from.toISOString();

      const [workflowRows, dailyRows, avgDurationSeconds] = await Promise.all([
        analyticsDb.getCostByWorkflow(sinceDate),
        analyticsDb.getDailyCosts(sinceDate),
        analyticsDb.getAvgDuration(sinceDate),
      ]);

      // Aggregate by workflow name (rows are split by status)
      // Now tracks success/failure counts per workflow for the health metrics.
      const byWorkflowMap = new Map<
        string,
        { costUsd: number; runs: number; successRuns: number; failedRuns: number }
      >();
      let totalCostUsd = 0;
      let totalRuns = 0;
      let successfulRuns = 0;
      let failedRuns = 0;
      let successCostUsd = 0;
      let failedCostUsd = 0;

      for (const row of workflowRows) {
        const entry = byWorkflowMap.get(row.workflow_name) ?? {
          costUsd: 0,
          runs: 0,
          successRuns: 0,
          failedRuns: 0,
        };
        entry.costUsd += row.cost_usd;
        entry.runs += row.run_count;
        if (row.status === 'completed') {
          entry.successRuns += row.run_count;
          successfulRuns += row.run_count;
          successCostUsd += row.cost_usd;
        } else {
          entry.failedRuns += row.run_count;
          failedRuns += row.run_count;
          failedCostUsd += row.cost_usd;
        }
        totalCostUsd += row.cost_usd;
        totalRuns += row.run_count;
        byWorkflowMap.set(row.workflow_name, entry);
      }

      const byWorkflow = [...byWorkflowMap.entries()]
        .map(([workflowName, data]) => ({
          workflowName,
          costUsd: Math.round(data.costUsd * 10000) / 10000,
          runs: data.runs,
          avgCostUsd: data.runs > 0 ? Math.round((data.costUsd / data.runs) * 10000) / 10000 : 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd);

      const daily = dailyRows.map(row => ({
        date: row.date,
        costUsd: Math.round(row.cost_usd * 10000) / 10000,
        runs: row.run_count,
      }));

      // Health metrics: aggregate success rate and top failing workflows
      const successRate = totalRuns > 0 ? successfulRuns / totalRuns : 0;

      // Exclude workflows with < 3 total runs to avoid ranking noise
      // (e.g., "1 of 1 failed = 100% failure rate" is misleading).
      const MIN_RUNS_FOR_FAILURE_RANKING = 3;
      const topFailingWorkflows = [...byWorkflowMap.entries()]
        .map(([workflowName, data]) => {
          const total = data.successRuns + data.failedRuns;
          return {
            workflowName,
            failureRate: total > 0 ? data.failedRuns / total : 0,
            failedRuns: data.failedRuns,
            totalRuns: total,
          };
        })
        .filter(wf => wf.totalRuns >= MIN_RUNS_FOR_FAILURE_RANKING && wf.failedRuns > 0)
        .sort((a, b) => b.failureRate - a.failureRate)
        .slice(0, 3);

      return c.json({
        period: { days, from: sinceDate, to: now.toISOString() },
        totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
        totalRuns,
        successfulRuns,
        failedRuns,
        successCostUsd: Math.round(successCostUsd * 10000) / 10000,
        failedCostUsd: Math.round(failedCostUsd * 10000) / 10000,
        byWorkflow,
        daily,
        successRate: Math.round(successRate * 10000) / 10000,
        avgDurationSeconds: Math.round(avgDurationSeconds),
        topFailingWorkflows: topFailingWorkflows.map(wf => ({
          ...wf,
          failureRate: Math.round(wf.failureRate * 10000) / 10000,
        })),
      });
    } catch (error) {
      getLog().error({ err: error }, 'cost_analytics_failed');
      return apiError(c, 500, 'Failed to get cost analytics');
    }
  });
```

- [ ] **Step 3: Verify type-check and lint pass**

Run: `bun run type-check && bun run lint --max-warnings 0`
Expected: PASS.

- [ ] **Step 4: Format**

Run: `bun run format`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/api.ts
git commit -m "feat(server): extend /api/analytics/costs with health metrics

Adds successRate (aggregate), avgDurationSeconds, and topFailingWorkflows
to the response. Tracks per-workflow success/failure counts during
aggregation. Noise filter: workflows with fewer than 3 total runs
are excluded from topFailingWorkflows."
```

---

### Task 4: Extend client types + create WorkflowHealthCard

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/components/dashboard/WorkflowHealthCard.tsx`

- [ ] **Step 1: Extend types in api.ts**

Read `packages/web/src/lib/api.ts` and find the `CostAnalytics` interface. Add above it:

```typescript
export interface TopFailingWorkflow {
  workflowName: string;
  failureRate: number;
  failedRuns: number;
  totalRuns: number;
}
```

And extend `CostAnalytics` with three new fields:

```typescript
export interface CostAnalytics {
  // ... existing fields unchanged ...
  successRate: number;
  avgDurationSeconds: number;
  topFailingWorkflows: TopFailingWorkflow[];
}
```

- [ ] **Step 2: Create the card component**

Create `packages/web/src/components/dashboard/WorkflowHealthCard.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Clock, TrendingDown } from 'lucide-react';
import { getCostAnalytics } from '@/lib/api';
import type { CostAnalytics } from '@/lib/api';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatPercent(decimal: number): string {
  return `${String(Math.round(decimal * 100))}%`;
}

function HealthBreakdown({ data }: { data: CostAnalytics }): React.ReactElement {
  const topFailing = data.topFailingWorkflows;

  return (
    <div className="space-y-3">
      {/* Headline numbers */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="flex items-center gap-1.5 text-lg font-semibold text-text-primary">
          <CheckCircle2 className="h-4 w-4 text-success" />
          {formatPercent(data.successRate)} success
        </span>
        <span className="flex items-center gap-1.5 text-sm text-text-secondary">
          <Clock className="h-3.5 w-3.5" />
          {formatDuration(data.avgDurationSeconds)} avg duration
        </span>
        <span className="text-sm text-text-tertiary">
          {data.totalRuns} run{data.totalRuns !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Top failing workflows */}
      {topFailing.length > 0 && (
        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-xs font-medium text-text-tertiary">
            <TrendingDown className="h-3 w-3" />
            Top failing workflows
          </span>
          {topFailing.map(wf => (
            <div
              key={wf.workflowName}
              className="flex items-center justify-between text-sm text-text-secondary"
            >
              <span className="truncate font-mono text-xs">{wf.workflowName}</span>
              <span className="ml-4 shrink-0 text-xs text-error">
                {formatPercent(wf.failureRate)} failed &middot; {wf.failedRuns}/{wf.totalRuns} runs
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowHealthCard(): React.ReactElement | null {
  const { data, isLoading } = useQuery({
    queryKey: ['cost-analytics'],
    queryFn: () => getCostAnalytics(30),
    staleTime: 30_000,
  });

  if (isLoading || !data || data.totalRuns === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
        <Activity className="h-4 w-4" />
        Workflow Health (Last 30 days)
      </div>
      <HealthBreakdown data={data} />
    </div>
  );
}
```

- [ ] **Step 3: Verify type-check and lint**

Run: `bun run type-check && bun run lint --max-warnings 0`

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/components/dashboard/WorkflowHealthCard.tsx
git commit -m "feat(web): add WorkflowHealthCard dashboard widget

New card showing success rate, average duration, and top 3 failing
workflows. Reuses the CostSummaryCard's TanStack Query cache entry
(queryKey: 'cost-analytics') — one API call feeds both cards."
```

---

### Task 5: Wire into DashboardPage

**Files:**
- Modify: `packages/web/src/routes/DashboardPage.tsx`

- [ ] **Step 1: Add the import**

Read `packages/web/src/routes/DashboardPage.tsx` to find the existing import of `CostSummaryCard`. Add alongside:

```typescript
import { WorkflowHealthCard } from '@/components/dashboard/WorkflowHealthCard';
```

- [ ] **Step 2: Render the card after CostSummaryCard**

Find `<CostSummaryCard />` in the JSX. Add `<WorkflowHealthCard />` immediately after it:

```tsx
<CostSummaryCard />
<WorkflowHealthCard />
```

- [ ] **Step 3: Verify type-check, lint, format**

Run: `bun run type-check && bun run lint --max-warnings 0 && bun run format`

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/DashboardPage.tsx
git commit -m "feat(web): render WorkflowHealthCard on dashboard

Placed immediately after CostSummaryCard so both analytics widgets
appear together between the status bar and active workflows."
```

---

### Task 6: Full validation

- [ ] **Step 1: Run full validation**

Run: `bun run validate`
Expected: All pass (pre-existing `@archon/core` ClaudeClient failures unrelated).

- [ ] **Step 2: Manual test via curl (if dev server runs)**

```bash
env -u DATABASE_URL bun run dev:server &
sleep 3
curl -s http://localhost:3090/api/analytics/costs?days=30 | jq '{successRate, avgDurationSeconds, topFailingWorkflows}'
pkill -f "bun.*dev"
```

Expected: JSON with the three new fields.
