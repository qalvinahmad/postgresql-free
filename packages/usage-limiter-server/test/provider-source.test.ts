import assert from "node:assert/strict";
import test from "node:test";
import { createProviderUsageSource } from "../src/provider-source.ts";

test("loads active Supabase project count and marks other metrics unavailable", async () => {
  let requestedUrl = "";
  const source = createProviderUsageSource({
    supabase: { accessToken: "server-token" },
    now: () => new Date("2026-10-15T00:00:00.000Z"),
    fetch: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer server-token");
      return Response.json([
        { ref: "active-project", name: "Active project", status: "ACTIVE_HEALTHY" },
        { ref: "paused-project", name: "Paused project", status: "INACTIVE" },
        { ref: "unknown-project", name: "Unknown project", status: "UNKNOWN" },
        { ref: "unhealthy-project", name: "Unhealthy project", status: "ACTIVE_UNHEALTHY" },
      ]);
    },
  });

  const snapshot = await source.load("supabase");
  const projects = snapshot.metrics.find((metric) => metric.id === "projects");
  const database = snapshot.metrics.find((metric) => metric.id === "database");

  assert.equal(requestedUrl, "https://api.supabase.com/v1/projects");
  assert.equal(projects?.usage, 2);
  assert.equal(projects?.available, true);
  assert.equal(snapshot.projects?.length, 4);
  assert.equal(
    snapshot.projects?.find((project) => project.projectId === "paused-project")
      ?.state,
    "paused",
  );
  assert.equal(
    snapshot.projects?.find((project) => project.projectId === "paused-project")
      ?.resumeUrl,
    "https://supabase.com/dashboard/project/paused-project",
  );
  assert.equal(
    snapshot.projects?.find((project) => project.projectId === "unknown-project")
      ?.state,
    "unknown",
  );
  assert.equal(
    snapshot.projects?.find((project) => project.projectId === "unhealthy-project")
      ?.state,
    "degraded",
  );
  assert.equal(database?.usage, null);
  assert.equal(database?.available, false);
  assert.equal(snapshot.periodStart, "2026-10-01T00:00:00.000Z");
  assert.equal(snapshot.periodEnd, "2026-11-01T00:00:00.000Z");
});

test("paginates Neon projects without requesting usage history", async () => {
  const requestedUrls: string[] = [];
  const source = createProviderUsageSource({
    neon: { apiKey: "server-token", organizationId: "org-id" },
    fetch: async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url.toString());
      if (/\/projects\/project-\d+$/.test(url.pathname)) {
        return Response.json({
          project: {
            data_transfer_bytes: 5_000_000_000,
            consumption_period_start: "2026-10-01T00:00:00.000Z",
            consumption_period_end: "2026-11-01T00:00:00.000Z",
          },
        });
      }
      if (!url.searchParams.has("cursor")) {
        return Response.json({
          projects: [{ id: "project-1" }],
          pagination: { cursor: "next-page" },
        });
      }
      return Response.json({ projects: [{ id: "project-2" }] });
    },
  });

  const snapshot = await source.load("neon");
  const projects = snapshot.metrics.find((metric) => metric.id === "projects");
  const compute = snapshot.metrics.find((metric) => metric.id === "compute");
  const egress = snapshot.metrics.find(
    (metric) => metric.id === "egress" && metric.scopeId === "project-1",
  );

  assert.equal(requestedUrls.length, 4);
  assert.equal(
    requestedUrls.filter((url) => new URL(url).pathname.endsWith("/projects"))
      .length,
    2,
  );
  assert.ok(requestedUrls[1].includes("cursor=next-page"));
  assert.equal(projects?.usage, 2);
  assert.equal(compute?.usage, null);
  assert.equal(compute?.available, false);
  assert.equal(egress?.usage, 5);
  assert.equal(egress?.available, true);
  assert.equal(snapshot.periodStart, "2026-10-01T00:00:00.000Z");
  assert.equal(snapshot.periodEnd, "2026-11-01T00:00:00.000Z");
});

test("fails explicitly when provider credentials are missing", async () => {
  const source = createProviderUsageSource({});
  await assert.rejects(source.load("neon"), /NEON_API_KEY/);
});
