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

const topFailingWorkflowSchema = z.object({
  workflowName: z.string(),
  failureRate: z.number(),
  failedRuns: z.number(),
  totalRuns: z.number(),
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
    successRate: z.number(),
    avgDurationSeconds: z.number(),
    topFailingWorkflows: z.array(topFailingWorkflowSchema),
  })
  .openapi('CostAnalyticsResponse');
