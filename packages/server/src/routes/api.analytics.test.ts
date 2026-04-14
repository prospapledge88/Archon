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

  test('excludes workflows with fewer than 3 runs from topFailingWorkflows', async () => {
    seedWorkflowRows([{ name: 'low-volume', completed: 1, failed: 1 }]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows).toEqual([]);
  });

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

  test('excludes workflows with 0 failures even when totalRuns >= 3', async () => {
    seedWorkflowRows([{ name: 'all-green', completed: 5, failed: 0 }]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows).toEqual([]);
  });

  test('sorts topFailingWorkflows by failureRate DESC', async () => {
    seedWorkflowRows([
      { name: 'lower-rate', completed: 7, failed: 3 },
      { name: 'higher-rate', completed: 2, failed: 3 },
    ]);
    const body = await fetchAnalytics(makeApp());
    expect(body.topFailingWorkflows.map(wf => wf.workflowName)).toEqual([
      'higher-rate',
      'lower-rate',
    ]);
  });

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
});
