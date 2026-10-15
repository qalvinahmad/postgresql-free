import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_LIMITS,
  createUsageMetric,
  evaluateUsage,
  getCrossedThresholds,
  getUsagePercent,
  assertUsageAllowed,
  assertSupabaseProjectReady,
  isNeonWakeRetryable,
  PROVIDER_LIFECYCLE,
  SupabaseProjectNotReadyError,
  SupabaseProjectPausedError,
  withNeonWakeRetry,
  withUsageGuard,
  UsageLimitReachedError,
} from "../src/index.ts";

test("evaluates the highest warning threshold reached", () => {
  const metric = createUsageMetric(FREE_LIMITS.neon[0], 0.9);
  const warning = evaluateUsage(metric);

  assert.equal(warning?.threshold, 90);
  assert.equal(warning?.percent, 90);
});

test("returns every threshold crossed between samples", () => {
  assert.deepEqual(getCrossedThresholds(45, 95), [50, 70, 90]);
  assert.deepEqual(getCrossedThresholds(70, 70), []);
  assert.deepEqual(getCrossedThresholds(90, 40), []);
});

test("does not evaluate unavailable or invalid usage", () => {
  const metric = createUsageMetric(FREE_LIMITS.supabase[0], null, "Not exposed");
  assert.equal(getUsagePercent(metric), null);
  assert.equal(evaluateUsage(metric), null);
});

test("rejects zero limits and non-finite measurements", () => {
  const zeroLimit = { ...FREE_LIMITS.neon[0], limit: 0, usage: 1, available: true };
  const invalidUsage = { ...FREE_LIMITS.neon[0], usage: Number.NaN, available: true };
  assert.equal(getUsagePercent(zeroLimit), null);
  assert.equal(getUsagePercent(invalidUsage), null);
});

test("includes the expanded free-plan quotas with explicit scope and period", () => {
  const supabase = FREE_LIMITS.supabase;
  const neon = FREE_LIMITS.neon;
  assert.equal(supabase.find((metric) => metric.id === "monthlyActiveUsers")?.limit, 50_000);
  assert.equal(supabase.find((metric) => metric.id === "monthlyActiveThirdPartyUsers")?.limit, 50_000);
  assert.equal(supabase.find((metric) => metric.id === "realtimeMessages")?.limit, 2_000_000);
  assert.equal(supabase.find((metric) => metric.id === "edgeInvocations")?.limit, 500_000);
  assert.equal(supabase.find((metric) => metric.id === "branches")?.limit, null);
  assert.equal(neon.find((metric) => metric.id === "monthlyActiveUsers")?.limit, 60_000);
  assert.equal(neon.find((metric) => metric.id === "branches")?.limit, 10);
  assert.equal(neon.find((metric) => metric.id === "functionInvocations")?.limit, 1_000_000);
});

test("blocks operations at 90% and above, but permits below threshold", async () => {
  const atNinety = createUsageMetric(FREE_LIMITS.neon[0], 0.9);
  const belowNinety = createUsageMetric(FREE_LIMITS.neon[0], 0.899);
  let started = false;

  assert.throws(() => assertUsageAllowed(atNinety), UsageLimitReachedError);
  assert.equal(assertUsageAllowed(belowNinety), undefined);
  await assert.rejects(
    withUsageGuard(atNinety, () => {
      started = true;
    }),
    UsageLimitReachedError,
  );
  assert.equal(started, false);
  assert.equal(
    await withUsageGuard(belowNinety, async () => "allowed"),
    "allowed",
  );
});

test("unknown usage or unknown limits do not falsely block", () => {
  const unknownUsage = createUsageMetric(FREE_LIMITS.neon[0], null);
  const unknownLimit = createUsageMetric(
    FREE_LIMITS.supabase.find((metric) => metric.id === "branches")!,
    100,
  );
  assert.equal(assertUsageAllowed(unknownUsage), undefined);
  assert.equal(assertUsageAllowed(unknownLimit), undefined);
});

test("documents different provider idle and recovery lifecycles", () => {
  assert.match(PROVIDER_LIFECYCLE.supabase.idleAfter, /7 days/);
  assert.match(PROVIDER_LIFECYCLE.supabase.recovery, /Manually resume/);
  assert.match(PROVIDER_LIFECYCLE.neon.idleAfter, /5 minutes/);
  assert.match(PROVIDER_LIFECYCLE.neon.recovery, /do not ping/i);
});

test("requires manual Supabase resume for paused projects", () => {
  const pausedProject = {
    provider: "supabase" as const,
    projectId: "example",
    projectName: "Example",
    status: "INACTIVE",
    state: "paused" as const,
    message: "Project is paused.",
    resumeUrl: "https://supabase.com/dashboard/project/example",
  };
  assert.throws(
    () => assertSupabaseProjectReady(pausedProject),
    (error) =>
      error instanceof SupabaseProjectPausedError &&
      error.project.resumeUrl === pausedProject.resumeUrl,
  );
  assert.throws(
    () =>
      assertSupabaseProjectReady({
        ...pausedProject,
        state: "unknown",
        status: "UNKNOWN",
      }),
    SupabaseProjectNotReadyError,
  );
});

test("retries Neon wake errors with bounded exponential delays", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await withNeonWakeRetry(
    () => {
      attempts += 1;
      if (attempts < 4) {
        throw Object.assign(new Error("compute is starting"), { code: "57P03" });
      }
      return "connected";
    },
    {
      initialDelayMs: 100,
      maxDelayMs: 150,
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  );

  assert.equal(result, "connected");
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [100, 150, 150]);
  assert.equal(isNeonWakeRetryable(new Error("permission denied")), false);
});

test("does not retry non-wake errors and validates retry configuration", async () => {
  let attempts = 0;
  await assert.rejects(
    withNeonWakeRetry(
      () => {
        attempts += 1;
        throw new Error("permission denied");
      },
      { sleep: async () => {} },
    ),
    /permission denied/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    withNeonWakeRetry(async () => "never", { maxRetries: -1 }),
    RangeError,
  );
});
