# Provider lifecycle and recovery

The same idle symptom has different provider behavior. Supabase Free may pause
the whole project; Neon idles the stateless PostgreSQL compute and wakes it on
the next connection.

## Lifecycle comparison

```mermaid
sequenceDiagram
  participant App
  participant Supabase
  participant Neon

  Note over Supabase: About 7 days of insufficient DB activity
  Supabase->>Supabase: Pause entire Free project
  App->>Supabase: API / Auth request
  Supabase-->>App: Unavailable until manual resume
  Note over App,Supabase: Owner resumes from Supabase Dashboard

  Note over Neon: 5 minutes without active queries
  Neon->>Neon: Suspend compute; storage remains
  App->>Neon: New connection
  Neon->>Neon: Automatically activate compute
  Neon-->>App: Connection succeeds; first query may be slower
```

| Behavior | Supabase Free | Neon Free |
| --- | --- | --- |
| Idle/pause trigger | Low user database activity over approximately 7 days | No active queries for 5 minutes |
| What stops | The entire project may pause | PostgreSQL compute only |
| Data | Project can be resumed with its data/configuration during the restore window | Storage remains while compute is idle |
| Request after idle | Does not automatically resume a paused project | New connection wakes compute automatically |
| Typical recovery | Manual resume in Supabase Dashboard; docs state a 1-year restore window | Usually a few hundred milliseconds; longer after extended idle is possible |
| Session state | Project session disruption while paused | Temp tables, prepared statements, advisory locks, and `LISTEN`/`NOTIFY` subscriptions are lost when compute suspends |

## Supabase: detect and guide manual resume

The built-in source returns `snapshot.projects` entries with `state`, raw
`status`, explanatory `message`, and `resumeUrl` when paused. Current mappings:

| Management API status | SDK lifecycle state |
| --- | --- |
| `ACTIVE_HEALTHY` | `active` |
| `ACTIVE_UNHEALTHY` | `degraded` |
| `INACTIVE`, `PAUSED` | `paused` |
| Other or missing status | `unknown` |

```ts
import {
  assertSupabaseProjectReady,
  SupabaseProjectPausedError,
} from "@usage-limit-warnings/typescript";

const project = snapshot.projects?.find((item) => item.projectId === projectRef);
if (!project) throw new Error("Project lifecycle is not available.");

try {
  assertSupabaseProjectReady(project);
} catch (error) {
  if (error instanceof SupabaseProjectPausedError) {
    return { status: 503, resumeUrl: error.project.resumeUrl };
  }
  throw error;
}
```

`assertSupabaseProjectReady` also rejects non-healthy and unknown states with
`SupabaseProjectNotReadyError`; it does not call a resume endpoint or attempt
to wake the project. Use a user-facing message directing the owner to the
Dashboard.

## Neon: retry the initial wake safely

The retry helper recognizes common PostgreSQL startup error `57P03` and
compute-startup messages. Defaults are three retries, starting at 200 ms, with
exponential backoff capped at 1 second. Customize these values only when the
application's request deadline allows it.

```ts
import { withNeonWakeRetry } from "@usage-limit-warnings/typescript";

const connection = await withNeonWakeRetry(
  () => pool.connect(), // retry connection establishment, not a write
);
```

Release a connection in `finally` as usual. After connection succeeds, retry a
query only when its failure is known to be safe/idempotent. An ambiguous
network failure after a write may mean the server committed it; replay could
duplicate side effects.

### Do not keep compute awake with pings

Periodic keep-alive queries defeat scale-to-zero and consume compute allowance.
Let Neon sleep; show loading/retry behavior on the first real request instead.
Create any session-only objects again after reconnecting.

## Sources

- [Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Neon compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle)
