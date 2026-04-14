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
