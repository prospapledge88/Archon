/**
 * Workflow scheduler service — fires workflows on cron schedules.
 *
 * Follows the cleanup-service.ts lifecycle pattern:
 * - startWorkflowScheduler() / stopWorkflowScheduler()
 * - Single setInterval tick loop (60s)
 * - Scans registered codebases for schedule configs
 * - Dispatches via executeWorkflow() with a logging-only adapter
 */
import { createLogger } from '@archon/paths';
import { matchesCron } from './cron-parser';
import { SchedulePlatformAdapter } from './schedule-adapter';
import { loadConfig } from '../config/config-loader';
import * as codebaseDb from '../db/codebases';
import { createWorkflowDeps } from '../workflows/store-adapter';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { findWorkflow } from '@archon/workflows/router';
import { executeWorkflow } from '@archon/workflows/executor';
import * as conversationDb from '../db/conversations';
import * as workflowEventDb from '../db/workflow-events';
import * as workflowDb from '../db/workflows';
import { recordWorkflowRun } from './knowledge-writer';
import type { ScheduleEntry } from '../config/config-types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.scheduler');
  return cachedLog;
}

/** Tick interval: 60 seconds (cron minimum granularity) */
const TICK_INTERVAL_MS = 60_000;
/** Rescan interval: every 5 minutes, reload codebase configs */
const RESCAN_INTERVAL_TICKS = 5;

interface ResolvedSchedule {
  codebaseId: string;
  codebaseName: string;
  cwd: string;
  entry: ScheduleEntry;
}

let tickIntervalId: ReturnType<typeof setInterval> | undefined;
let resolvedSchedules: ResolvedSchedule[] = [];
let tickCount = 0;

/**
 * Scan all registered codebases and collect active schedule entries.
 */
async function rescanSchedules(): Promise<void> {
  try {
    const codebases = await codebaseDb.listCodebases();
    const schedules: ResolvedSchedule[] = [];

    for (const cb of codebases) {
      try {
        const config = await loadConfig(cb.default_cwd);
        for (const entry of config.schedules) {
          if (entry.enabled === false) continue;
          schedules.push({
            codebaseId: cb.id,
            codebaseName: cb.name,
            cwd: cb.default_cwd,
            entry,
          });
        }
      } catch (error) {
        getLog().debug(
          { err: error as Error, codebaseId: cb.id, cwd: cb.default_cwd },
          'scheduler.config_load_failed'
        );
      }
    }

    resolvedSchedules = schedules;
    if (schedules.length > 0) {
      getLog().info(
        { count: schedules.length, codebases: [...new Set(schedules.map(s => s.codebaseName))] },
        'scheduler.rescan_completed'
      );
    }
  } catch (error) {
    getLog().error({ err: error as Error }, 'scheduler.rescan_failed');
  }
}

/**
 * Process a single tick: check all schedules and dispatch due workflows.
 */
async function tick(): Promise<void> {
  tickCount++;

  // Rescan configs periodically
  if (tickCount % RESCAN_INTERVAL_TICKS === 0) {
    await rescanSchedules();
  }

  if (resolvedSchedules.length === 0) return;

  const now = new Date();
  const deps = createWorkflowDeps();
  const adapter = new SchedulePlatformAdapter();

  for (const schedule of resolvedSchedules) {
    try {
      if (!matchesCron(schedule.entry.cron, now)) continue;

      // Check for active run on same path (skip if already running)
      const activeRun = await deps.store.getActiveWorkflowRunByPath(schedule.cwd);
      if (activeRun) {
        getLog().debug(
          {
            workflowName: schedule.entry.workflow,
            codebase: schedule.codebaseName,
            activeRunId: activeRun.id,
          },
          'scheduler.skip_active_run'
        );
        continue;
      }

      // Discover workflows for this codebase
      const { workflows: discoveredWorkflows } = await discoverWorkflowsWithConfig(
        schedule.cwd,
        loadConfig
      );
      const allWorkflows = discoveredWorkflows.map(w => w.workflow);
      const workflow = findWorkflow(schedule.entry.workflow, allWorkflows);
      if (!workflow) {
        getLog().warn(
          { workflowName: schedule.entry.workflow, codebase: schedule.codebaseName },
          'scheduler.workflow_not_found'
        );
        continue;
      }

      // Create a synthetic conversation for this scheduled run
      const conversationId = `schedule-${schedule.entry.workflow}-${Date.now()}`;
      const conversation = await conversationDb.getOrCreateConversation(
        'schedule',
        conversationId,
        schedule.codebaseId
      );
      // Mark as hidden so it doesn't clutter the UI listing
      await conversationDb.updateConversation(conversation.id, { hidden: true });

      const userMessage = `Scheduled run (${schedule.entry.cron})`;

      getLog().info(
        {
          workflowName: workflow.name,
          codebase: schedule.codebaseName,
          cron: schedule.entry.cron,
          conversationId: conversation.id,
        },
        'scheduler.dispatch_started'
      );

      // Fire-and-forget — don't block the tick loop
      executeWorkflow(
        deps,
        adapter,
        conversationId,
        schedule.cwd,
        workflow,
        userMessage,
        conversation.id,
        schedule.codebaseId
      )
        .then(async result => {
          getLog().info(
            {
              workflowName: workflow.name,
              codebase: schedule.codebaseName,
              success: result.success,
              runId: result.workflowRunId,
            },
            'scheduler.dispatch_completed'
          );

          // Record run in project knowledge (non-blocking)
          if (result.workflowRunId) {
            try {
              const events = await workflowEventDb.listWorkflowEvents(result.workflowRunId);
              const completed = events.filter(e => e.event_type === 'node_completed').length;
              const failed = events.filter(e => e.event_type === 'node_failed').length;
              const skipped = events.filter(e => e.event_type === 'node_skipped').length;
              const errors = events
                .filter(e => e.event_type === 'node_failed')
                .map(e => {
                  const rawError = e.data.error;
                  const message = typeof rawError === 'string' ? rawError : 'Unknown error';
                  return { nodeName: e.step_name ?? 'unknown', message };
                });

              const run = await workflowDb.getWorkflowRun(result.workflowRunId);
              const costUsd =
                typeof run?.metadata?.total_cost_usd === 'number'
                  ? run.metadata.total_cost_usd
                  : undefined;

              await recordWorkflowRun(schedule.cwd, {
                workflowName: workflow.name,
                status: result.success ? 'completed' : 'failed',
                startedAt: run?.started_at
                  ? new Date(run.started_at).toISOString()
                  : new Date().toISOString(),
                completedAt: run?.completed_at
                  ? new Date(run.completed_at).toISOString()
                  : new Date().toISOString(),
                costUsd,
                nodesCompleted: completed,
                nodesFailed: failed,
                nodesSkipped: skipped,
                errors,
              });
            } catch (error) {
              getLog().error(
                { err: error as Error, runId: result.workflowRunId },
                'scheduler.knowledge_record_failed'
              );
            }
          }
        })
        .catch(error => {
          getLog().error(
            { err: error as Error, workflowName: workflow.name, codebase: schedule.codebaseName },
            'scheduler.dispatch_failed'
          );
        });
    } catch (error) {
      getLog().error(
        {
          err: error as Error,
          workflowName: schedule.entry.workflow,
          codebase: schedule.codebaseName,
        },
        'scheduler.tick_error'
      );
    }
  }
}

/**
 * Start the workflow scheduler. Scans codebases for schedule configs
 * and begins the 60-second tick loop.
 */
export async function startWorkflowScheduler(): Promise<void> {
  if (tickIntervalId) {
    getLog().warn('scheduler.already_running');
    return;
  }

  await rescanSchedules();

  if (resolvedSchedules.length === 0) {
    getLog().info('scheduler.no_schedules_configured');
  }

  tickIntervalId = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  getLog().info(
    { tickIntervalMs: TICK_INTERVAL_MS, scheduleCount: resolvedSchedules.length },
    'scheduler.started'
  );
}

/**
 * Stop the workflow scheduler.
 */
export function stopWorkflowScheduler(): void {
  if (tickIntervalId) {
    clearInterval(tickIntervalId);
    tickIntervalId = undefined;
    resolvedSchedules = [];
    tickCount = 0;
    getLog().info('scheduler.stopped');
  }
}
