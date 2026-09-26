import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CLI_VERSION } from "../src/version.js";

test("public distribution keeps the AnyRemote binary and standalone runtime", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.name, "@panda-ai/anyremote");
  assert.equal(manifest.version, CLI_VERSION);
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/Panda-Intelligence/anyremote-cli.git",
  });
  assert.deepEqual(manifest.workspaces, ["packages/*"]);
  assert.deepEqual(manifest.engines, { node: ">=20.9.0" });
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.deepEqual(manifest.bin, { anyremote: "dist/bin.js" });
  assert.deepEqual(manifest.files, ["dist", "README.md"]);
  assert.ok(manifest.dependencies.sharp);
  assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], undefined);
  assert.ok(manifest.devDependencies["@modelcontextprotocol/sdk"]);
  assert.match(manifest.scripts.build, /--external sharp/);
  for (const version of Object.values(manifest.dependencies)) {
    assert.doesNotMatch(version, /^(workspace:|file:|link:)/);
  }
});
