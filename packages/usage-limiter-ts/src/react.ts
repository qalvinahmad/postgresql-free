import { useEffect, useRef } from "react";
import {
  evaluateUsage,
  getCrossedThresholds,
  type UsageMetric,
  type UsageWarning,
  type WarningThreshold,
} from "./index.ts";

export interface UseUsageWarningsOptions {
  metric: UsageMetric;
  periodKey: string;
  onWarning?: (warning: UsageWarning) => void;
}

export function useUsageWarnings({
  metric,
  periodKey,
  onWarning,
}: UseUsageWarningsOptions): UsageWarning | null {
  const lastSample = useRef<{ periodKey: string; percent: number } | null>(null);
  const warning = evaluateUsage(metric);
  const percent = warning?.percent ?? null;

  useEffect(() => {
    if (percent === null) {
      lastSample.current = null;
      return;
    }

    const previous = lastSample.current;
    if (!previous || previous.periodKey !== periodKey) {
      lastSample.current = { periodKey, percent };
      if (warning) onWarning?.(warning);
      return;
    }

    const crossed = getCrossedThresholds(previous.percent, percent);
    if (warning) {
      for (const threshold of crossed) {
        onWarning?.({ ...warning, threshold });
      }
    }

    lastSample.current = { periodKey, percent };
  }, [metric, onWarning, periodKey, percent, warning]);

  return warning;
}

export function getWarningMessage(warning: UsageWarning): string {
  return `${warning.label} usage reached ${warning.threshold}% (${warning.usage} / ${warning.limit} ${warning.unit}).`;
}

export type { WarningThreshold };
