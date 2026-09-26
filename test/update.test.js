import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateBunxCliIfNeeded } from "../src/update.js";

const packageName = "@panda-ai/anyremote";

async function createCachedCli(t) {
  const cacheDirectory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-update-test-"),
  );
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  const cliPath = path.join(
    cacheDirectory,
    "@panda-ai",
    "anyremote@0.2.4@@@1",
    "dist",
    "bin.js",
  );
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "");
  return { cacheDirectory, cliPath: realpathSync(cliPath) };
}

function responseFor(version) {
  return new Response(JSON.stringify({ name: packageName, version }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function closedChild(code) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", code));
  return child;
}

test("Bunx cache keeps the current package when latest is unchanged", async (t) => {
  const { cacheDirectory, cliPath } = await createCachedCli(t);
  let spawnCount = 0;
  const didUpdate = await updateBunxCliIfNeeded({
    argv: [],
    cliPath,
    cliVersion: "0.2.4",
    packageName,
    env: { BUN_INSTALL_CACHE_DIR: cacheDirectory },
    fetchImpl: async () => responseFor("0.2.4"),
    spawnImpl: () => {
      spawnCount += 1;
      return closedChild(0);
    },
    stderr: { write: () => undefined },
  });

  assert.equal(didUpdate, false);
  assert.equal(spawnCount, 0);
});

test("Bunx cache launches the exact latest package with original arguments", async (t) => {
  const { cacheDirectory, cliPath } = await createCachedCli(t);
  const previousExitCode = process.exitCode;
  const spawnCalls = [];
  process.exitCode = undefined;
  try {
    const didUpdate = await updateBunxCliIfNeeded({
      argv: ["--help"],
      cliPath,
      cliVersion: "0.2.4",
      packageName,
      env: { BUN_INSTALL_CACHE_DIR: cacheDirectory },
      fetchImpl: async () => responseFor("0.2.5"),
      spawnImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return closedChild(0);
      },
      stderr: { write: () => undefined },
    });

    assert.equal(didUpdate, true);
    assert.equal(process.exitCode, 0);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "bun");
    assert.deepEqual(spawnCalls[0].args, [
      "x",
      "--silent",
      "@panda-ai/anyremote@0.2.5",
      "--help",
    ]);
    assert.equal(spawnCalls[0].options.stdio, "inherit");
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("registry failures continue with the cached CLI", async (t) => {
  const { cacheDirectory, cliPath } = await createCachedCli(t);
  const stderr = [];
  let spawnCount = 0;
  const didUpdate = await updateBunxCliIfNeeded({
    argv: [],
    cliPath,
    cliVersion: "0.2.4",
    packageName,
    env: { BUN_INSTALL_CACHE_DIR: cacheDirectory },
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
    spawnImpl: () => {
      spawnCount += 1;
      return closedChild(0);
    },
    stderr: { write: (message) => stderr.push(message) },
  });

  assert.equal(didUpdate, false);
  assert.equal(spawnCount, 0);
  assert.match(stderr.join(""), /Could not check for AnyRemote CLI updates/);
});

test("failed latest launch returns a nonzero exit code", async (t) => {
  const { cacheDirectory, cliPath } = await createCachedCli(t);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const didUpdate = await updateBunxCliIfNeeded({
      argv: [],
      cliPath,
      cliVersion: "0.2.4",
      packageName,
      env: { BUN_INSTALL_CACHE_DIR: cacheDirectory },
      fetchImpl: async () => responseFor("0.2.5"),
      spawnImpl: () => closedChild(1),
      stderr: { write: () => undefined },
    });

    assert.equal(didUpdate, true);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
