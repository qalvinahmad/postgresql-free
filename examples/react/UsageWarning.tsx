import { useUsageWarnings } from
  "../../packages/usage-limiter-ts/src/react.ts";
import type { UsageMetric } from
  "../../packages/usage-limiter-ts/src/index.ts";

export function UsageWarning({ metric }: { metric: UsageMetric }) {
  const warning = useUsageWarnings({
    metric,
    periodKey: "2026-10",
    onWarning: (event) => {
      console.info(`${event.label} crossed ${event.threshold}%`);
    },
  });

  if (!warning) return null;
  return (
    <aside role="status" aria-live="polite">
      {warning.label}: {Math.round(warning.percent)}% used
    </aside>
  );
}
