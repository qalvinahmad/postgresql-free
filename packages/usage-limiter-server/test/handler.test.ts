import assert from "node:assert/strict";
import test from "node:test";
import { createUsageHandler } from "../src/index.ts";

test("serves normalized usage with private no-store headers and CORS allowlist", async () => {
  const handler = createUsageHandler({
    allowedOrigins: ["https://app.example"],
    source: {
      load: async (provider) => ({
        provider,
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-11-01T00:00:00.000Z",
        metrics: [],
      }),
    },
  });

  const response = await handler(
    new Request("https://api.example/usage?provider=neon", {
      headers: { origin: "https://app.example" },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  assert.equal((await response.json()).provider, "neon");
});

test("rejects unsupported providers and untrusted origins", async () => {
  const handler = createUsageHandler({
    allowedOrigins: ["https://app.example"],
    source: { load: async () => { throw new Error("must not be called"); } },
  });

  const invalidProvider = await handler(
    new Request("https://api.example/usage?provider=mysql"),
  );
  const untrustedOrigin = await handler(
    new Request("https://api.example/usage?provider=neon", {
      headers: { origin: "https://evil.example" },
    }),
  );

  assert.equal(invalidProvider.status, 400);
  assert.equal(untrustedOrigin.status, 403);
});
