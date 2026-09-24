import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { saveConfig } from "../src/config.js";

const run = promisify(execFile);
const binary = fileURLToPath(new URL("../src/bin.js", import.meta.url));

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readConfig(directory) {
  return JSON.parse(
    await readFile(path.join(directory, "config.json"), "utf8"),
  );
}

test("retired MCP bridge and setup commands are unavailable", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-retired-commands-"),
  );
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_URL: "",
    ANYREMOTE_TOKEN: "",
  };
  try {
    const { stdout: help } = await run(process.execPath, [binary, "help"], {
      env,
    });
    assert.match(help, /remote\s+Authorize and connect/);
    assert.doesNotMatch(help, /setup codex|setup claude-code|stdio MCP bridge/);
    for (const command of ["mcp", "setup"]) {
      await assert.rejects(
        run(
          process.execPath,
          [binary, command, "--base-url", "https://remote.example.test"],
          { env },
        ),
        (error) =>
          error.code === 1 &&
          error.stderr.includes(`Unknown command: ${command}`),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout signs out the account and preserves device credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anyremote-logout-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
    });
    if (request.method === "POST" && request.url === "/api/auth/sign-out")
      return jsonResponse(response, 200, { data: { success: true } });
    return jsonResponse(response, 404, {
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_URL: "",
    ANYREMOTE_TOKEN: "",
  };
  const saved = {
    baseUrl,
    accessToken: "account-token",
    sessionCookie: "better-auth.session_token=session",
    device: { id: "device-1", name: "My Mac" },
    deviceToken: "device-token",
    language: "zh-CN",
  };
  await saveConfig(saved, { env });
  try {
    const result = await run(process.execPath, [binary, "logout"], {
      env,
      timeout: 5000,
    });
    assert.match(result.stdout, /"loggedOut": true/);
    assert.deepEqual(requests, [
      {
        method: "POST",
        path: "/api/auth/sign-out",
        authorization: "Bearer account-token",
        cookie: "better-auth.session_token=session",
        origin: baseUrl,
      },
    ]);
    assert.deepEqual(await readConfig(directory), {
      baseUrl,
      device: saved.device,
      deviceToken: saved.deviceToken,
      language: saved.language,
    });

    const repeated = await run(process.execPath, [binary, "logout"], {
      env,
      timeout: 5000,
    });
    assert.match(repeated.stdout, /"alreadyLoggedOut": true/);
    assert.equal(requests.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout clears stale credentials on 401/404 but retains them on server errors", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-logout-errors-"),
  );
  let status = 401;
  const server = createServer((_request, response) =>
    jsonResponse(response, status, {
      error: { code: "UNAUTHENTICATED", message: "Session is invalid" },
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_URL: "",
    ANYREMOTE_TOKEN: "",
  };
  const saved = {
    baseUrl,
    accessToken: "stale-token",
    sessionCookie: "stale-cookie",
    device: { id: "device-1" },
  };
  try {
    await saveConfig(saved, { env });
    const stale = await run(process.execPath, [binary, "logout"], {
      env,
      timeout: 5000,
    });
    assert.match(stale.stdout, /"alreadyLoggedOut": true/);
    assert.deepEqual(await readConfig(directory), {
      baseUrl,
      device: saved.device,
    });

    await saveConfig(saved, { env });
    status = 404;
    const missing = await run(process.execPath, [binary, "logout"], {
      env,
      timeout: 5000,
    });
    assert.match(missing.stdout, /"alreadyLoggedOut": true/);
    assert.deepEqual(await readConfig(directory), {
      baseUrl,
      device: saved.device,
    });

    await saveConfig(saved, { env });
    status = 500;
    await assert.rejects(
      run(process.execPath, [binary, "logout"], { env, timeout: 5000 }),
      (error) => error.code === 1 && /Session is invalid/.test(error.stderr),
    );
    assert.deepEqual(await readConfig(directory), saved);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("revoke clears the saved device, keeps account credentials, and supports disconnect alias", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anyremote-revoke-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    if (request.method === "DELETE")
      return jsonResponse(response, 200, {
        data: { revoked: true, deviceId: request.url.split("/").pop() },
      });
    return jsonResponse(response, 404, {
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_URL: "",
    ANYREMOTE_TOKEN: "",
  };
  const saved = {
    baseUrl,
    accessToken: "account-token",
    sessionCookie: "session-cookie",
    device: { id: "device-1", name: "My Mac" },
    deviceToken: "device-token",
    language: "en",
  };
  await saveConfig(saved, { env });
  try {
    const revoked = await run(process.execPath, [binary, "revoke"], {
      env,
      timeout: 5000,
    });
    assert.match(revoked.stdout, /"revoked": true/);
    assert.deepEqual(await readConfig(directory), {
      baseUrl,
      accessToken: saved.accessToken,
      sessionCookie: saved.sessionCookie,
      language: saved.language,
    });

    const alias = await run(
      process.execPath,
      [binary, "disconnect", "--device-id", "device-1"],
      { env, timeout: 5000 },
    );
    assert.match(alias.stdout, /"revoked": true/);
    assert.deepEqual(requests, [
      {
        method: "DELETE",
        path: "/api/devices/device-1",
        authorization: "Bearer account-token",
      },
      {
        method: "DELETE",
        path: "/api/devices/device-1",
        authorization: "Bearer account-token",
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("revoke is a local no-op without a device and preserves config on 404", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-revoke-noop-"),
  );
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    return jsonResponse(response, 404, {
      error: { code: "NOT_FOUND", message: "Device not found" },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_URL: "",
    ANYREMOTE_TOKEN: "",
  };
  try {
    await saveConfig(
      { baseUrl, deviceToken: "stale-token", language: "fr" },
      { env },
    );
    const noop = await run(process.execPath, [binary, "revoke"], {
      env,
      timeout: 5000,
    });
    assert.match(noop.stdout, /"alreadyRevoked": true/);
    assert.deepEqual(await readConfig(directory), { baseUrl, language: "fr" });
    assert.equal(requests, 0);

    const saved = {
      baseUrl,
      accessToken: "account-token",
      device: { id: "saved-device" },
      deviceToken: "device-token",
    };
    await saveConfig(saved, { env });
    await assert.rejects(
      run(process.execPath, [binary, "revoke", "--device-id", "unknown"], {
        env,
        timeout: 5000,
      }),
      (error) => error.code === 1 && /Device not found/.test(error.stderr),
    );
    assert.deepEqual(await readConfig(directory), saved);
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
