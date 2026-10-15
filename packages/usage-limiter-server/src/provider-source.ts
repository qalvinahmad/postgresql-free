import {
  FREE_LIMITS,
  createUsageMetric,
  type Provider,
  type ProjectLifecycle,
  type UsageMetric,
  type UsageSnapshot,
} from "@usage-limit-warnings/typescript";
import type { UsageSource } from "./index.ts";

const SUPABASE_API = "https://api.supabase.com/v1";
const NEON_API = "https://console.neon.tech/api/v2";

export interface ProviderSourceOptions {
  supabase?: {
    accessToken: string;
  };
  neon?: {
    apiKey: string;
    organizationId: string;
  };
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface NeonProjectList {
  projects?: unknown;
  pagination?: { cursor?: unknown };
}

interface NeonProject {
  id: string;
  name?: string;
}

interface NeonProjectUsage {
  id?: unknown;
  data_transfer_bytes?: unknown;
  consumption_period_start?: unknown;
  consumption_period_end?: unknown;
}

interface NeonProjectDetailsResponse {
  project?: NeonProjectUsage;
}

interface SupabaseProject {
  ref?: unknown;
  id?: unknown;
  name?: unknown;
  status?: unknown;
}

export function createProviderUsageSource(
  options: ProviderSourceOptions,
): UsageSource {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    async load(provider): Promise<UsageSnapshot> {
      let metrics: UsageMetric[];
      let period = currentMonthPeriod(now());
      let projects: ProjectLifecycle[] | undefined;
      if (provider === "supabase") {
        projects = await getSupabaseProjects(
          options.supabase?.accessToken,
          fetcher,
        );
        metrics = buildMetrics(
          provider,
          projects.filter(
            (project) =>
              project.status === "ACTIVE_HEALTHY" ||
              project.status === "ACTIVE_UNHEALTHY",
          ).length,
        );
      } else {
        const projects = await getNeonProjects(
          options.neon?.apiKey,
          options.neon?.organizationId,
          fetcher,
        );
        metrics = buildMetrics(provider, projects.length);
        const result = await addNeonProjectUsage(
          metrics,
          projects,
          options.neon?.apiKey,
          fetcher,
        );
        metrics = result.metrics;
        period = result.period ?? period;
      }
      return {
        provider,
        periodStart: period.start,
        periodEnd: period.end,
        metrics,
        ...(projects ? { projects } : {}),
      };
    },
  };
}

function buildMetrics(provider: Provider, projectCount: number): UsageMetric[] {
  return FREE_LIMITS[provider].map((limit) =>
    limit.id === "projects"
      ? createUsageMetric(limit, projectCount)
      : createUsageMetric(
          limit,
          null,
          provider === "neon"
            ? "Exact free-tier usage is not exposed by the Neon usage-history API."
            : "Exact usage is not exposed by the Supabase project-list API.",
        ),
  );
}

async function addNeonProjectUsage(
  baseMetrics: UsageMetric[],
  projects: NeonProject[],
  apiKey: string | undefined,
  fetcher: typeof globalThis.fetch,
): Promise<{
  metrics: UsageMetric[];
  period: { start: string; end: string } | null;
}> {
  if (!apiKey) throw new Error("NEON_API_KEY is required.");

  const egressLimit = FREE_LIMITS.neon.find((metric) => metric.id === "egress");
  if (!egressLimit) {
    throw new Error("Neon free-tier metric limits are not configured.");
  }
  const projectMetrics: UsageMetric[] = [];
  let period: { start: string; end: string } | null = null;

  for (let index = 0; index < projects.length; index += 5) {
    const page = projects.slice(index, index + 5);
    const usage = await Promise.all(
      page.map((project) => getNeonProjectUsage(project, apiKey, fetcher)),
    );

    for (let item = 0; item < page.length; item += 1) {
      const project = page[item];
      const projectUsage = usage[item];
      const label = project.name || project.id;
      if (projectUsage.periodStart && projectUsage.periodEnd) {
        if (
          period &&
          (period.start !== projectUsage.periodStart ||
            period.end !== projectUsage.periodEnd)
        ) {
          throw new Error("Neon projects returned inconsistent usage periods.");
        }
        period = {
          start: projectUsage.periodStart,
          end: projectUsage.periodEnd,
        };
      }
      const periodReason =
        projectUsage.periodStart && projectUsage.periodEnd
          ? undefined
          : "The provider did not return the current consumption period.";

      projectMetrics.push(
        createUsageMetric(
          { ...egressLimit, label: `${label} — Egress` },
          isFiniteNumber(projectUsage.dataTransferBytes)
            ? projectUsage.dataTransferBytes / 1_000_000_000
            : null,
          periodReason ??
            "Neon did not return data_transfer_bytes for this project.",
          project.id,
        ),
      );
    }
  }

  return {
    metrics: baseMetrics
      .filter((metric) => metric.id !== "egress")
      .concat(projectMetrics),
    period,
  };
}

async function getNeonProjectUsage(
  project: NeonProject,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
): Promise<{
  dataTransferBytes: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}> {
  const response = await fetcher(
    `${NEON_API}/projects/${encodeURIComponent(project.id)}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  if (!response.ok) {
    throw new Error(`Neon project usage request failed (${response.status}).`);
  }

  const payload = (await response.json()) as NeonProjectDetailsResponse;
  const usage = payload.project;
  return {
    dataTransferBytes: isFiniteNumber(usage?.data_transfer_bytes)
      ? usage.data_transfer_bytes
      : null,
    periodStart:
      typeof usage?.consumption_period_start === "string"
        ? usage.consumption_period_start
        : null,
    periodEnd:
      typeof usage?.consumption_period_end === "string"
        ? usage.consumption_period_end
        : null,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function getSupabaseProjects(
  accessToken: string | undefined,
  fetcher: typeof globalThis.fetch,
): Promise<ProjectLifecycle[]> {
  if (!accessToken) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required.");
  }

  const response = await fetcher(`${SUPABASE_API}/projects`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Supabase project-list request failed (${response.status}).`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Supabase project-list response was invalid.");
  }

  return (payload as SupabaseProject[]).flatMap((project) => {
    const projectId =
      typeof project.ref === "string"
        ? project.ref
        : typeof project.id === "string"
          ? project.id
          : undefined;
    if (!projectId) return [];

    const status =
      typeof project.status === "string" ? project.status : "UNKNOWN";
    const state =
      status === "ACTIVE_HEALTHY"
        ? "active"
        : status === "ACTIVE_UNHEALTHY"
          ? "degraded"
          : status === "INACTIVE" || status === "PAUSED"
            ? "paused"
            : "unknown";
    const projectName =
      typeof project.name === "string" ? project.name : projectId;
    const lifecycle: ProjectLifecycle = {
      provider: "supabase",
      projectId,
      projectName,
      state,
      status,
      message:
        state === "paused"
          ? "Project is paused. Resume it manually in the Supabase dashboard."
          : state === "active"
            ? "Project is active."
            : state === "degraded"
              ? "Project is active but unhealthy; availability is not confirmed."
              : `Project status is ${status}; availability is not confirmed.`,
      ...(state === "paused"
        ? { resumeUrl: `https://supabase.com/dashboard/project/${projectId}` }
        : {}),
    };
    return [lifecycle];
  });
}

async function getNeonProjects(
  apiKey: string | undefined,
  organizationId: string | undefined,
  fetcher: typeof globalThis.fetch,
): Promise<NeonProject[]> {
  if (!apiKey || !organizationId) {
    throw new Error("NEON_API_KEY and NEON_ORGANIZATION_ID are required.");
  }

  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const projects: NeonProject[] = [];

  do {
    const url = new URL(`${NEON_API}/projects`);
    url.searchParams.set("org_id", organizationId);
    url.searchParams.set("limit", "400");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`Neon project-list request failed (${response.status}).`);
    }

    const payload = (await response.json()) as NeonProjectList;
    if (!Array.isArray(payload.projects)) {
      throw new Error("Neon project-list response was invalid.");
    }
    for (const value of payload.projects) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        typeof value.id !== "string"
      ) {
        throw new Error("Neon project-list response was invalid.");
      }
      projects.push({
        id: value.id,
        name: "name" in value && typeof value.name === "string" ? value.name : undefined,
      });
    }

    const nextCursor = payload.pagination?.cursor;
    if (typeof nextCursor !== "string" || nextCursor.length === 0) {
      cursor = undefined;
    } else if (seenCursors.has(nextCursor)) {
      throw new Error("Neon project-list pagination repeated a cursor.");
    } else {
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } while (cursor);

  return projects;
}

function currentMonthPeriod(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}
