import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@anyremote/contracts";
import { WebSocketServer } from "ws";
import { DeviceAgent } from "../src/agent.js";
import { LocalToolExecutor } from "../src/local-tools.js";
import { CLI_VERSION } from "../src/version.js";

test("terminal stop bounds an unresponsive WebSocket close handshake", async () => {
  const socket = new EventEmitter();
  let closeRequested = false;
  socket.close = () => {
    closeRequested = true;
  };
  socket.terminate = () => socket.emit("close");
  const agent = new DeviceAgent({
    apiClient: {},
    deviceId: "shutdown",
    deviceToken: "local",
    executor: new LocalToolExecutor(),
  });
  agent.socket = socket;
  const closed = once(socket, "close");
  // 保持测试循环，真实故障场景由尚未关闭的 TCP socket 保持。
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await agent.shutdown();
    assert.equal(closeRequested, true);
    await closed;
    assert.equal(agent.socket, null);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("explicit shutdown stops only owned processes and escalates ignored termination", async () => {
  const executor = new LocalToolExecutor();
  const otherExecutor = new LocalToolExecutor();
  const start = async (owner, ignoreTermination) => {
    const result = await owner.startProcess({
      command: process.execPath,
      args: [
        "-e",
        `${ignoreTermination ? 'process.on("SIGTERM",()=>{});' : ""}console.log("ready");setInterval(()=>{},1000)`,
      ],
      waitMs: 0,
    });
    const state = owner.processes.get(result.processId);
    await once(state.child.stdout, "data", {
      signal: AbortSignal.timeout(3000),
    });
    return state;
  };
  let owned;
  let other;
  try {
    owned = await start(executor, true);
    other = await start(otherExecutor, false);
    await executor.shutdown({ graceMs: 50 });
    assert.notEqual(owned.finishedAt, null);
    if (process.platform !== "win32") assert.equal(owned.signal, "SIGKILL");
    assert.equal(other.finishedAt, null);
    await assert.rejects(
      () => executor.startProcess({ command: process.execPath }),
      /shutting down/,
    );
    await executor.shutdown();
  } finally {
    await executor.shutdown();
    await otherExecutor.shutdown();
  }
});

test("DeviceAgent stops on rejected device credentials instead of reconnecting", async () => {
  const server = new WebSocketServer({ port: 0, verifyClient: () => false });
  await once(server, "listening");
  const agent = new DeviceAgent({
    apiClient: { connectUrl: () => `ws://127.0.0.1:${server.address().port}` },
    deviceId: "revoked",
    deviceToken: "revoked-token",
    executor: new LocalToolExecutor(),
  });
  agent.on("error", () => {});
  try {
    const revoked = once(agent, "revoked", {
      signal: AbortSignal.timeout(3000),
    });
    agent.start();
    await revoked;
    assert.equal(agent.shouldReconnect, false);
    assert.equal(agent.reconnectTimer, null);
  } finally {
    agent.stop();
    server.close();
  }
});

test("DeviceAgent reconnects after a transient socket close", async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const executor = new LocalToolExecutor();
  const running = await executor.startProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    waitMs: 0,
  });
  const agent = new DeviceAgent({
    apiClient: { connectUrl: () => `ws://127.0.0.1:${server.address().port}` },
    deviceId: "reconnect",
    deviceToken: "same-device-token",
    executor,
  });
  agent.on("error", () => {});
  try {
    const first = once(server, "connection");
    agent.start();
    const [socket] = await first;
    const [firstHelloRaw] = await once(socket, "message");
    const firstHello = JSON.parse(firstHelloRaw.toString("utf8"));
    assert.equal(firstHello.type, "hello");
    assert.equal(firstHello.payload.agentVersion, CLI_VERSION);
    const second = once(server, "connection", {
      signal: AbortSignal.timeout(3000),
    });
    socket.close(1012, "temporary restart");
    const [reconnected] = await second;
    const [reconnectedHelloRaw] = await once(reconnected, "message");
    const reconnectedHello = JSON.parse(reconnectedHelloRaw.toString("utf8"));
    assert.equal(reconnectedHello.type, "hello");
    assert.equal(reconnectedHello.payload.agentVersion, CLI_VERSION);
    assert.equal(agent.shouldReconnect, true);
    assert.equal(executor.processes.get(running.processId).finishedAt, null);
    await agent.shutdown();
    assert.notEqual(executor.processes.get(running.processId).finishedAt, null);
    reconnected.close();
  } finally {
    await agent.shutdown();
    server.close();
  }
});

test("DeviceAgent replaces a half-open socket after missed pong and reconnects", async () => {
  class FakeSocket extends EventEmitter {
    static OPEN = 1;

    static CONNECTING = 0;

    static CLOSING = 2;

    static CLOSED = 3;

    constructor(_url, options) {
      super();
      this.readyState = FakeSocket.OPEN;
      this.options = options;
      this.pingCount = 0;
      this.respondToPing = false;
      queueMicrotask(() => this.emit("open"));
    }

    send(raw) {
      const envelope = JSON.parse(raw);
      if (envelope.type === "hello") {
        queueMicrotask(() =>
          this.emit(
            "message",
            JSON.stringify({
              version: PROTOCOL_VERSION,
              type: "hello",
              requestId: envelope.requestId,
              deviceId: envelope.deviceId,
              connectionEpoch: "server-epoch",
              payload: { accepted: true },
            }),
          ),
        );
      }
    }

    ping() {
      this.pingCount += 1;
      if (this.respondToPing) queueMicrotask(() => this.emit("pong"));
    }

    terminate() {
      this.readyState = FakeSocket.CLOSED;
      queueMicrotask(() => this.emit("close", 1006, "network lost"));
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
      queueMicrotask(() => this.emit("close", 1000, "client stopped"));
    }
  }

  const sockets = [];
  const executor = new LocalToolExecutor();
  const agent = new DeviceAgent({
    apiClient: { connectUrl: () => "wss://example.test/connect" },
    deviceId: "half-open",
    deviceToken: "same-device-token",
    executor,
    WebSocketImpl: class extends FakeSocket {
      constructor(...args) {
        super(...args);
        this.respondToPing = sockets.length > 0;
        sockets.push(this);
      }
    },
    heartbeatMs: 10,
    connectTimeoutMs: 100,
  });
  agent.on("error", () => {});
  try {
    const connected = once(agent, "connected", {
      signal: AbortSignal.timeout(3000),
    });
    agent.start();
    await connected;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for reconnect")),
        3000,
      );
      agent.once("connected", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sockets.length, 2);
    assert.ok(sockets[0].pingCount >= 1);
    assert.ok(sockets[1].pingCount >= 1);
    assert.equal(agent.socket, sockets[1]);
  } finally {
    await agent.shutdown();
  }
});

test("DeviceAgent sends hello and executes a remote request once across duplicate delivery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "anyremote-agent-"));
  const filePath = path.join(directory, "remote.txt");
  const server = new WebSocketServer({ port: 0 });
  try {
    await once(server, "listening");
    const port = server.address().port;
    const serverSocketPromise = once(server, "connection");
    let executions = 0;
    const baseExecutor = new LocalToolExecutor();
    const executor = {
      execute: async (...args) => {
        executions += 1;
        return baseExecutor.execute(...args);
      },
    };
    const apiClient = {
      connectUrl: () => `ws://127.0.0.1:${port}/api/devices/device-1/connect`,
    };
    const agent = new DeviceAgent({
      apiClient,
      deviceId: "device-1",
      deviceToken: "device-token",
      executor,
      agentVersion: "9.8.7-custom",
      reconnect: false,
    });
    const requestEvents = [];
    agent.on("request", (event) => requestEvents.push(event));
    agent.start();
    const [serverSocket] = await serverSocketPromise;
    const [helloRaw] = await once(serverSocket, "message");
    const hello = JSON.parse(helloRaw.toString("utf8"));
    assert.equal(hello.type, "hello");
    assert.equal(hello.version, PROTOCOL_VERSION);
    assert.equal(hello.payload.agentVersion, "9.8.7-custom");
    serverSocket.send(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "hello",
        requestId: hello.requestId,
        deviceId: "device-1",
        connectionEpoch: "server-epoch-1",
        payload: { accepted: true },
      }),
    );
    await once(agent, "connected");
    const request = {
      version: PROTOCOL_VERSION,
      type: "request",
      requestId: "request-1",
      deviceId: "device-1",
      connectionEpoch: "server-epoch-1",
      payload: {
        requestId: "request-1",
        deviceId: "device-1",
        tool: "files.write",
        arguments: { path: filePath, content: "agent result" },
        deadline: new Date(Date.now() + 10_000).toISOString(),
      },
    };
    serverSocket.send(JSON.stringify(request));
    const [firstRaw] = await once(serverSocket, "message");
    const first = JSON.parse(firstRaw.toString("utf8"));
    assert.equal(first.type, "result");
    assert.equal(first.payload.status, "success");
    serverSocket.send(JSON.stringify(request));
    const [duplicateRaw] = await once(serverSocket, "message");
    const duplicate = JSON.parse(duplicateRaw.toString("utf8"));
    assert.equal(duplicate.payload.status, "success");
    assert.equal(executions, 1);
    assert.deepEqual(Object.keys(requestEvents[0]).sort(), [
      "elapsedMs",
      "executionMs",
      "requestId",
      "resultBytes",
      "status",
      "tool",
    ]);
    assert.equal(requestEvents[0].requestId, "request-1");
    assert.equal(requestEvents[0].tool, "files.write");
    assert.equal(requestEvents[0].status, "success");
    assert.equal(await readFile(filePath, "utf8"), "agent result");
    agent.stop();
    serverSocket.close();
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded process requests return output once, honor deadlines and survive a lost socket", async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const executor = new LocalToolExecutor();
  let executions = 0;
  let executionStarted;
  const agent = new DeviceAgent({
    apiClient: { connectUrl: () => `ws://127.0.0.1:${server.address().port}` },
    deviceId: "process-device",
    deviceToken: "local-token",
    reconnect: false,
    executor: {
      execute: (...args) => {
        executions += 1;
        executionStarted?.();
        return executor.execute(...args);
      },
      shutdown: () => executor.shutdown(),
    },
  });
  t.after(async () => {
    await agent.shutdown();
    server.close();
  });
  const connection = once(server, "connection");
  const connected = once(agent, "connected");
  agent.start();
  const [socket] = await connection;
  const [helloRaw] = await once(socket, "message");
  const hello = JSON.parse(helloRaw.toString());
  socket.send(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      type: "hello",
      requestId: hello.requestId,
      deviceId: "process-device",
      connectionEpoch: "process-epoch",
      payload: { accepted: true },
    }),
  );
  const [connectionTiming] = await connected;
  assert.ok(connectionTiming.openMs >= 0);
  assert.ok(connectionTiming.helloMs >= 0);
  assert.equal(
    connectionTiming.openMs + connectionTiming.helloMs,
    connectionTiming.elapsedMs,
  );
  const events = [];
  agent.on("request", (event) => events.push(event));
  const request = (requestId, args, deadlineMs = 3000) => ({
    version: PROTOCOL_VERSION,
    type: "request",
    requestId,
    deviceId: "process-device",
    connectionEpoch: "process-epoch",
    payload: {
      requestId,
      deviceId: "process-device",
      tool: "process.start",
      arguments: { command: process.execPath, args, waitMs: 1000 },
      deadline: new Date(Date.now() + deadlineMs).toISOString(),
    },
  });
  const short = request("short-process", [
    "-e",
    'process.stdout.write("remote one")',
  ]);
  const resultMessage = once(socket, "message");
  socket.send(JSON.stringify(short));
  socket.send(JSON.stringify(short));
  const [resultRaw] = await resultMessage;
  const result = JSON.parse(resultRaw.toString());
  assert.equal(result.payload.status, "success");
  assert.equal(result.payload.output.stdout, "remote one");
  assert.equal(result.payload.output.exitCode, 0);
  assert.equal(result.payload.output.exited, true);
  assert.equal(result.payload.output.nextCursor, 10);
  assert.equal(executions, 1);
  assert.equal(executor.processes.size, 1);
  const replayMessage = once(socket, "message");
  socket.send(JSON.stringify(short));
  const [replayRaw] = await replayMessage;
  assert.deepEqual(JSON.parse(replayRaw.toString()).payload, result.payload);
  assert.equal(executions, 1);
  assert.equal(
    events[0].resultBytes,
    Buffer.byteLength(JSON.stringify(result.payload)),
  );
  assert.ok(events[0].executionMs >= 0);
  assert.ok(events[0].elapsedMs >= events[0].executionMs);

  const silent = request(
    "deadline-process",
    ["-e", "setInterval(()=>{},1000)"],
    100,
  );
  silent.payload.arguments.waitMs = 10_000;
  const boundedMessage = once(socket, "message");
  socket.send(JSON.stringify(silent));
  const [boundedRaw] = await boundedMessage;
  const bounded = JSON.parse(boundedRaw.toString());
  assert.equal(bounded.payload.status, "success");
  assert.equal(bounded.payload.output.running, true);
  assert.equal(executions, 2);
  assert.equal(
    executor.processes
      .get(bounded.payload.output.processId)
      .listenerCount("changed"),
    0,
  );

  const lost = request("lost-process", ["-e", "setInterval(()=>{},1000)"], 150);
  lost.payload.arguments.waitMs = 10_000;
  const began = new Promise((resolve) => {
    executionStarted = resolve;
  });
  const finished = once(agent, "request");
  const disconnected = once(agent, "disconnected");
  socket.send(JSON.stringify(lost));
  await began;
  socket.close(1012, "response connection lost");
  await disconnected;
  const [finishedEvent] = await finished;
  assert.equal(finishedEvent.requestId, "lost-process");
  const retained = agent.completed.get("lost-process").result;
  assert.equal(retained.status, "success");
  assert.equal(retained.output.running, true);
  const surviving = executor.processes.get(retained.output.processId);
  assert.equal(surviving.finishedAt, null);
  assert.equal(surviving.listenerCount("changed"), 0);
  assert.equal(executions, 3);
});
