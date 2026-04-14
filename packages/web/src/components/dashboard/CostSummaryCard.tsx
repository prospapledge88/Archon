import { useQuery } from '@tanstack/react-query';
import { DollarSign, CheckCircle2, XCircle } from 'lucide-react';
import { getCostAnalytics } from '@/lib/api';
import type { CostAnalytics } from '@/lib/api';

function formatCost(usd: number): string {
  return `$${usd.toFixed(usd >= 10 ? 2 : 4)}`;
}

function CostBreakdown({ data }: { data: CostAnalytics }): React.ReactElement {
  const avgCost = data.totalRuns > 0 ? data.totalCostUsd / data.totalRuns : 0;
  const topWorkflows = data.byWorkflow.slice(0, 3);

  return (
    <div className="space-y-3">
      {/* Headline numbers */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-lg font-semibold text-text-primary">
          {formatCost(data.totalCostUsd)}
        </span>
        <span className="text-sm text-text-secondary">
          {data.totalRuns} run{data.totalRuns !== 1 ? 's' : ''}
        </span>
        <span className="text-sm text-text-tertiary">{formatCost(avgCost)} avg/run</span>
      </div>

      {/* Success / failure split */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {formatCost(data.successCostUsd)} successful ({data.successfulRuns})
        </span>
        <span className="flex items-center gap-1.5 text-error">
          <XCircle className="h-3.5 w-3.5" />
          {formatCost(data.failedCostUsd)} failed ({data.failedRuns})
        </span>
      </div>

      {/* Top workflows */}
      {topWorkflows.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-text-tertiary">Top workflows</span>
          {topWorkflows.map(wf => (
            <div
              key={wf.workflowName}
              className="flex items-center justify-between text-sm text-text-secondary"
            >
              <span className="truncate font-mono text-xs">{wf.workflowName}</span>
              <span className="ml-4 shrink-0 text-xs text-text-tertiary">
                {formatCost(wf.costUsd)} &middot; {wf.runs} run{wf.runs !== 1 ? 's' : ''} &middot;{' '}
                {formatCost(wf.avgCostUsd)} avg
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CostSummaryCard(): React.ReactElement | null {
  const { data, isLoading } = useQuery({
    queryKey: ['cost-analytics', { days: 30 }],
    queryFn: () => getCostAnalytics(30),
    staleTime: 30_000,
  });

  // Hide card when loading or no data
  if (isLoading || !data || data.totalRuns === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-secondary">
        <DollarSign className="h-4 w-4" />
        Spend (Last 30 days)
      </div>
      <CostBreakdown data={data} />
    </div>
  );
}
