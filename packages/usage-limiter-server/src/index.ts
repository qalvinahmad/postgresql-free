import type { Provider, UsageSnapshot } from "@usage-limit-warnings/typescript";

export interface UsageSource {
  load(provider: Provider): Promise<UsageSnapshot>;
}

export interface UsageHandlerOptions {
  source: UsageSource;
  allowedOrigins?: readonly string[];
}

/**
 * Framework-neutral Fetch handler. Keep provider credentials inside the
 * server-side UsageSource; never forward them to browser or mobile clients.
 */
export function createUsageHandler({
  source,
  allowedOrigins = [],
}: UsageHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      if (origin && !allowedOrigins.includes(origin)) {
        return new Response("Origin is not allowed.", { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowedOrigins),
      });
    }

    if (request.method !== "GET" || url.pathname !== "/usage") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    if (origin && !allowedOrigins.includes(origin)) {
      return Response.json({ error: "Origin is not allowed." }, { status: 403 });
    }

    const provider = url.searchParams.get("provider");
    if (provider !== "supabase" && provider !== "neon") {
      return Response.json(
        { error: "provider must be supabase or neon." },
        { status: 400, headers: corsHeaders(origin, allowedOrigins) },
      );
    }

    try {
      const snapshot = await source.load(provider);
      return Response.json(snapshot, {
        headers: {
          ...corsHeaders(origin, allowedOrigins),
          "cache-control": "private, no-store",
        },
      });
    } catch (error) {
      console.error("Usage source failed.", error);
      return Response.json(
        { error: "Usage data could not be loaded." },
        { status: 502, headers: corsHeaders(origin, allowedOrigins) },
      );
    }
  };
}

function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}
