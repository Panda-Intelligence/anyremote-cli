import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { saveConfig } from "../src/config.js";

const run = promisify(execFile);
const binary = fileURLToPath(new URL("../src/bin.js", import.meta.url));

function waitForOutput(stream, text, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${text}; output was: ${output}`));
    }, timeout);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (!output.includes(text)) return;
      clearTimeout(timer);
      resolve(output);
    });
    stream.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("pair resolves defaults and explicit overrides, rejecting malformed name flags before HTTP", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-name-pair-"),
  );
  const bodies = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: { code: "TEST" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_TOKEN: "",
  };
  try {
    await run(process.execPath, [binary, "pair", "--base-url", baseUrl], {
      env,
      timeout: 5000,
    });
    assert.ok(bodies[0].name.trim());
    assert.ok(bodies[0].name.length <= 120);
    await run(
      process.execPath,
      [binary, "pair", "--base-url", baseUrl, "--name", "工作电脑 💻"],
      { env, timeout: 5000 },
    );
    assert.equal(bodies[1].name, "工作电脑 💻");
    for (const args of [
      ["--name"],
      ["--name", ""],
      ["--name", "   "],
      ["--name", "x".repeat(121)],
    ]) {
      await assert.rejects(
        run(
          process.execPath,
          [binary, "pair", "--base-url", baseUrl, ...args],
          { env, timeout: 5000 },
        ),
        (error) => error.code === 1 && error.stderr.includes("--name must"),
      );
    }
    assert.equal(bodies.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote reauthorizes a saved device without overwriting its server name", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-name-saved-"),
  );
  const enrollments = [];
  let hello;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/device/code") {
      response.end(
        JSON.stringify({
          device_code: "private-device-code",
          user_code: "PUBLIC",
          verification_uri_complete: `http://127.0.0.1:${server.address().port}/device?user_code=PUBLIC`,
          expires_in: 60,
          interval: 1,
        }),
      );
      return;
    }
    if (request.url === "/api/auth/oauth2/token") {
      response.end(
        JSON.stringify({
          access_token: "private-enrollment-token",
          token_type: "Bearer",
        }),
      );
      return;
    }
    if (request.url === "/api/devices/enroll") {
      const payload = JSON.parse(body);
      enrollments.push(payload);
      response.end(
        JSON.stringify({
          data: {
            device: { id: "saved-device", name: "用户已命名" },
            deviceToken: "rotated-device-token",
          },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.once("message", (data) => {
      hello = JSON.parse(data.toString());
      socket.close(1008, "test complete");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_TOKEN: "",
  };
  const saved = {
    baseUrl,
    device: { id: "saved-device", name: "用户已命名" },
    deviceToken: "test-device-token",
  };
  await saveConfig(saved, { env });
  try {
    await run(
      process.execPath,
      [
        binary,
        "remote",
        "--base-url",
        baseUrl,
        "--name",
        "不要覆盖",
        "--no-browser",
      ],
      { env, timeout: 5000 },
    );
    assert.equal(enrollments.length, 1);
    assert.equal(enrollments[0].existingDeviceId, saved.device.id);
    assert.equal(hello.payload.name, saved.device.name);
    assert.equal(hello.deviceId, saved.device.id);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")),
      { baseUrl },
    );
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("connect uses saved credentials without starting a new authorization", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-connect-saved-"),
  );
  let requests = 0;
  let hello;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.once("message", (data) => {
      hello = JSON.parse(data.toString());
      socket.close(1008, "test complete");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_TOKEN: "",
  };
  await saveConfig(
    {
      baseUrl,
      device: { id: "saved-device", name: "用户已命名" },
      deviceToken: "saved-device-token",
    },
    { env },
  );
  try {
    await run(process.execPath, [binary, "connect"], { env, timeout: 5000 });
    assert.equal(requests, 0);
    assert.equal(hello.deviceId, "saved-device");
    assert.equal(hello.payload.name, "用户已命名");
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("revoked remote credentials are cleared and the next remote enrolls again", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "anyremote-revoked-device-"),
  );
  const enrollments = [];
  let connections = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body
      ? request.headers["content-type"]?.includes("application/json")
        ? JSON.parse(body)
        : Object.fromEntries(new URLSearchParams(body))
      : {};
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/device/code") {
      const port = server.address().port;
      response.end(
        JSON.stringify({
          device_code: "replacement-device-code",
          user_code: "PUBLIC",
          verification_uri_complete: `http://127.0.0.1:${port}/device?user_code=PUBLIC`,
          expires_in: 60,
          interval: 1,
        }),
      );
      return;
    }
    if (request.url === "/api/auth/oauth2/token") {
      response.end(
        JSON.stringify({
          access_token: "replacement-enrollment-token",
          token_type: "Bearer",
        }),
      );
      return;
    }
    if (request.url === "/api/devices/enroll") {
      enrollments.push(payload);
      if (payload.existingDeviceId) {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            device: { id: "replacement-device", name: payload.name },
            deviceToken: "replacement-device-token",
          },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    connections += 1;
    socket.once("message", () => {
      if (connections === 1) socket.close(1008, "test revoke");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_TOKEN: "",
  };
  const saved = {
    baseUrl,
    accessToken: "keep-access-token",
    sessionCookie: "keep-session-cookie",
    device: { id: "revoked-device", name: "用户已命名" },
    deviceToken: "revoked-device-token",
    language: "zh-CN",
  };
  await saveConfig(saved, { env });
  let replacementProcess;
  try {
    const first = await run(
      process.execPath,
      [
        binary,
        "remote",
        "--base-url",
        baseUrl,
        "--name",
        "不要覆盖",
        "--no-browser",
      ],
      { env, timeout: 5000 },
    );
    assert.match(
      first.stderr,
      /Saved device credentials were cleared\. Run remote again/,
    );
    const cleared = JSON.parse(
      await readFile(path.join(directory, "config.json"), "utf8"),
    );
    assert.deepEqual(cleared, {
      baseUrl,
      accessToken: saved.accessToken,
      sessionCookie: saved.sessionCookie,
      language: saved.language,
    });

    replacementProcess = spawn(
      process.execPath,
      [binary, "remote", "--base-url", baseUrl, "--no-browser"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = await waitForOutput(
      replacementProcess.stdout,
      '"status": "approved"',
    );
    assert.match(output, /replacement-device/);
    assert.equal(enrollments.length, 3);
    assert.equal(enrollments[0].existingDeviceId, saved.device.id);
    assert.equal(Object.hasOwn(enrollments[1], "existingDeviceId"), false);
    assert.equal(Object.hasOwn(enrollments[2], "existingDeviceId"), false);
    assert.notEqual(enrollments[2].enrollmentId, undefined);
    const replacement = JSON.parse(
      await readFile(path.join(directory, "config.json"), "utf8"),
    );
    assert.equal(replacement.device.id, "replacement-device");
    assert.equal(replacement.deviceToken, "replacement-device-token");
    assert.equal(replacement.baseUrl, baseUrl);
    assert.equal(replacement.accessToken, saved.accessToken);
    assert.equal(replacement.sessionCookie, saved.sessionCookie);
  } finally {
    replacementProcess?.kill("SIGTERM");
    if (replacementProcess && replacementProcess.exitCode === null)
      await once(replacementProcess, "exit");
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
