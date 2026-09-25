import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { resolveBaseUrl } from "../src/bin.js";

const binary = fileURLToPath(new URL("../src/bin.js", import.meta.url));
const run = promisify(execFile);

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function waitForRemoteStart(child, events, isReady, getOutput) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error(`CLI did not start the device agent.\n${getOutput()}`));
    }, 8000);
    const check = () => {
      if (isReady()) finish();
    };
    const onClose = (code, signal) => {
      finish(
        new Error(
          `CLI exited before starting the device agent (${code ?? signal}).\n${getOutput()}`,
        ),
      );
    };
    const onError = (error) => finish(error);
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout.off("data", check);
      events.off("upgrade", check);
      events.off("ready", check);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.on("data", check);
    events.on("upgrade", check);
    events.on("ready", check);
    child.once("close", onClose);
    child.once("error", onError);
    check();
  });
}

function waitForClose(child, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const onClose = (code, signal) => {
      clearTimeout(timeout);
      resolve([code, signal]);
    };
    child.once("close", onClose);
  });
}

test("base URL resolution preserves overrides and defaults to production", () => {
  assert.equal(
    resolveBaseUrl({
      explicit: "https://explicit.example.test",
      saved: "https://saved.example.test",
      environment: "https://environment.example.test",
    }),
    "https://explicit.example.test",
  );
  assert.equal(
    resolveBaseUrl({
      saved: "https://saved.example.test",
      environment: "https://environment.example.test",
    }),
    "https://saved.example.test",
  );
  assert.equal(
    resolveBaseUrl({ environment: "https://environment.example.test" }),
    "https://environment.example.test",
  );
  assert.equal(resolveBaseUrl(), "https://anyremote.dev");
});

test("--help and -h continue to show help without starting remote", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const { stdout } = await run(process.execPath, [binary, ...args], {
      timeout: 5000,
    });
    assert.match(stdout, /Quick connect: anyremote \[--base-url/);
    assert.match(stdout, /Usage: anyremote \[<command>\]/);
  }
});

test("a missing subcommand defaults to remote and explicit remote remains supported", async (t) => {
  const requests = [];
  const upgrades = [];
  const handshakes = [];
  const upgradeEvents = new EventEmitter();
  let origin;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      if (request.url === "/api/auth/device/code")
        return jsonResponse(response, 200, {
          device_code: "private-device-code",
          user_code: "PUBLIC-CODE",
          verification_uri_complete: `${origin}/device?user_code=PUBLIC-CODE`,
          expires_in: 60,
          interval: 1,
        });
      if (request.url === "/api/auth/oauth2/token")
        return jsonResponse(response, 200, {
          access_token: "enrollment-token",
          token_type: "Bearer",
        });
      if (request.url === "/api/devices/enroll")
        return jsonResponse(response, 200, {
          data: {
            device: { id: "device-1", name: "Test computer" },
            deviceToken: "device-token",
          },
        });
      return jsonResponse(response, 404, {
        error: { code: "NOT_FOUND", message: "Not found" },
      });
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const envelope = JSON.parse(raw.toString());
      if (envelope.type !== "hello") return;
      handshakes.push(envelope);
      socket.send(JSON.stringify({ ...envelope, payload: { accepted: true } }));
      upgradeEvents.emit("ready");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    upgrades.push(request.url);
    upgradeEvents.emit("upgrade");
    webSocketServer.handleUpgrade(request, socket, head, (connection) => {
      webSocketServer.emit("connection", connection, request);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const [label, args] of [
      ["flags without a command", ["--base-url", origin, "--no-browser"]],
      [
        "explicit remote command",
        ["remote", "--base-url", origin, "--no-browser"],
      ],
    ]) {
      await t.test(label, async () => {
        const configDirectory = await mkdtemp(
          path.join(os.tmpdir(), "anyremote-default-remote-"),
        );
        const requestStart = requests.length;
        const upgradeStart = upgrades.length;
        const child = spawn(process.execPath, [binary, ...args], {
          env: {
            ...process.env,
            ANYREMOTE_CONFIG_DIR: configDirectory,
            ANYREMOTE_URL: "",
            ANYREMOTE_TOKEN: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });

        try {
          await waitForRemoteStart(
            child,
            upgradeEvents,
            () =>
              stdout.includes('"status": "approved"') &&
              upgrades.length > upgradeStart &&
              handshakes.length > upgradeStart,
            () => `${stdout}\n${stderr}`,
          );
          assert.equal(child.exitCode, null);
          assert.ok(
            stdout.includes(`Open ${origin}/device?user_code=PUBLIC-CODE`),
          );
          assert.ok(
            upgrades
              .slice(upgradeStart)
              .some((url) => url.endsWith("/api/devices/device-1/connect")),
          );
          assert.ok(
            handshakes
              .slice(upgradeStart)
              .every((envelope) => envelope.payload.agentVersion),
          );

          const caseRequests = requests.slice(requestStart);
          const authorization = caseRequests.find(
            (request) => request.path === "/api/auth/device/code",
          );
          assert.equal(
            JSON.parse(authorization.body).resource,
            `${origin}/api/devices/enroll`,
          );
          const enrollment = caseRequests.find(
            (request) => request.path === "/api/devices/enroll",
          );
          assert.equal(enrollment.authorization, "Bearer enrollment-token");

          const closed = waitForClose(
            child,
            5000,
            `CLI did not stop after SIGTERM.\n${stdout}\n${stderr}`,
          );
          child.kill("SIGTERM");
          const [code, signal] = await closed;
          assert.equal(code, 0);
          assert.equal(signal, null);

          const saved = JSON.parse(
            await readFile(path.join(configDirectory, "config.json"), "utf8"),
          );
          assert.equal(saved.baseUrl, origin);
          assert.equal(saved.device.id, "device-1");
          assert.equal(saved.deviceToken, "device-token");
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await waitForClose(child, 5000, "CLI process did not close.").catch(
              () => undefined,
            );
          }
          await rm(configDirectory, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await new Promise((resolve) => webSocketServer.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
