import {
  createUsageMetric,
  FREE_LIMITS,
  withUsageGuard,
} from "../../packages/usage-limiter-ts/src/index.ts";

const databaseLimit = FREE_LIMITS.neon.find(
  (metric) => metric.id === "database",
);
if (!databaseLimit) throw new Error("Neon database limit is not configured.");

const databaseMetric = createUsageMetric(databaseLimit, 0.92, undefined, "project-ref");

try {
  await withUsageGuard(databaseMetric, async () => {
    console.log("The operation runs only while measured usage is below 90%.");
  });
} catch (error) {
  if (error instanceof Error && error.name === "UsageLimitReachedError") {
    console.warn(error.message);
  } else {
    throw error;
  }
}
