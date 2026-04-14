# Cost Analytics Aggregation

**Date**: 2026-04-13
**Status**: Draft
**Scope**: `@archon/core` (DB queries), `@archon/server` (API route), `@archon/web` (dashboard widget)

## Problem

Archon tracks per-node and per-run cost data but provides no aggregated view. Users cannot answer: "How much am I spending?", "Which workflows cost the most?", or "Is my spend trending up?" The harness-elevates-model thesis (Sonnet under a good harness beats Opus without one) is not empirically verifiable without cost analytics.

## Data Source

Cost data already exists in the database:
- **`workflow_runs.metadata`** — JSON field containing `total_cost_usd` (sum of all node costs for the run)
- **`workflow_runs.workflow_name`** — for grouping by workflow type
- **`workflow_runs.status`** — for success vs. failure breakdown
- **`workflow_runs.started_at`** — for time-series grouping

No schema changes or migrations required.

## API Endpoint

`GET /api/analytics/costs?days=30`

**Parameters:**
- `days` (optional, default 30, max 365) — lookback window from now

**Response:**
```json
{
  "period": { "days": 30, "from": "2026-03-14T00:00:00Z", "to": "2026-04-13T23:59:59Z" },
  "totalCostUsd": 12.4532,
  "totalRuns": 87,
  "successfulRuns": 71,
  "failedRuns": 16,
  "successCostUsd": 9.8210,
  "failedCostUsd": 2.6322,
  "byWorkflow": [
    { "workflowName": "fix-github-issue", "costUsd": 5.23, "runs": 34, "avgCostUsd": 0.1538 },
    { "workflowName": "feature-development", "costUsd": 4.12, "runs": 12, "avgCostUsd": 0.3433 }
  ],
  "daily": [
    { "date": "2026-04-12", "costUsd": 1.23, "runs": 5 },
    { "date": "2026-04-13", "costUsd": 0.87, "runs": 3 }
  ]
}
```

- `byWorkflow` sorted by `costUsd` descending
- `daily` sorted by `date` ascending
- Runs with no cost data (`total_cost_usd` is null/missing) are counted in `totalRuns` but contribute $0 to cost sums

## Database Queries

Two queries, both dialect-aware (SQLite vs PostgreSQL):

**Query 1 — Summary + byWorkflow:**
```sql
SELECT workflow_name, status,
  COUNT(*) as run_count,
  COALESCE(SUM(json_extract(metadata, '$.total_cost_usd')), 0) as cost_usd
FROM remote_agent_workflow_runs
WHERE started_at >= ?
  AND status IN ('completed', 'failed')
GROUP BY workflow_name, status
```

PostgreSQL variant uses `(metadata->>'total_cost_usd')::numeric` instead of `json_extract`.

Post-process in TypeScript: aggregate by workflow name, compute totals, success/failure splits, averages.

**Query 2 — Daily:**
```sql
SELECT DATE(started_at) as date,
  COUNT(*) as run_count,
  COALESCE(SUM(json_extract(metadata, '$.total_cost_usd')), 0) as cost_usd
FROM remote_agent_workflow_runs
WHERE started_at >= ?
  AND status IN ('completed', 'failed')
GROUP BY DATE(started_at)
ORDER BY date ASC
```

PostgreSQL variant uses `DATE(started_at)` (same syntax) and `(metadata->>'total_cost_usd')::numeric`.

## Dashboard Widget

`CostSummaryCard` component placed between StatusSummaryBar and Active Workflows section.

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Spend (Last 30 days)                                       │
│                                                             │
│  $12.45 total    87 runs    $0.14 avg/run                  │
│                                                             │
│  ✓ $9.82 successful (71)    ✗ $2.63 failed (16)           │
│                                                             │
│  Top workflows:                                             │
│    fix-github-issue    $5.23  (34 runs, $0.15 avg)         │
│    feature-development $4.12  (12 runs, $0.34 avg)         │
│    validate-pr         $1.89  (22 runs, $0.09 avg)         │
└─────────────────────────────────────────────────────────────┘
```

**Styling:**
- `bg-surface-elevated` card background
- `text-text-primary` for headline numbers
- `text-text-secondary` for labels and details
- `text-success` for successful run cost, `text-error` for failed
- Top 3 workflows by cost shown (from `byWorkflow` array)

**Behavior:**
- Uses TanStack Query with `staleTime: 30_000`
- Hidden when response has zero total runs (no empty state)
- `days=30` hardcoded for the widget
- Loading state: skeleton or nothing (card hidden until data loads)

## Implementation Files

| Action | File | Responsibility |
|---|---|---|
| Create | `packages/core/src/db/workflow-analytics.ts` | Two SQL query functions |
| Create | `packages/server/src/routes/schemas/analytics.ts` | Zod schemas for route |
| Create | `packages/web/src/components/dashboard/CostSummaryCard.tsx` | Dashboard widget |
| Modify | `packages/server/src/routes/api.ts` | Register GET /api/analytics/costs |
| Modify | `packages/web/src/lib/api.ts` | Add getCostAnalytics() client function |
| Modify | `packages/web/src/routes/DashboardPage.tsx` | Render CostSummaryCard |

## Package Boundaries

- `@archon/core` — new query module (no interface changes)
- `@archon/server` — new route using existing `registerOpenApiRoute` pattern
- `@archon/web` — new component + API client function + dashboard integration
- `@archon/workflows` — no changes

## Non-Goals

- No chart library or sparklines — numbers only for v1
- No per-model breakdown — model info is not stored in `workflow_runs` metadata (would need to join events)
- No historical comparison ("vs. last month") — single period only
- No export/CSV functionality
- No test files for DB queries — straightforward aggregations, validated via curl
