import { createUsageHandler } from
  "../../packages/usage-limiter-server/src/index.ts";
import { createProviderUsageSource } from
  "../../packages/usage-limiter-server/src/provider-source.ts";

interface ServerEnvironment {
  SUPABASE_ACCESS_TOKEN: string;
  NEON_API_KEY: string;
  NEON_ORGANIZATION_ID: string;
}

export function createFetchHandler(env: ServerEnvironment) {
  const source = createProviderUsageSource({
    supabase: { accessToken: env.SUPABASE_ACCESS_TOKEN },
    neon: {
      apiKey: env.NEON_API_KEY,
      organizationId: env.NEON_ORGANIZATION_ID,
    },
  });

  return createUsageHandler({
    source,
    allowedOrigins: ["https://app.example.com"],
  });
}
