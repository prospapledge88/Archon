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
