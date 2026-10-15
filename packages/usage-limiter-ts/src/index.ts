export const WARNING_THRESHOLDS = [50, 70, 90] as const;

export type WarningThreshold = (typeof WARNING_THRESHOLDS)[number];
export type Provider = "supabase" | "neon";

export type MetricId =
  | "database"
  | "projects"
  | "compute"
  | "egress"
  | "fileStorage"
  | "monthlyActiveUsers"
  | "monthlyActiveThirdPartyUsers"
  | "realtimeConnections"
  | "realtimeMessages"
  | "edgeInvocations"
  | "branches"
  | "functionInvocations"
  | "functionActiveCapacity"
  | "functionWaitingCapacity";

export type LimitScope = "project" | "organization" | "account";
export type FeatureAvailability =
  | "included"
  | "not-included"
  | "conditional"
  | "external";

export interface MetricLimit {
  id: MetricId;
  label: string;
  limit: number | null;
  unit: string;
  scope: LimitScope;
  period: "month" | "concurrent" | "fixed" | "unknown";
}

export interface UsageMetric extends MetricLimit {
  usage: number | null;
  available: boolean;
  scopeId?: string;
  unavailableReason?: string;
}

export interface UsageSnapshot {
  provider: Provider;
  periodStart: string;
  periodEnd: string;
  metrics: UsageMetric[];
  projects?: ProjectLifecycle[];
}

export type ProjectLifecycleState =
  | "active"
  | "degraded"
  | "idle"
  | "paused"
  | "unknown";

export interface ProjectLifecycle {
  provider: Provider;
  projectId: string;
  projectName: string;
  state: ProjectLifecycleState;
  status: string;
  message: string;
  resumeUrl?: string;
}

export interface ProviderLifecycleProfile {
  idleAfter: string;
  idleBehavior: string;
  wakeBehavior: string;
  applicationImpact: string;
  recovery: string;
}

export interface UsageWarning {
  metricId: MetricId;
  label: string;
  usage: number;
  limit: number;
  unit: string;
  percent: number;
  threshold: WarningThreshold;
  scopeId?: string;
}

export interface FeatureSupport {
  id: string;
  label: string;
  availability: FeatureAvailability;
  details: string;
}

export const HARD_STOP_THRESHOLD: WarningThreshold = 90;

export const PROVIDER_LIFECYCLE: Record<Provider, ProviderLifecycleProfile> = {
  supabase: {
    idleAfter: "Approximately 7 days of low database activity",
    idleBehavior: "The entire free project may be paused.",
    wakeBehavior: "Does not automatically resume when an application request arrives.",
    applicationImpact: "Database APIs and Auth that depend on the project may be unavailable.",
    recovery: "Manually resume the project in the Supabase dashboard; restore is available for up to 1 year.",
  },
  neon: {
    idleAfter: "5 minutes without active queries",
    idleBehavior: "Only the stateless PostgreSQL compute goes idle; stored data remains.",
    wakeBehavior: "A new connection automatically activates compute, usually in a few hundred milliseconds.",
    applicationImpact: "The first database-dependent request may be slower; session-scoped state is lost on suspend.",
    recovery: "Retry a safe connection/startup attempt with bounded backoff; do not ping to keep compute awake.",
  },
};

export function isSupabaseProjectPaused(
  project: Pick<ProjectLifecycle, "provider" | "state">,
): boolean {
  return project.provider === "supabase" && project.state === "paused";
}

export class SupabaseProjectPausedError extends Error {
  readonly project: ProjectLifecycle;

  constructor(project: ProjectLifecycle) {
    super(
      `Supabase project "${project.projectName}" is paused. Resume it manually in the Supabase dashboard.`,
    );
    this.name = "SupabaseProjectPausedError";
    this.project = project;
  }
}

export function assertSupabaseProjectReady(project: ProjectLifecycle): void {
  if (isSupabaseProjectPaused(project)) {
    throw new SupabaseProjectPausedError(project);
  }
  if (project.provider === "supabase" && project.state !== "active") {
    throw new SupabaseProjectNotReadyError(project);
  }
}

export class SupabaseProjectNotReadyError extends Error {
  readonly project: ProjectLifecycle;

  constructor(project: ProjectLifecycle) {
    super(
      `Supabase project "${project.projectName}" is not confirmed ready (status: ${project.status}).`,
    );
    this.name = "SupabaseProjectNotReadyError";
    this.project = project;
  }
}

export interface NeonWakeRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

export function isNeonWakeRetryable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (candidate.code === "57P03") return true;
      if (typeof candidate.message === "string" && isNeonWakeMessage(candidate.message)) {
        return true;
      }
      current = candidate.cause;
    } else if (typeof current === "string") {
      return isNeonWakeMessage(current);
    } else {
      return false;
    }
  }

  return false;
}

function isNeonWakeMessage(message: string): boolean {
  return /cannot connect now|compute (?:is )?(?:waking|starting|idle)|endpoint (?:is )?(?:suspended|starting)|database system is starting up/i.test(
    message,
  );
}

/**
 * Retry only known Neon compute-startup errors. The callback must be safe to
 * retry (ideally connection establishment or an idempotent operation).
 */
export async function withNeonWakeRetry<T>(
  operation: () => T | Promise<T>,
  options: NeonWakeRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 1_000;
  const isRetryable = options.isRetryable ?? isNeonWakeRetryable;
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative integer.");
  }
  if (
    !Number.isFinite(initialDelayMs) ||
    initialDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < 0
  ) {
    throw new RangeError("Retry delays must be non-negative finite numbers.");
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
}

export const FREE_LIMITS: Record<Provider, readonly MetricLimit[]> = {
  supabase: [
    { id: "database", label: "Database", limit: 500, unit: "MB", scope: "project", period: "fixed" },
    { id: "projects", label: "Projects", limit: 2, unit: "projects", scope: "account", period: "fixed" },
    { id: "compute", label: "Compute memory", limit: 500, unit: "MB RAM", scope: "project", period: "fixed" },
    { id: "egress", label: "Egress bandwidth", limit: 5, unit: "GB", scope: "organization", period: "month" },
    { id: "fileStorage", label: "File storage", limit: 1, unit: "GB", scope: "organization", period: "fixed" },
    { id: "monthlyActiveUsers", label: "Monthly active users", limit: 50_000, unit: "MAU", scope: "organization", period: "month" },
    { id: "monthlyActiveThirdPartyUsers", label: "Monthly active third-party users", limit: 50_000, unit: "MAU", scope: "organization", period: "month" },
    { id: "realtimeConnections", label: "Realtime concurrent connections", limit: 200, unit: "connections", scope: "project", period: "concurrent" },
    { id: "realtimeMessages", label: "Realtime messages", limit: 2_000_000, unit: "messages", scope: "organization", period: "month" },
    { id: "edgeInvocations", label: "Edge Function invocations", limit: 500_000, unit: "invocations", scope: "organization", period: "month" },
    { id: "branches", label: "Database branches", limit: null, unit: "branches", scope: "project", period: "unknown" },
  ],
  neon: [
    { id: "database", label: "Database", limit: 1, unit: "GB", scope: "project", period: "fixed" },
    { id: "projects", label: "Projects", limit: 100, unit: "projects", scope: "account", period: "fixed" },
    { id: "compute", label: "Compute", limit: 100, unit: "CU-hours", scope: "project", period: "month" },
    { id: "egress", label: "Egress bandwidth", limit: 5, unit: "GB", scope: "project", period: "month" },
    { id: "fileStorage", label: "Object storage", limit: 5, unit: "GB", scope: "project", period: "fixed" },
    { id: "monthlyActiveUsers", label: "Better Auth monthly active users", limit: 60_000, unit: "MAU", scope: "project", period: "month" },
    { id: "branches", label: "Database branches", limit: 10, unit: "branches", scope: "project", period: "fixed" },
    { id: "functionInvocations", label: "Node.js Function invocations", limit: 1_000_000, unit: "invocations", scope: "project", period: "month" },
    { id: "functionActiveCapacity", label: "Node.js Functions active capacity", limit: 10, unit: "capacity-hours", scope: "project", period: "month" },
    { id: "functionWaitingCapacity", label: "Node.js Functions waiting capacity", limit: 400, unit: "capacity-hours", scope: "project", period: "month" },
  ],
};

export const FREE_FEATURES: Record<Provider, readonly FeatureSupport[]> = {
  supabase: [
    { id: "postgresql", label: "PostgreSQL", availability: "included", details: "Managed PostgreSQL database." },
    { id: "auth", label: "Email/password, OAuth, magic link, OTP, and user management", availability: "included", details: "Supabase Auth." },
    { id: "realtime", label: "Realtime changes, Broadcast, and Presence", availability: "included", details: "Realtime limits are also listed in FREE_LIMITS." },
    { id: "rest", label: "Automatic REST API", availability: "included", details: "Generated from the database schema." },
    { id: "functions", label: "Server-side functions", availability: "included", details: "Edge Functions; invocation quota is listed in FREE_LIMITS." },
    { id: "branches", label: "Database branching", availability: "conditional", details: "Availability and limits depend on the current plan and feature terms." },
    { id: "logs", label: "Logs and monitoring", availability: "included", details: "Retention and available detail vary by plan." },
    { id: "instantRestore", label: "Instant restore", availability: "not-included", details: "Free plan does not include paid-plan point-in-time recovery." },
  ],
  neon: [
    { id: "postgresql", label: "PostgreSQL", availability: "included", details: "Serverless PostgreSQL." },
    { id: "auth", label: "Email/password, OAuth, magic link, OTP, and user management", availability: "included", details: "Better Auth integration; included MAU allowance is listed in FREE_LIMITS." },
    { id: "realtime", label: "Database Realtime, Broadcast, and Presence", availability: "external", details: "Use a separate realtime solution; no universal database realtime quota." },
    { id: "rest", label: "REST API", availability: "conditional", details: "PostgREST-compatible options are available; not a built-in generated API." },
    { id: "functions", label: "Server-side functions", availability: "included", details: "Node.js Functions; quotas are listed in FREE_LIMITS." },
    { id: "branches", label: "Database branching", availability: "included", details: "10 branches per project." },
    { id: "logs", label: "Logs and monitoring", availability: "included", details: "Retention and available detail vary by plan." },
    { id: "instantRestore", label: "Instant restore", availability: "included", details: "6-hour restore window." },
  ],
};

export function getUsagePercent(metric: UsageMetric): number | null {
  const limit = metric.limit;
  if (
    !metric.available ||
    metric.usage === null ||
    !Number.isFinite(metric.usage) ||
    limit === null ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return null;
  }

  return Math.max(0, (metric.usage / limit) * 100);
}

export function getWarningThreshold(percent: number): WarningThreshold | null {
  if (!Number.isFinite(percent)) return null;

  for (let index = WARNING_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    const threshold = WARNING_THRESHOLDS[index];
    if (percent >= threshold) return threshold;
  }

  return null;
}

export function evaluateUsage(metric: UsageMetric): UsageWarning | null {
  const percent = getUsagePercent(metric);
  const threshold = percent === null ? null : getWarningThreshold(percent);
  const usage = metric.usage;
  const limit = metric.limit;

  if (percent === null || threshold === null || usage === null || limit === null) {
    return null;
  }

  return {
    metricId: metric.id,
    label: metric.label,
    usage,
    limit,
    unit: metric.unit,
    percent,
    threshold,
    ...(metric.scopeId ? { scopeId: metric.scopeId } : {}),
  };
}

/**
 * Return only warning levels crossed since the previous sample. Persist the
 * previous percentage per metric and billing period to avoid repeat alerts.
 */
export function getCrossedThresholds(
  previousPercent: number,
  currentPercent: number,
): WarningThreshold[] {
  if (!Number.isFinite(previousPercent) || !Number.isFinite(currentPercent)) {
    return [];
  }

  return WARNING_THRESHOLDS.filter(
    (threshold) => previousPercent < threshold && currentPercent >= threshold,
  );
}

export function createUsageMetric(
  limit: MetricLimit,
  usage: number | null,
  unavailableReason?: string,
  scopeId?: string,
): UsageMetric {
  const available = usage !== null && Number.isFinite(usage);
  return {
    ...limit,
    usage: available ? usage : null,
    available,
    ...(scopeId ? { scopeId } : {}),
    ...(available
      ? {}
      : { unavailableReason: unavailableReason ?? "Usage data is unavailable." }),
  };
}

export class UsageLimitReachedError extends Error {
  readonly warning: UsageWarning;

  constructor(warning: UsageWarning) {
    super(
      `${warning.label} reached the ${HARD_STOP_THRESHOLD}% hard-stop threshold; operation blocked.`,
    );
    this.name = "UsageLimitReachedError";
    this.warning = warning;
  }
}

export function assertUsageAllowed(metric: UsageMetric): void {
  const warning = evaluateUsage(metric);
  if (warning && warning.percent >= HARD_STOP_THRESHOLD) {
    throw new UsageLimitReachedError(warning);
  }
}

export async function withUsageGuard<T>(
  metric: UsageMetric,
  operation: () => T | Promise<T>,
): Promise<T> {
  assertUsageAllowed(metric);
  return operation();
}
