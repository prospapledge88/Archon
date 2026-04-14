# Workflow Success Rate Metrics

**Date**: 2026-04-14
**Status**: Draft
**Scope**: `@archon/core` (new query), `@archon/server` (extend existing route), `@archon/web` (new dashboard card)

## Problem

The cost analytics dashboard (Improvement #2) answers "how much am I spending?" but not "is my harness working?" Users can see totals but not success rates, durations, or which workflows are failing most often. The harness-elevates-model thesis (Cole Medin's 6.7% → 70% PR acceptance rate) is empirically unverifiable without these metrics.

## Design

Extend the existing `GET /api/analytics/costs` endpoint with three new fields. Add a new `WorkflowHealthCard` alongside the existing `CostSummaryCard` on the dashboard. Both cards share a single TanStack Query cache entry — one network call, two widgets.

### Extended API Response

Same endpoint (`/api/analytics/costs`), additional fields:

```json
{
  "successRate": 0.8161,
  "avgDurationSeconds": 223,
  "topFailingWorkflows": [
    {
      "workflowName": "feature-development",
      "failureRate": 0.333,
      "failedRuns": 4,
      "totalRuns": 12
    }
  ]
}
```

- `successRate` — decimal 0..1 across all terminal runs
- `avgDurationSeconds` — average of `completed_at - started_at` for terminal runs
- `topFailingWorkflows` — sorted by `failureRate` desc, capped at 3, excludes workflows with fewer than 3 total runs (noise filter)

Existing fields remain unchanged — does not break `CostSummaryCard`.

### Database Queries

**New query `getAvgDuration(sinceDate)`** in `packages/core/src/db/workflow-analytics.ts`:

SQLite:
```sql
SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400) as avg_seconds
FROM remote_agent_workflow_runs
WHERE started_at >= $1 AND status IN ('completed', 'failed') AND completed_at IS NOT NULL
```

PostgreSQL:
```sql
SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds
FROM remote_agent_workflow_runs
WHERE started_at >= $1 AND status IN ('completed', 'failed') AND completed_at IS NOT NULL
```

Returns `0` when no terminal runs exist.

**Reuse `getCostByWorkflow`** — the existing query already provides the per-workflow status breakdown. The API handler derives `failureRate` by post-processing.

### API Handler Changes

In `packages/server/src/routes/api.ts`, the `GET /api/analytics/costs` handler:

1. Add `getAvgDuration(sinceDate)` to the existing `Promise.all` alongside the two existing queries.
2. Extend the `byWorkflowMap` entries to track `successRuns` and `failedRuns` per-workflow (currently only tracks combined `runs`).
3. After the aggregation loop, compute:
   - `successRate = totalRuns > 0 ? successfulRuns / totalRuns : 0`
   - `topFailingWorkflows` from the Map, filtered/sorted as specified.
4. Include `successRate`, `avgDurationSeconds`, and `topFailingWorkflows` in the JSON response.

### Zod Schema

In `packages/server/src/routes/schemas/analytics.schemas.ts`:

```typescript
const topFailingWorkflowSchema = z.object({
  workflowName: z.string(),
  failureRate: z.number(),
  failedRuns: z.number(),
  totalRuns: z.number(),
});

// Extend costAnalyticsResponseSchema:
//   successRate: z.number(),
//   avgDurationSeconds: z.number(),
//   topFailingWorkflows: z.array(topFailingWorkflowSchema),
```

Schema name stays `CostAnalyticsResponse` — renaming breaks generated types.

### Web UI — WorkflowHealthCard

New component `packages/web/src/components/dashboard/WorkflowHealthCard.tsx` that:

- Reuses `useQuery({ queryKey: ['cost-analytics'], ... })` — same cache entry as `CostSummaryCard`
- Renders three headline numbers (success rate %, avg duration, total runs)
- Renders a top-3 failing workflows list with failure rate and counts
- Hidden when `totalRuns === 0`
- Uses existing Tailwind tokens: `bg-surface-elevated`, `text-text-primary`, `text-text-secondary`, `text-error`
- Duration formatted using local helper (duplicates 4-line formatter from `knowledge-writer.ts`; YAGNI on extracting)
- Placed in `DashboardPage.tsx` immediately after `<CostSummaryCard />`

### Extended Client Types

In `packages/web/src/lib/api.ts`:

```typescript
export interface TopFailingWorkflow {
  workflowName: string;
  failureRate: number;
  failedRuns: number;
  totalRuns: number;
}

export interface CostAnalytics {
  // existing fields unchanged...
  successRate: number;
  avgDurationSeconds: number;
  topFailingWorkflows: TopFailingWorkflow[];
}
```

## Implementation Files

| Action | File | Responsibility |
|---|---|---|
| Modify | `packages/core/src/db/workflow-analytics.ts` | Add `getAvgDuration()` function |
| Modify | `packages/server/src/routes/schemas/analytics.schemas.ts` | Extend schema |
| Modify | `packages/server/src/routes/api.ts` | Extend handler + aggregation loop |
| Modify | `packages/web/src/lib/api.ts` | Extend types |
| Create | `packages/web/src/components/dashboard/WorkflowHealthCard.tsx` | New widget |
| Modify | `packages/web/src/routes/DashboardPage.tsx` | Render new card |

## Non-Goals

- No bottleneck node analysis (workflow_events join)
- No duration histogram or distribution
- No trend lines
- No per-project or per-workflow filtering
- No new route — extending the existing endpoint
