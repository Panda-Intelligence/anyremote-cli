import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { helloPayloadSchema, PROTOCOL_VERSION } from "@anyremote/contracts";
import { DeviceAgent } from "../src/agent.js";
import { createLocalToolExecutor } from "../src/local-tools.js";
import { createFakeBinding, eventually } from "./helpers/fake-serial.js";

function createSockets() {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    static OPEN = 1;

    constructor() {
      super();
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    send(raw) {
      const envelope = JSON.parse(raw);
      this.sent.push(envelope);
      if (envelope.type === "hello")
        this.deliver("hello", envelope.requestId, { accepted: true });
    }

    deliver(type, requestId, payload) {
      queueMicrotask(() =>
        this.emit(
          "message",
          JSON.stringify({
            version: PROTOCOL_VERSION,
            type,
            requestId,
            deviceId: "dev-1",
            connectionEpoch: "server-epoch",
            payload,
          }),
        ),
      );
    }

    ping() {}

    terminate() {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close", 1006, "network lost"));
    }

    close() {
      this.terminate();
    }
  }
  return { sockets, FakeSocket };
}

async function start(serialAllow) {
  const { sockets, FakeSocket } = createSockets();
  const binding = createFakeBinding();
  const executor = createLocalToolExecutor({
    serialBinding: binding,
    serialAllow,
    serialRealpath: async (p) => p,
  });
  await executor.prepare();
  const agent = new DeviceAgent({
    apiClient: { connectUrl: () => "wss://example.test/connect" },
    deviceId: "dev-1",
    deviceToken: "token",
    executor,
    WebSocketImpl: FakeSocket,
    heartbeatMs: 10_000,
  });
  agent.on("error", () => {});
  agent.start();
  await eventually(() => sockets[0]?.sent.length > 0);
  return { agent, executor, binding, sockets };
}

const hello = (socket) => socket.sent.find((e) => e.type === "hello").payload;

test("hello announces serial capabilities only when enabled", async () => {
  const enabled = await start(["/dev/cu.*"]);
  assert.deepEqual(hello(enabled.sockets[0]).capabilities, [
    "serial",
    "serial.stream",
  ]);
  assert.equal(hello(enabled.sockets[0]).sessions, undefined);
  helloPayloadSchema.parse(hello(enabled.sockets[0]));
  await enabled.agent.shutdown();

  const disabled = await start([]);
  assert.equal("capabilities" in hello(disabled.sockets[0]), false);
  assert.equal(hello(disabled.sockets[0]).agentVersion.length > 0, true);
  await disabled.agent.shutdown();
});

test("stream envelopes reach the session and replies go out as stream envelopes", async () => {
  const { agent, executor, binding, sockets } = await start(["/dev/cu.*"]);
  const session = await executor.execute("serial.open", {
    path: "/dev/cu.fake0",
  });
  const socket = sockets[0];
  await eventually(() => agent.connectionEpoch === "server-epoch");
  const requests = [];
  agent.on("request", (event) => requests.push(event));

  socket.deliver("stream", session.sessionId, {
    sessionId: session.sessionId,
    seq: 0,
    kind: "state",
    state: { phase: "opened" },
  });
  await eventually(() => executor.serial.get(session.sessionId).streaming);
  binding.last.push("from-device");
  const rx = await eventually(() =>
    socket.sent.find((e) => e.type === "stream" && e.payload.kind === "rx"),
  );
  assert.equal(rx.requestId, session.sessionId);
  assert.equal(rx.deviceId, "dev-1");
  assert.equal(rx.connectionEpoch, "server-epoch");
  assert.equal(
    Buffer.from(rx.payload.data, "base64").toString(),
    "from-device",
  );

  socket.deliver("stream", session.sessionId, {
    sessionId: session.sessionId,
    seq: 1,
    kind: "tx",
    data: Buffer.from("to-device").toString("base64"),
  });
  await eventually(() => binding.last.writtenText === "to-device");
  assert.deepEqual(
    requests,
    [],
    "stream frames bypass the request log and idempotency cache",
  );
  assert.equal(agent.completed.size, 0);
  await agent.shutdown();
});

test("a socket reconnect keeps the session and re-announces it in hello", async () => {
  const { agent, executor, binding, sockets } = await start(["/dev/cu.*"]);
  const session = await executor.execute("serial.open", {
    path: "/dev/cu.fake0",
  });
  binding.last.push("kept");
  sockets[0].terminate();
  await eventually(
    () =>
      sockets.length === 2 && sockets[1].sent.some((e) => e.type === "hello"),
    { timeoutMs: 4000 },
  );
  const announced = helloPayloadSchema.parse(hello(sockets[1])).sessions;
  assert.equal(announced.length, 1);
  assert.equal(announced[0].sessionId, session.sessionId);
  assert.equal(announced[0].deviceId, "dev-1");
  assert.equal(announced[0].state, "open");
  assert.equal(binding.last.closeCount, 0, "reconnect does not close the port");
  const read = await executor.execute("serial.read", {
    sessionId: session.sessionId,
    waitMs: 0,
  });
  assert.equal(read.data, "kept");
  await agent.shutdown();
  assert.equal(binding.last.closeCount, 1, "shutdown does");
});
