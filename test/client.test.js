import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "../src/client.js";

test("pairing defaults to the package version and preserves overrides", async () => {
  const bodies = [];
  const client = new ApiClient({
    baseUrl: "https://app.example.test",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ data: { id: "pairing-1" } });
    },
  });

  await client.createPairing({ name: "My computer" });
  await client.createPairing({
    name: "My computer",
    agentVersion: "9.8.7-custom",
  });

  assert.deepEqual(
    bodies.map(({ agentVersion }) => agentVersion),
    ["0.2.1", "9.8.7-custom"],
  );
});
