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
});
