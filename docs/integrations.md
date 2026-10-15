# Integration recipes

## Read the server usage endpoint

The Fetch handler serves `GET /usage?provider=supabase` or
`GET /usage?provider=neon`. It adds `private, no-store` to successful
responses, and only returns CORS headers for explicitly allowed origins.

```ts
const response = await fetch("/usage?provider=neon", {
  credentials: "include",
});
if (!response.ok) {
  throw new Error(`Could not load usage (${response.status})`);
}

const snapshot = await response.json();
```

Add user authentication/authorization to the endpoint in your deployment
adapter. CORS is not an auth mechanism.

## Create a provider source on a server

```ts
import { createUsageHandler } from
  "../../packages/usage-limiter-server/src/index.ts";
import { createProviderUsageSource } from
  "../../packages/usage-limiter-server/src/provider-source.ts";

const source = createProviderUsageSource({
  supabase: { accessToken: requiredEnv("SUPABASE_ACCESS_TOKEN") },
  neon: {
    apiKey: requiredEnv("NEON_API_KEY"),
    organizationId: requiredEnv("NEON_ORGANIZATION_ID"),
  },
});

export const fetch = createUsageHandler({
  source,
  allowedOrigins: ["https://app.example.com"],
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
```

For Cloudflare Workers or another edge runtime, replace `process.env` with
runtime secret bindings. Never put Management API tokens into `VITE_*`,
`NEXT_PUBLIC_*`, Flutter assets, or browser-visible config.

## Protect a TypeScript operation

```ts
import {
  createUsageMetric,
  FREE_LIMITS,
  withUsageGuard,
} from "@usage-limit-warnings/typescript";

const egressLimit = FREE_LIMITS.neon.find((item) => item.id === "egress");
if (!egressLimit) throw new Error("Neon egress limit is not configured.");

const egress = createUsageMetric(egressLimit, 4.7, undefined, "project-ref");
await withUsageGuard(egress, () => uploadLargeExport());
```

Prefer a live usage sample from the trusted server rather than locally
constructing usage values in production.

## Protect a Dart operation

```dart
final limit = freeLimits[UsageProvider.neon]!
    .firstWhere((item) => item.id == UsageMetricId.egress);

final egress = UsageMetric(
  id: limit.id,
  label: limit.label,
  limit: limit.limit,
  unit: limit.unit,
  scope: limit.scope,
  period: limit.period,
  usage: serverSnapshot.egressUsageGb,
  available: serverSnapshot.egressAvailable,
  unavailableReason: serverSnapshot.egressUnavailableReason,
  scopeId: serverSnapshot.projectId,
);

await withUsageGuard(egress, () => uploadLargeExport());
```

An unavailable measurement does not trip the guard. For critical operations,
explicitly reject `!egress.available` before entering it.

## Polling and warning delivery

Fetch at a reasonable interval appropriate for provider metric freshness and
API rate limits. Persist threshold notification state by
`provider + scopeId + metricId + periodStart` if notifications must not repeat
across reloads. The React hook deduplicates only for its mounted component
lifetime; it is not a durable notification store.

## Supabase status and recovery UI

Use lifecycle status to tell users what action is available; do not claim a
paused project will resume automatically. The included project URL points to
the Supabase Dashboard. The project owner should resume it there.

## Neon cold-start UI

Show a loading state for the first connection/query and retain bounded retry
only for recognized wake-up errors. A query retry may be unsafe for
non-idempotent operations. Recreate session-scoped features on a newly
established connection.
