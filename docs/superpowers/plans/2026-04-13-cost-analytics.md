# Cost Analytics Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /api/analytics/costs` endpoint and a dashboard widget showing aggregated workflow cost data (total spend, per-workflow breakdown, success/failure split, daily buckets).

**Architecture:** Two SQL queries against existing `workflow_runs` metadata JSON field, served via OpenAPI route, consumed by a TanStack Query hook in a new dashboard component.

**Tech Stack:** TypeScript, Hono + @hono/zod-openapi, TanStack Query v5, React 19, Tailwind v4 + shadcn/ui

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/core/src/db/workflow-analytics.ts` | Two dialect-aware SQL query functions |
| Create | `packages/server/src/routes/schemas/analytics.schemas.ts` | Zod schemas for the analytics route |
| Create | `packages/web/src/components/dashboard/CostSummaryCard.tsx` | Dashboard cost widget |
| Modify | `packages/server/src/routes/api.ts` | Register GET /api/analytics/costs route |
| Modify | `packages/web/src/lib/api.ts` | Add getCostAnalytics() client function and CostAnalytics type |
| Modify | `packages/web/src/routes/DashboardPage.tsx` | Import and render CostSummaryCard |

---

### Task 1: Database query functions

**Files:**
- Create: `packages/core/src/db/workflow-analytics.ts`

- [ ] **Step 1: Create the query module**

Create `packages/core/src/db/workflow-analytics.ts`:

```typescript
/**
 * Aggregated cost analytics queries for workflow runs.
 * Queries existing metadata JSON fields — no schema changes needed.
 */
import { pool, getDatabaseType } from './connection';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.workflow-analytics');
  return cachedLog;
}

/** SQL fragment to extract total_cost_usd from metadata JSON, dialect-aware. */
function jsonCostExtract(): string {
  return getDatabaseType() === 'postgresql'
    ? "COALESCE((metadata->>'total_cost_usd')::numeric, 0)"
    : "COALESCE(CAST(json_extract(metadata, '$.total_cost_usd') AS REAL), 0)";
}

/** SQL fragment to extract date from started_at, dialect-aware. */
function dateExtract(): string {
  return getDatabaseType() === 'postgresql'
    ? 'DATE(started_at)'
    : "DATE(started_at, 'utc')";
}

export interface WorkflowCostRow {
  workflow_name: string;
  status: string;
  run_count: number;
  cost_usd: number;
}

export interface DailyCostRow {
  date: string;
  run_count: number;
  cost_usd: number;
}

/**
 * Get per-workflow cost breakdown grouped by workflow name and status.
 * Only includes terminal runs (completed, failed).
 */
export async function getCostByWorkflow(sinceDate: string): Promise<WorkflowCostRow[]> {
  try {
    const result = await pool.query<WorkflowCostRow>(
      `SELECT workflow_name, status,
        COUNT(*) as run_count,
        ${jsonCostExtract()} as cost_usd
      FROM remote_agent_workflow_runs
      WHERE started_at >= $1
        AND status IN ('completed', 'failed')
      GROUP BY workflow_name, status
      ORDER BY cost_usd DESC`,
      [sinceDate]
    );
    return result.rows.map(row => ({
      ...row,
      run_count: Number(row.run_count),
      cost_usd: Number(row.cost_usd),
    }));
  } catch (error) {
    getLog().error({ err: error as Error, sinceDate }, 'cost_by_workflow_query_failed');
    throw error;
  }
}

/**
 * Get daily cost totals for the given period.
 */
export async function getDailyCosts(sinceDate: string): Promise<DailyCostRow[]> {
  try {
    const result = await pool.query<DailyCostRow>(
      `SELECT ${dateExtract()} as date,
        COUNT(*) as run_count,
        ${jsonCostExtract()} as cost_usd
      FROM remote_agent_workflow_runs
      WHERE started_at >= $1
        AND status IN ('completed', 'failed')
      GROUP BY ${dateExtract()}
      ORDER BY date ASC`,
      [sinceDate]
    );
    return result.rows.map(row => ({
      ...row,
      run_count: Number(row.run_count),
      cost_usd: Number(row.cost_usd),
    }));
  } catch (error) {
    getLog().error({ err: error as Error, sinceDate }, 'daily_costs_query_failed');
    throw error;
  }
}
```

Note: SQLite may return aggregates as strings — the `Number()` coercion handles both dialects safely.

- [ ] **Step 2: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/db/workflow-analytics.ts
git commit -m "feat(core): add cost analytics query functions

Dialect-aware SQL queries for per-workflow cost breakdown and daily
cost totals. Reads existing total_cost_usd from workflow_runs metadata."
```

---

### Task 2: Zod schemas + API route

**Files:**
- Create: `packages/server/src/routes/schemas/analytics.schemas.ts`
- Modify: `packages/server/src/routes/api.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/server/src/routes/schemas/analytics.schemas.ts`:

```typescript
/**
 * Zod schemas for analytics API endpoints.
 */
import { z } from '@hono/zod-openapi';

export const costAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30).openapi({
    description: 'Lookback window in days (default: 30, max: 365)',
  }),
});

const workflowCostEntrySchema = z.object({
  workflowName: z.string(),
  costUsd: z.number(),
  runs: z.number(),
  avgCostUsd: z.number(),
});

const dailyCostEntrySchema = z.object({
  date: z.string(),
  costUsd: z.number(),
  runs: z.number(),
});

export const costAnalyticsResponseSchema = z
  .object({
    period: z.object({
      days: z.number(),
      from: z.string(),
      to: z.string(),
    }),
    totalCostUsd: z.number(),
    totalRuns: z.number(),
    successfulRuns: z.number(),
    failedRuns: z.number(),
    successCostUsd: z.number(),
    failedCostUsd: z.number(),
    byWorkflow: z.array(workflowCostEntrySchema),
    daily: z.array(dailyCostEntrySchema),
  })
  .openapi('CostAnalyticsResponse');
```

- [ ] **Step 2: Add the route definition and handler to api.ts**

In `packages/server/src/routes/api.ts`:

Add import at the top (alongside existing schema imports):
```typescript
import {
  costAnalyticsQuerySchema,
  costAnalyticsResponseSchema,
} from './schemas/analytics.schemas';
```

Add namespace import for the new DB module (alongside existing `import * as codebaseDb`):
```typescript
import * as analyticsDb from '@archon/core/db/workflow-analytics';
```

Add the route definition (alongside existing route definitions, before `registerApiRoutes`):
```typescript
const getCostAnalyticsRoute = createRoute({
  method: 'get',
  path: '/api/analytics/costs',
  tags: ['Analytics'],
  summary: 'Get aggregated workflow cost analytics',
  request: { query: costAnalyticsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: costAnalyticsResponseSchema } },
      description: 'Cost analytics for the requested period',
    },
    500: jsonError('Server error'),
  },
});
```

Add the handler inside `registerApiRoutes()` (after the existing workflow routes, before the webhook section):
```typescript
  // GET /api/analytics/costs - Aggregated workflow cost analytics
  registerOpenApiRoute(getCostAnalyticsRoute, async c => {
    try {
      const { days } = c.req.valid('query');
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - days);
      const sinceDate = from.toISOString();

      const [workflowRows, dailyRows] = await Promise.all([
        analyticsDb.getCostByWorkflow(sinceDate),
        analyticsDb.getDailyCosts(sinceDate),
      ]);

      // Aggregate by workflow name (rows are split by status)
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

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/schemas/analytics.schemas.ts packages/server/src/routes/api.ts packages/core/src/db/workflow-analytics.ts
git commit -m "feat(server): add GET /api/analytics/costs endpoint

OpenAPI route returning aggregated workflow cost analytics:
total spend, success/failure breakdown, per-workflow costs,
and daily cost buckets."
```

---

### Task 3: Frontend API client + CostSummaryCard + dashboard integration

**Files:**
- Modify: `packages/web/src/lib/api.ts`
- Create: `packages/web/src/components/dashboard/CostSummaryCard.tsx`
- Modify: `packages/web/src/routes/DashboardPage.tsx`

- [ ] **Step 1: Add the API client function and types**

In `packages/web/src/lib/api.ts`, add near the other type definitions:

```typescript
export interface WorkflowCostEntry {
  workflowName: string;
  costUsd: number;
  runs: number;
  avgCostUsd: number;
}

export interface DailyCostEntry {
  date: string;
  costUsd: number;
  runs: number;
}

export interface CostAnalytics {
  period: { days: number; from: string; to: string };
  totalCostUsd: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successCostUsd: number;
  failedCostUsd: number;
  byWorkflow: WorkflowCostEntry[];
  daily: DailyCostEntry[];
}
```

And add the fetch function (near other export functions):

```typescript
export async function getCostAnalytics(days = 30): Promise<CostAnalytics> {
  const res = await fetch(`${SSE_BASE_URL}/api/analytics/costs?days=${String(days)}`);
  if (!res.ok) throw new Error(`Failed to fetch cost analytics: ${String(res.status)}`);
  return res.json() as Promise<CostAnalytics>;
}
```

- [ ] **Step 2: Create the CostSummaryCard component**

Create `packages/web/src/components/dashboard/CostSummaryCard.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { DollarSign, CheckCircle2, XCircle } from 'lucide-react';
import { getCostAnalytics } from '@/lib/api';
import type { CostAnalytics } from '@/lib/api';

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd >= 10 ? 2 : 4)}`;
}

function CostBreakdown({ data }: { data: CostAnalytics }): React.ReactElement {
  const avgCost = data.totalRuns > 0 ? data.totalCostUsd / data.totalRuns : 0;
  const topWorkflows = data.byWorkflow.slice(0, 3);

  return (
    <div className="space-y-3">
      {/* Headline numbers */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-lg font-semibold text-text-primary">
          {formatCost(data.totalCostUsd)}
        </span>
        <span className="text-sm text-text-secondary">
          {data.totalRuns} run{data.totalRuns !== 1 ? 's' : ''}
        </span>
        <span className="text-sm text-text-tertiary">
          {formatCost(avgCost)} avg/run
        </span>
      </div>

      {/* Success / failure split */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {formatCost(data.successCostUsd)} successful ({data.successfulRuns})
        </span>
        <span className="flex items-center gap-1.5 text-error">
          <XCircle className="h-3.5 w-3.5" />
          {formatCost(data.failedCostUsd)} failed ({data.failedRuns})
        </span>
      </div>

      {/* Top workflows */}
      {topWorkflows.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-text-tertiary">Top workflows</span>
          {topWorkflows.map(wf => (
            <div
              key={wf.workflowName}
              className="flex items-center justify-between text-sm text-text-secondary"
            >
              <span className="truncate font-mono text-xs">{wf.workflowName}</span>
              <span className="ml-4 shrink-0 text-xs text-text-tertiary">
                {formatCost(wf.costUsd)} &middot; {wf.runs} run{wf.runs !== 1 ? 's' : ''} &middot;{' '}
                {formatCost(wf.avgCostUsd)} avg
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CostSummaryCard(): React.ReactElement | null {
  const { data, isLoading } = useQuery({
    queryKey: ['cost-analytics'],
    queryFn: () => getCostAnalytics(30),
    staleTime: 30_000,
  });

  // Hide card when loading or no data
  if (isLoading || !data || data.totalRuns === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
        <DollarSign className="h-4 w-4" />
        Spend (Last 30 days)
      </div>
      <CostBreakdown data={data} />
    </div>
  );
}
```

- [ ] **Step 3: Integrate into DashboardPage**

In `packages/web/src/routes/DashboardPage.tsx`:

Add import at the top:
```typescript
import { CostSummaryCard } from '@/components/dashboard/CostSummaryCard';
```

Find the `<StatusSummaryBar` component in the JSX. Place the `<CostSummaryCard />` immediately after the closing of the StatusSummaryBar section and before the active workflows / empty states. Look for the pattern after `StatusSummaryBar` where the content conditional rendering begins. Insert:

```tsx
<CostSummaryCard />
```

Right after the `</StatusSummaryBar>` closing (or the wrapping div around it), before the loading/empty/content conditionals.

- [ ] **Step 4: Verify type-check and lint pass**

Run: `bun run type-check && bun run lint --max-warnings 0`
Expected: PASS.

- [ ] **Step 5: Format**

Run: `bun run format`

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/components/dashboard/CostSummaryCard.tsx packages/web/src/routes/DashboardPage.tsx
git commit -m "feat(web): add cost analytics dashboard widget

CostSummaryCard shows total spend, success/failure breakdown, and
top 3 workflows by cost. Uses TanStack Query with 30s stale time.
Hidden when no cost data is available."
```

---

### Task 4: Full validation

**Files:** No changes — verification only

- [ ] **Step 1: Run full validation suite**

Run: `bun run validate`
Expected: type-check, lint, format, and all tests pass. The `@archon/core` ClaudeClient test failures are pre-existing and unrelated.

- [ ] **Step 2: Manual test via curl (if dev server available)**

Start the server: `env -u DATABASE_URL bun run dev:server`

Then test:
```bash
curl -s http://localhost:3090/api/analytics/costs?days=30 | jq .
```

Expected: JSON response matching the schema (may have zero values if no workflow runs exist locally).

- [ ] **Step 3: Verify OpenAPI spec includes the new route**

```bash
curl -s http://localhost:3090/api/openapi.json | jq '.paths["/api/analytics/costs"]'
```

Expected: The GET route appears with query parameter `days` and the `CostAnalyticsResponse` schema.
