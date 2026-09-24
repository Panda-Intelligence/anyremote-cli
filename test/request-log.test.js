import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createRequestLogger, formatRequestLog } from "../src/request-log.js";

test("request logger emits only an allowlisted stderr record", () => {
  const lines = [];
  const logger = createRequestLogger({
    write: (line) => lines.push(line),
    now: () => Date.parse("2026-09-23T00:00:00.000Z"),
  });
  logger({
    requestId: "request-1",
    tool: "files.read",
    status: "success",
    elapsedMs: 12.6,
    arguments: {
      path: "/Users/private/secret.txt",
      content: "private file contents",
      token: "bearer-secret",
    },
    result: {
      output: "private command output",
      environment: { API_KEY: "secret" },
    },
    deviceToken: "device-secret",
    authorizationCode: "auth-secret",
  });

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.deepEqual(record, {
    timestamp: "2026-09-23T00:00:00.000Z",
    requestId: "request-1",
    tool: "files.read",
    status: "success",
    elapsedMs: 13,
  });
  assert.doesNotMatch(
    lines[0],
    /secret\.txt|private file|bearer-secret|command output|API_KEY|device-secret|auth-secret/,
  );
});

test("request log normalizes malformed metadata without serializing nested data", () => {
  assert.deepEqual(
    formatRequestLog(
      {
        requestId: { value: "private" },
        tool: "x".repeat(201),
        status: "unexpected",
        elapsedMs: Number.NaN,
        nested: { path: "/private" },
      },
      { now: () => 0 },
    ),
    {
      timestamp: "1970-01-01T00:00:00.000Z",
      requestId: "unknown",
      tool: "unknown",
      status: "error",
      elapsedMs: 0,
    },
  );
});

test("request logger keeps diagnostics off stdout", async () => {
  const moduleUrl = new URL("../src/request-log.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRequestLogger } from ${JSON.stringify(moduleUrl)}; createRequestLogger()({ requestId: "r1", tool: "files.read", status: "success", elapsedMs: 1 });`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [exitCode] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve([code]));
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /"requestId":"r1"/);
});
