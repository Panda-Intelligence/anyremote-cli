import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { saveConfig } from "../src/config.js";

const binary = fileURLToPath(new URL("../src/bin.js", import.meta.url));
const savedToken = "private-saved-device-token";
const enrolledToken = "private-enrolled-device-token";
const enrollmentToken = "private-enrollment-token";

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function until(predicate, message, run) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (run?.result) throw new Error(`${message}\nCLI exited: ${run.output()}`);
    await delay(10);
  }
  throw new Error(message + (run ? `\n${run.output()}` : ""));
}

async function finish(run, signal) {
  if (!run.result && signal) run.child.kill(signal);
  await until(() => run.result, "CLI did not exit", undefined);
  return run.result;
}

function noSecrets(run) {
  for (const value of [
    savedToken,
    enrolledToken,
    enrollmentToken,
    "private-account-token",
    "private-session-cookie",
    "private-device-code",
  ]) {
    assert.equal(
      run.output().includes(value),
      false,
      `Secret leaked: ${value}`,
    );
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anyremote-resume-"));
  const state = {
    requests: [],
    upgrades: [],
    hellos: [],
    runs: [],
    pending: false,
    enrollmentStatus: 200,
    loginStatus: 200,
    onUpgrade: undefined,
    onHello: undefined,
  };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = request.headers["content-type"]?.includes("application/json")
      ? JSON.parse(raw || "{}")
      : Object.fromEntries(new URLSearchParams(raw));
    state.requests.push({
      path: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      body,
    });
    if (request.url === "/api/auth/device/code")
      return respond(response, 200, {
        device_code: "private-device-code",
        user_code: "TEST-CODE",
        verification_uri_complete: `${state.origin}/device?user_code=TEST-CODE`,
        expires_in: 60,
        interval: 1,
      });
    if (request.url === "/api/auth/oauth2/token")
      return state.pending
        ? respond(response, 400, { error: "authorization_pending" })
        : respond(response, 200, {
            access_token: enrollmentToken,
            token_type: "Bearer",
          });
    if (request.url === "/api/devices/enroll")
      return state.enrollmentStatus === 200
        ? respond(response, 200, {
            data: {
              device: {
                id: body.existingDeviceId || "saved-device",
                name: "Dashboard name",
              },
              deviceToken: enrolledToken,
            },
          })
        : respond(response, state.enrollmentStatus, {
            error: "enrollment_failed",
          });
    if (request.url === "/api/auth/sign-in/email") {
      if (state.loginStatus !== 200)
        return respond(response, state.loginStatus, {
          error: { code: "INVALID_CREDENTIALS", message: "Login failed" },
        });
      response.setHeader(
        "set-cookie",
        "better-auth.session_token=new-session; Path=/; HttpOnly",
      );
      response.setHeader("set-auth-token", "new-account-token");
      return respond(response, 200, { user: { id: "test-user" } });
    }
    return respond(response, 404, { error: "not_found" });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    state.upgrades.push({
      path: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    if (state.onUpgrade?.(request, socket, state.upgrades.length)) return;
    sockets.handleUpgrade(request, socket, head, (connection) => {
      sockets.emit("connection", connection);
    });
  });
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const envelope = JSON.parse(raw.toString());
      if (envelope.type !== "hello") return;
      state.hellos.push(envelope);
      if (state.onHello?.(socket, envelope, state.hellos.length)) return;
      socket.send(JSON.stringify({ ...envelope, payload: { accepted: true } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.sockets = sockets;
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.env = {
    ...process.env,
    ANYREMOTE_CONFIG_DIR: directory,
    ANYREMOTE_URL: "",
    ANYREMOTE_TOKEN: "",
  };
  state.saved = (overrides = {}) => ({
    baseUrl: state.origin,
    device: { id: "saved-device", name: "Dashboard name" },
    deviceToken: savedToken,
    accessToken: "private-account-token",
    sessionCookie: "private-session-cookie",
    language: "fr",
    serialAllow: [],
    ...overrides,
  });
  state.save = (config) => saveConfig(config, { env: state.env });
  state.read = async () =>
    JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
  state.count = (route) =>
    state.requests.filter((request) => request.path === route).length;
  state.start = (args = ["remote"], baseUrl = state.origin) => {
    const child = spawn(
      process.execPath,
      [binary, ...args, "--base-url", baseUrl, "--no-browser"],
      { env: state.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const run = { child, stdout: "", stderr: "", result: null };
    run.output = () => `${run.stdout}\n${run.stderr}`;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      run.stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      run.stderr += chunk;
    });
    child.once("error", (error) => {
      run.stderr += error.message;
      run.result = { code: null, signal: null, error };
    });
    child.once("close", (code, signal) => {
      run.result = { code, signal };
    });
    state.runs.push(run);
    return run;
  };
  state.connected = (run) =>
    until(() => /"deviceId"\s*:/.test(run.stdout), "CLI did not connect", run);
  t.after(async () => {
    for (const run of state.runs) {
      if (!run.result) {
        run.child.kill("SIGTERM");
        try {
          await finish(run);
        } catch {
          run.child.kill("SIGKILL");
          await finish(run);
        }
      }
    }
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return state;
}

test("a new CLI process restores the authorized device for default and explicit remote", async (t) => {
  const f = await fixture(t);
  const first = f.start([]);
  await f.connected(first);
  assert.deepEqual(await finish(first, "SIGTERM"), { code: 0, signal: null });
  const enrolled = await f.read();
  assert.equal(enrolled.deviceToken, enrolledToken);
  assert.equal(enrolled.accessToken, undefined);
  assert.equal(enrolled.sessionCookie, undefined);
  assert.equal(f.count("/api/auth/device/code"), 1);
  assert.equal(f.count("/api/devices/enroll"), 1);
  const requestCount = f.requests.length;

  for (const args of [[], ["remote"]]) {
    const resumed = f.start(args, `${f.origin}/`);
    await f.connected(resumed);
    assert.match(resumed.stdout, /"resumed": true/);
    assert.doesNotMatch(resumed.stdout, /Approval code:|"status": "approved"/);
    assert.equal(f.requests.length, requestCount);
    assert.equal(f.upgrades.at(-1).authorization, `Bearer ${enrolledToken}`);
    assert.equal(f.upgrades.at(-1).cookie, undefined);
    assert.equal(f.hellos.at(-1).deviceId, enrolled.device.id);
    assert.equal(f.hellos.at(-1).payload.deviceToken, enrolledToken);
    assert.deepEqual(await finish(resumed, "SIGTERM"), {
      code: 0,
      signal: null,
    });
    assert.deepEqual(await f.read(), enrolled);
    noSecrets(resumed);
  }
  noSecrets(first);
});

test("restored status waits for the server to accept the saved identity", async (t) => {
  const f = await fixture(t);
  await f.save(f.saved());
  let pendingHello;
  f.onHello = (socket, envelope) => {
    pendingHello = { socket, envelope };
    return true;
  };
  const run = f.start();
  await until(() => pendingHello, "CLI did not send hello", run);
  assert.doesNotMatch(run.stdout, /"resumed": true/);
  assert.equal(f.requests.length, 0);
  pendingHello.socket.send(
    JSON.stringify({
      ...pendingHello.envelope,
      payload: { accepted: true },
    }),
  );
  await f.connected(run);
  assert.match(run.stdout, /"resumed": true/);
  noSecrets(run);
});

test("--reauth explicitly rotates the saved device while preserving its name and preferences", async (t) => {
  const f = await fixture(t);
  const saved = f.saved();
  await f.save(saved);
  const run = f.start(["remote", "--reauth", "--name", "Do not rename"]);
  await f.connected(run);
  assert.equal(f.count("/api/auth/device/code"), 1);
  const enrollment = f.requests.find(
    (request) => request.path === "/api/devices/enroll",
  );
  assert.equal(enrollment.body.existingDeviceId, saved.device.id);
  assert.equal(f.upgrades[0].authorization, `Bearer ${enrolledToken}`);
  assert.equal(f.hellos[0].payload.name, saved.device.name);
  assert.doesNotMatch(run.stdout, /"resumed": true/);
  const stored = await f.read();
  assert.equal(stored.deviceToken, enrolledToken);
  assert.equal(stored.language, saved.language);
  assert.deepEqual(stored.serialAllow, saved.serialAllow);
  assert.equal(stored.accessToken, saved.accessToken);
  noSecrets(run);
});

test("incomplete or unbound saved credentials require authorization", async (t) => {
  for (const [label, patch] of [
    ["missing origin", { baseUrl: undefined }],
    ["missing token", { deviceToken: undefined }],
    ["blank token", { deviceToken: "   " }],
    ["missing device id", { device: { name: "Old name" } }],
    ["non-string device id", { device: { id: 7 } }],
    ["invalid saved origin", { baseUrl: "not-an-origin" }],
  ]) {
    await t.test(label, async (st) => {
      const f = await fixture(st);
      await f.save(f.saved(patch));
      const run = f.start();
      await f.connected(run);
      assert.equal(f.count("/api/auth/device/code"), 1);
      assert.equal(f.upgrades.length, 1);
      assert.equal(f.upgrades[0].authorization, `Bearer ${enrolledToken}`);
      assert.doesNotMatch(run.stdout, /"resumed": true/);
      noSecrets(run);
    });
  }
});

test("origin migration never sends old credentials and only replaces config after approval", async (t) => {
  for (const enrollmentStatus of [200, 400]) {
    await t.test(`enrollment status ${enrollmentStatus}`, async (st) => {
      const f = await fixture(st);
      const saved = f.saved({ baseUrl: "https://previous.example.test" });
      await f.save(saved);
      f.enrollmentStatus = enrollmentStatus;
      const run = f.start();
      if (enrollmentStatus === 200) await f.connected(run);
      else assert.equal((await finish(run)).code, 1);
      assert.equal(f.count("/api/auth/device/code"), 1);
      const enrollment = f.requests.find(
        (request) => request.path === "/api/devices/enroll",
      );
      assert.equal(enrollment.body.existingDeviceId, undefined);
      for (const request of [...f.requests, ...f.upgrades]) {
        assert.notEqual(request.authorization, `Bearer ${savedToken}`);
        assert.notEqual(request.authorization, `Bearer ${saved.accessToken}`);
        assert.notEqual(request.cookie, saved.sessionCookie);
      }
      const stored = await f.read();
      if (enrollmentStatus === 200) {
        assert.equal(stored.baseUrl, f.origin);
        assert.equal(stored.deviceToken, enrolledToken);
        assert.equal(stored.accessToken, undefined);
        assert.equal(stored.sessionCookie, undefined);
        assert.equal(stored.language, saved.language);
      } else {
        assert.deepEqual(stored, saved);
      }
      noSecrets(run);
    });
  }
});

test("saved credentials cannot bypass application-origin URL validation", async (t) => {
  const f = await fixture(t);
  const saved = f.saved();
  await f.save(saved);
  for (const baseUrl of [
    `${f.origin}/path`,
    `${f.origin}?query=1`,
    `${f.origin}#fragment`,
    f.origin.replace("http://", "http://user:password@"),
  ]) {
    const run = f.start(["remote"], baseUrl);
    assert.equal((await finish(run)).code, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.upgrades.length, 0);
    assert.deepEqual(await f.read(), saved);
    noSecrets(run);
  }
});

test("a rejected resumed credential falls back to authorization exactly once", async (t) => {
  for (const rejection of [401, 403, 404, "websocket"]) {
    await t.test(String(rejection), async (st) => {
      const f = await fixture(st);
      await f.save(f.saved());
      if (rejection === "websocket") {
        f.onHello = (socket, _hello, count) => {
          if (count !== 1) return false;
          socket.close(1008, "device revoked");
          return true;
        };
      } else {
        f.onUpgrade = (_request, socket, count) => {
          if (count !== 1) return false;
          socket.end(
            "HTTP/1.1 " +
              rejection +
              " Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
          return true;
        };
      }
      const run = f.start();
      await f.connected(run);
      assert.equal(f.upgrades.length, 2);
      assert.equal(f.upgrades[0].authorization, `Bearer ${savedToken}`);
      assert.equal(f.upgrades[1].authorization, `Bearer ${enrolledToken}`);
      assert.equal(f.count("/api/auth/device/code"), 1);
      assert.equal(f.count("/api/devices/enroll"), 1);
      assert.equal((await f.read()).deviceToken, enrolledToken);
      assert.doesNotMatch(run.stdout, /"resumed": true/);
      noSecrets(run);
    });
  }
});

test("a rejected replacement credential stops without another authorization loop", async (t) => {
  const f = await fixture(t);
  await f.save(f.saved());
  f.onUpgrade = (_request, socket) => {
    socket.end(
      "HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    return true;
  };
  const run = f.start();
  assert.equal((await finish(run)).signal, null);
  assert.equal(f.upgrades.length, 2);
  assert.equal(f.count("/api/auth/device/code"), 1);
  assert.equal(f.count("/api/devices/enroll"), 1);
  const stored = await f.read();
  assert.equal(stored.deviceToken, undefined);
  assert.equal(stored.device.id, "saved-device");
  assert.equal(stored.accessToken, "private-account-token");
  noSecrets(run);
});

test("revocation after a successful resumed hello is terminal", async (t) => {
  const f = await fixture(t);
  await f.save(f.saved());
  const run = f.start();
  await f.connected(run);
  assert.match(run.stdout, /"resumed": true/);
  const sockets = [...f.sockets.clients];
  assert.equal(sockets.length, 1);
  sockets[0].close(1008, "device revoked");
  assert.equal((await finish(run)).signal, null);
  assert.equal(f.requests.length, 0);
  assert.equal(f.upgrades.length, 1);
  const stored = await f.read();
  assert.equal(stored.deviceToken, undefined);
  assert.equal(stored.device.id, "saved-device");
  noSecrets(run);
});

test("temporary transport failures preserve credentials and do not request authorization", async (t) => {
  for (const failure of ["503", "network", "policy"]) {
    await t.test(failure, async (st) => {
      const f = await fixture(st);
      const saved = f.saved();
      await f.save(saved);
      if (failure === "policy") {
        f.onHello = (socket, _hello, count) => {
          if (count !== 1) return false;
          socket.close(1008, "invalid envelope");
          return true;
        };
      } else {
        f.onUpgrade = (_request, socket, count) => {
          if (count !== 1) return false;
          if (failure === "network") socket.destroy();
          else
            socket.end(
              "HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
          return true;
        };
      }
      const run = f.start();
      await f.connected(run);
      assert.equal(f.upgrades.length, 2);
      assert.ok(
        f.upgrades.every(
          (request) => request.authorization === `Bearer ${savedToken}`,
        ),
      );
      assert.equal(f.requests.length, 0);
      assert.deepEqual(await f.read(), saved);
      assert.match(run.stdout, /"resumed": true/);
      noSecrets(run);
    });
  }
});

test("SIGINT during recovery authorization leaves the rejected token cleared", async (t) => {
  const f = await fixture(t);
  const saved = f.saved();
  await f.save(saved);
  f.pending = true;
  f.onUpgrade = (_request, socket) => {
    socket.end(
      "HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    return true;
  };
  const run = f.start();
  await until(
    () => f.count("/api/auth/device/code") === 1,
    "Recovery did not start",
    run,
  );
  assert.equal((await f.read()).deviceToken, undefined);
  assert.deepEqual(await finish(run, "SIGINT"), { code: 0, signal: null });
  assert.equal(f.count("/api/devices/enroll"), 0);
  assert.equal(f.upgrades.length, 1);
  const stored = await f.read();
  assert.deepEqual(stored.device, saved.device);
  assert.equal(stored.accessToken, saved.accessToken);
  assert.equal(stored.sessionCookie, saved.sessionCookie);
  noSecrets(run);
});

test("connect does not authorize automatically when the saved credential is rejected", async (t) => {
  const f = await fixture(t);
  await f.save(f.saved());
  f.onUpgrade = (_request, socket) => {
    socket.end(
      "HTTP/1.1 401 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    return true;
  };
  const run = f.start(["connect"]);
  assert.equal((await finish(run)).signal, null);
  assert.equal(f.upgrades.length, 1);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.read()).deviceToken, undefined);
  noSecrets(run);
});

test("login cannot relabel device credentials onto a different origin", async (t) => {
  for (const [label, sameOrigin, loginStatus] of [
    ["same origin", true, 200],
    ["different origin", false, 200],
    ["failed different-origin login", false, 401],
  ]) {
    await t.test(label, async (st) => {
      const f = await fixture(st);
      const saved = f.saved({
        baseUrl: sameOrigin ? f.origin : "https://previous.example.test",
      });
      await f.save(saved);
      f.loginStatus = loginStatus;
      const run = f.start([
        "login",
        "--email",
        "test@example.test",
        "--password",
        "test-password",
      ]);
      assert.equal((await finish(run)).code, loginStatus === 200 ? 0 : 1);
      const stored = await f.read();
      if (loginStatus !== 200) {
        assert.deepEqual(stored, saved);
      } else {
        assert.equal(stored.baseUrl, f.origin);
        assert.equal(stored.accessToken, "new-account-token");
        assert.equal(
          stored.sessionCookie,
          "better-auth.session_token=new-session",
        );
        assert.equal(stored.language, saved.language);
        assert.deepEqual(stored.device, sameOrigin ? saved.device : undefined);
        assert.equal(stored.deviceToken, sameOrigin ? savedToken : undefined);
      }
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].authorization, undefined);
      assert.equal(f.requests[0].cookie, undefined);
      noSecrets(run);
    });
  }
});
