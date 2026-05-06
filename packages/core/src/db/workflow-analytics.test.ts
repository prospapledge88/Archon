import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
// Mutable so each `describe` block can flip the dialect by mutating this in a nested
// `beforeEach`. Safe because:
//  - the `mock.module('./connection', ...)` factory below captures it by closure, so
//    `getDatabaseType()` reads the current value on every call;
//  - Bun runs outer `beforeEach` before inner `beforeEach`, so the outer reset to
//    'postgresql' always fires before an inner flip to 'sqlite';
//  - tests within a file run serially, so there's no parallel-execution race.
let mockDbType: 'sqlite' | 'postgresql' = 'postgresql';

mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => mockDbType,
}));

import { getCostByWorkflow, getDailyCosts, getAvgDuration } from './workflow-analytics';

/** Extract the captured SQL + params from the Nth mockQuery call. Throws with a clear message if the mock wasn't called. */
function getCallArgs(n: number): { sql: string; params: readonly unknown[] } {
  const call = mockQuery.mock.calls[n];
  if (!call) {
    throw new Error(
      `mockQuery was not called at index ${n} — function under test may have failed before querying`
    );
  }
  return {
    sql: call[0] as string,
    params: (call[1] ?? []) as readonly unknown[],
  };
}

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
      const { sql, params } = getCallArgs(0);
      expect(sql).toContain('datetime(started_at) >= datetime($1)');
      expect(params).toEqual(['2026-04-14T00:00:00Z']);
    });

    test('getDailyCosts wraps started_at with datetime()', async () => {
      await getDailyCosts('2026-04-14T00:00:00Z');
      const { sql, params } = getCallArgs(0);
      expect(sql).toContain('datetime(started_at) >= datetime($1)');
      expect(params).toEqual(['2026-04-14T00:00:00Z']);
    });

    test('getAvgDuration wraps started_at with datetime()', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const { sql, params } = getCallArgs(0);
      expect(sql).toContain('datetime(started_at) >= datetime($1)');
      expect(params).toEqual(['2026-04-14T00:00:00Z']);
    });
  });

  describe('day-boundary filter (Postgres)', () => {
    test('getCostByWorkflow uses plain >= comparison', async () => {
      await getCostByWorkflow('2026-04-14T00:00:00Z');
      const { sql, params } = getCallArgs(0);
      expect(sql).toContain('started_at >= $1');
      expect(sql).not.toContain('datetime(');
      expect(params).toEqual(['2026-04-14T00:00:00Z']);
    });

    test('getDailyCosts uses plain >= comparison', async () => {
      await getDailyCosts('2026-04-14T00:00:00Z');
      const { sql, params } = getCallArgs(0);
      expect(sql).toContain('started_at >= $1');
      expect(sql).not.toContain('datetime(');
      expect(params).toEqual(['2026-04-14T00:00:00Z']);
    });

    test('getAvgDuration uses plain >= comparison', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const { sql, params } = getCallArgs(0);
      expect(sql).toContain('started_at >= $1');
      expect(sql).not.toContain('datetime(');
      expect(params).toEqual(['2026-04-14T00:00:00Z']);
    });
  });

  describe('empty result', () => {
    test('getCostByWorkflow returns [] when no rows', async () => {
      const result = await getCostByWorkflow('2026-04-14T00:00:00Z');
      expect(result).toEqual([]);
    });

    test('getDailyCosts returns [] when no rows', async () => {
      const result = await getDailyCosts('2026-04-14T00:00:00Z');
      expect(result).toEqual([]);
    });

    test('getAvgDuration returns 0 when avg_seconds is null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ avg_seconds: null }]));
      const result = await getAvgDuration('2026-04-14T00:00:00Z');
      expect(result).toBe(0);
    });

    test('getAvgDuration returns 0 when result has no rows', async () => {
      const result = await getAvgDuration('2026-04-14T00:00:00Z');
      expect(result).toBe(0);
    });

    test('getAvgDuration returns 0 when avg_seconds is not finite', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ avg_seconds: 'not-a-number' }]));
      const result = await getAvgDuration('2026-04-14T00:00:00Z');
      expect(result).toBe(0);
    });
  });

  describe('getAvgDuration clock-skew exclusion', () => {
    test('SQL excludes rows with missing or earlier completed_at', async () => {
      await getAvgDuration('2026-04-14T00:00:00Z');
      const { sql } = getCallArgs(0);
      expect(sql).toContain('completed_at IS NOT NULL');
      expect(sql).toContain('completed_at >= started_at');
    });
  });

  describe('sort ordering', () => {
    test('getCostByWorkflow sorts by cost_usd DESC', async () => {
      await getCostByWorkflow('2026-04-14T00:00:00Z');
      const { sql } = getCallArgs(0);
      expect(sql).toMatch(/ORDER BY cost_usd DESC/i);
    });

    test('getDailyCosts sorts by date ASC', async () => {
      await getDailyCosts('2026-04-14T00:00:00Z');
      const { sql } = getCallArgs(0);
      expect(sql).toMatch(/ORDER BY date ASC/i);
    });
  });

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
});
