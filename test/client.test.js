import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "../src/client.js";
import { CLI_VERSION } from "../src/version.js";

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
    [CLI_VERSION, "9.8.7-custom"],
  );
});
