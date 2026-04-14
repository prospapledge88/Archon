import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Clock, TrendingDown } from 'lucide-react';
import { getCostAnalytics } from '@/lib/api';
import type { CostAnalytics } from '@/lib/api';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatPercent(decimal: number): string {
  return `${String(Math.round(decimal * 100))}%`;
}

function HealthBreakdown({ data }: { data: CostAnalytics }): React.ReactElement {
  const topFailing = data.topFailingWorkflows;

  return (
    <div className="space-y-3">
      {/* Headline numbers */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="flex items-center gap-1.5 text-lg font-semibold text-text-primary">
          <CheckCircle2 className="h-4 w-4 text-success" />
          {formatPercent(data.successRate)} success
        </span>
        <span className="flex items-center gap-1.5 text-sm text-text-secondary">
          <Clock className="h-3.5 w-3.5" />
          {formatDuration(data.avgDurationSeconds)} avg duration
        </span>
        <span className="text-sm text-text-tertiary">
          {data.totalRuns} run{data.totalRuns !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Top failing workflows */}
      {topFailing.length > 0 && (
        <div className="space-y-1">
          <span className="flex items-center gap-1.5 text-xs font-medium text-text-tertiary">
            <TrendingDown className="h-3 w-3" />
            Top failing workflows
          </span>
          {topFailing.map(wf => (
            <div
              key={wf.workflowName}
              className="flex items-center justify-between text-sm text-text-secondary"
            >
              <span className="truncate font-mono text-xs">{wf.workflowName}</span>
              <span className="ml-4 shrink-0 text-xs text-error">
                {formatPercent(wf.failureRate)} failed &middot; {wf.failedRuns}/{wf.totalRuns} runs
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowHealthCard(): React.ReactElement | null {
  const { data, isLoading } = useQuery({
    queryKey: ['cost-analytics'],
    queryFn: () => getCostAnalytics(30),
    staleTime: 30_000,
  });

  if (isLoading || !data || data.totalRuns === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
        <Activity className="h-4 w-4" />
        Workflow Health (Last 30 days)
      </div>
      <HealthBreakdown data={data} />
    </div>
  );
}
