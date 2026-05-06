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
  return getDatabaseType() === 'postgresql' ? 'DATE(started_at)' : "DATE(started_at, 'utc')";
}

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

/** Raw row shape from aggregate queries — COUNT/SUM may return string or bigint in SQLite. */
interface RawWorkflowCostRow {
  workflow_name: string;
  status: string;
  run_count: string | number;
  cost_usd: string | number;
}

interface RawDailyCostRow {
  date: string;
  run_count: string | number;
  cost_usd: string | number;
}

/**
 * Get per-workflow cost breakdown grouped by workflow name and status.
 * Only includes terminal runs (completed, failed).
 */
export async function getCostByWorkflow(sinceDate: string): Promise<WorkflowCostRow[]> {
  try {
    const result = await pool.query<RawWorkflowCostRow>(
      `SELECT workflow_name, status,
        COUNT(*) as run_count,
        SUM(${jsonCostExtract()}) as cost_usd
      FROM remote_agent_workflow_runs
      WHERE ${startedAtSinceFilter(1)}
        AND status IN ('completed', 'failed')
      GROUP BY workflow_name, status
      ORDER BY cost_usd DESC`,
      [sinceDate]
    );
    return result.rows.map(row => ({
      workflow_name: row.workflow_name,
      status: row.status,
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
    const result = await pool.query<RawDailyCostRow>(
      `SELECT ${dateExtract()} as date,
        COUNT(*) as run_count,
        SUM(${jsonCostExtract()}) as cost_usd
      FROM remote_agent_workflow_runs
      WHERE ${startedAtSinceFilter(1)}
        AND status IN ('completed', 'failed')
      GROUP BY ${dateExtract()}
      ORDER BY date ASC`,
      [sinceDate]
    );
    return result.rows.map(row => ({
      date: row.date,
      run_count: Number(row.run_count),
      cost_usd: Number(row.cost_usd),
    }));
  } catch (error) {
    getLog().error({ err: error as Error, sinceDate }, 'daily_costs_query_failed');
    throw error;
  }
}

/**
 * Get the average duration (in seconds) of terminal workflow runs in the period.
 * Dialect-aware: SQLite uses julianday() arithmetic, PostgreSQL uses EXTRACT(EPOCH FROM ...).
 * Returns 0 when no terminal runs exist.
 */
export async function getAvgDuration(sinceDate: string): Promise<number> {
  try {
    const durationExpr =
      getDatabaseType() === 'postgresql'
        ? 'EXTRACT(EPOCH FROM (completed_at - started_at))'
        : '(julianday(completed_at) - julianday(started_at)) * 86400';

    const result = await pool.query<{ avg_seconds: string | number | null }>(
      `SELECT AVG(${durationExpr}) as avg_seconds
       FROM remote_agent_workflow_runs
       WHERE ${startedAtSinceFilter(1)}
         AND status IN ('completed', 'failed')
         AND completed_at IS NOT NULL
         AND completed_at >= started_at`,
      [sinceDate]
    );
    const raw = result.rows[0]?.avg_seconds;
    if (raw == null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    getLog().error({ err: error as Error, sinceDate }, 'avg_duration_query_failed');
    throw error;
  }
}
