# Analytics Hardening — Design Spec

**Date**: 2026-04-14
**Scope**: Tier-1 debt from the Workflow Health Metrics (Improvement #6) review loop
**Branch**: `feat/analytics-hardening`
**Target**: PR to `dev`

---

## Problem

Three concrete issues surfaced across the three-round peer review on `feat/workflow-health-metrics`:

1. **Duplicated data fetching** — `CostSummaryCard` and `WorkflowHealthCard` each call `useQuery` with identical key, function, and stale time. Reviewer #3 flagged this as a latent bug: a third card requesting different `days` would silently collide on the shared query key.
2. **Test gap** — All three reviewers flagged that `workflow-analytics` lacks test coverage for empty results, clock-skew exclusion, the `MIN_RUNS_FOR_FAILURE_RANKING` threshold, and sort ordering.
3. **SQLite day-boundary filter bug** — `WHERE started_at >= $1` compares TEXT byte-wise in SQLite. Stored format uses a space separator (`2026-04-14 13:53:10`); callers typically pass ISO-T format (`2026-04-14T00:00:00.000Z`). Byte comparison treats `T` (0x54) as greater than space (0x20), so legitimate rows get dropped at day boundaries. Reviewer #1 flagged as worth a separate PR.

Items (1) and (3) are latent bugs. Item (2) closes out the review debt on the health metrics work.

## Non-goals

- Renaming `CostAnalyticsResponse` → `AnalyticsResponse` (Tier-3 debt #8)
- Trend line UI on the dashboard (Tier-2 #4)
- Storage format migration for `started_at` / `completed_at`
- Any new analytics queries or aggregations

## Design

### 1. `useCostAnalytics` hook

**Location**: `packages/web/src/hooks/useCostAnalytics.ts`

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

**Design choices**:
- Thin passthrough returning `UseQueryResult<CostAnalytics>` — callers can destructure any query field without the hook needing to evolve (`error`, `refetch`, `isFetching`).
- `days` parameter goes into the query key so independent cards with different windows do not share cache.
- `STALE_TIME_MS` captured as a single constant in the hook — one tuning point.

**Call-site changes**:
- `packages/web/src/components/dashboard/CostSummaryCard.tsx` — replace inline `useQuery` at lines 62–66 with `const { data, isLoading } = useCostAnalytics(30);`
- `packages/web/src/components/dashboard/WorkflowHealthCard.tsx` — replace inline `useQuery` at lines 56–60 with `const { data, isLoading } = useCostAnalytics(30);`

**Naming**: `useCostAnalytics` matches the existing API function name `getCostAnalytics`. The debt around `CostAnalytics` containing health fields is tracked separately as Tier-3 #8 and deferred.

### 2. SQLite day-boundary filter fix

**File**: `packages/core/src/db/workflow-analytics.ts`

**Add one helper**:

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

**Change the three call sites** (lines 64, 92, 124):

```ts
// Before:
WHERE started_at >= $1

// After:
WHERE ${startedAtSinceFilter(1)}
```

**Scope**: Only the parametrized `started_at >= $1` filter. The `completed_at >= started_at` clock-skew check inside `getAvgDuration` is a column-to-column comparison where both sides share the stored format, so it already works correctly.

**No caller changes**. Input format assumptions disappear from the caller side; `datetime()` absorbs the variance.

### 3. Test coverage

#### 3a. DB-layer tests

**File**: `packages/core/src/db/workflow-analytics.test.ts` (new)

Pattern follows the existing `packages/core/src/db/workflows.test.ts` convention with one tweak — a mutable `mockDbType` variable so a single test file can cover both SQLite and PostgreSQL code paths:

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

import { getCostByWorkflow, getDailyCosts, getAvgDuration } from './workflow-analytics';
```

Assertions are made against the **SQL string captured by `mockQuery.mock.calls[0][0]`** — no real database execution. KISS.

**Cases**:

| Case | Assertion |
|---|---|
| Empty result | All three functions return `[]` / `0` when mock returns zero rows |
| Day-boundary (SQLite) | `mockDbType = 'sqlite'` → captured SQL contains `datetime(started_at) >= datetime($1)` for all three functions |
| Day-boundary (Postgres) | `mockDbType = 'postgresql'` → captured SQL contains `started_at >= $1` without `datetime()` wrap |
| Clock-skew exclusion | `getAvgDuration` SQL contains `completed_at >= started_at` |
| `getCostByWorkflow` sort | SQL contains `ORDER BY cost_usd DESC` |
| `getDailyCosts` sort | SQL contains `ORDER BY date ASC` |
| Type coercion | `run_count` returned as `number` even when mock returns string `"5"` |

#### 3b. Route aggregator tests

**File**: `packages/server/src/routes/api.analytics.test.ts` (new)

Pattern follows the existing `packages/server/src/routes/api.*.test.ts` convention — mocks DB layer, exercises the route handler, asserts response shape.

**Cases**:

| Case | Assertion |
|---|---|
| `MIN_RUNS_FOR_FAILURE_RANKING` threshold (below) | Workflow with 2 runs (1 failed) → NOT in `topFailingWorkflows` |
| `MIN_RUNS_FOR_FAILURE_RANKING` threshold (at) | Workflow with 3 runs (1 failed) → IS in `topFailingWorkflows` |
| Zero-failure exclusion | Workflow with 5 runs, 0 failures → NOT in `topFailingWorkflows` |
| Sort by failure rate | Two qualifying workflows → higher `failureRate` listed first |
| `slice(0, 3)` cap | Four qualifying workflows → response contains exactly 3 |
| Response contract | Success case returns the full `CostAnalytics` shape (totals, byWorkflow, daily, successRate, avgDurationSeconds, topFailingWorkflows) |
| Query param validation | `?days=0` and `?days=-1` rejected by existing route schema |

#### 3c. Test batch update

`workflow-analytics.test.ts` uses `mock.module('./connection', ...)` which conflicts with `workflows.test.ts` in the same directory (same path, different implementation — violates the project mock pollution rule).

Update `packages/core/package.json` `scripts.test` to split `workflow-analytics.test.ts` into its own `bun test` invocation, inserted after the main DB batch:

```json
"test": "... && bun test src/db/workflow-analytics.test.ts && ..."
```

The route test requires an equivalent batch entry. The server package test script invokes each `api.*.test.ts` as its own `bun test` call, so append `&& bun test src/routes/api.analytics.test.ts` to the `packages/server/package.json` test script to match the existing convention.

## Validation

- `bun run validate` passes locally (type-check + lint + format:check + tests)
- CI green on PR before merge
- Manual spot-check: `bun run dev`, load dashboard, confirm both cards render against real data with no visual change
- No type regression — `useCostAnalytics` consumers type-check without casts

## Error handling

- `useCostAnalytics`: inherits TanStack Query's existing error semantics via `UseQueryResult`. No new error paths.
- `startedAtSinceFilter`: pure string builder; cannot fail. `datetime()` returning `NULL` for unparseable storage is the safe outcome (row excluded, not included).
- Tests: mock-driven; no real database or network I/O.

## Commit plan

Three atomic commits on `feat/analytics-hardening`:

1. `feat(web): extract useCostAnalytics hook` — hook file + two call-site swaps
2. `fix(core): SQLite day-boundary filter in workflow-analytics queries` — helper + three query call sites
3. `test(core,server): add workflow-analytics DB + route aggregator tests` — two test files + batch entries in both `packages/core/package.json` and `packages/server/package.json`

## Rollback

Each commit is independently revertable.

- Commit 1 regression → revert; cards fall back to inline `useQuery` (pre-PR state).
- Commit 2 regression → revert; Postgres users see no behavior change (Postgres was already correct). SQLite users return to the previous incorrect-but-stable state.
- Commit 3 regression → revert; no runtime impact, only test coverage removed.
