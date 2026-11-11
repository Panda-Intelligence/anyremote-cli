import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@anyremote/contracts";
import { DeviceAgent } from "../src/agent.js";
import { eventually } from "./helpers/fake-serial.js";

/** A socket whose hello ack the test releases by hand, so frames can be sent in the gap. */
class SlowHelloSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = SlowHelloSocket.OPEN;
    this.sent = [];
    this.hello = null;
    queueMicrotask(() => this.emit("open"));
  }

  send(raw) {
    const envelope = JSON.parse(raw);
    this.sent.push(envelope);
    if (envelope.type === "hello") this.hello = envelope;
  }

  ack(epoch) {
    this.emit(
      "message",
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "hello",
        requestId: this.hello.requestId,
        deviceId: this.hello.deviceId,
        connectionEpoch: epoch,
        payload: { accepted: true },
      }),
    );
  }

  ping() {}

  terminate() {
    this.readyState = SlowHelloSocket.CLOSED;
    queueMicrotask(() => this.emit("close", 1006, ""));
  }

  close(code = 1000, reason = "") {
    this.readyState = SlowHelloSocket.CLOSED;
    queueMicrotask(() => this.emit("close", code, reason));
  }
}

function createAgent(sockets) {
  const agent = new DeviceAgent({
    apiClient: { connectUrl: () => "ws://test" },
    deviceId: "dev-1",
    deviceToken: "token",
    executor: { capabilities: () => ["serial"], serialSessions: () => [] },
    WebSocketImpl: class extends SlowHelloSocket {
      constructor() {
        super();
        sockets.push(this);
      }
    },
    heartbeatMs: 60_000,
  });
  agent.on("error", () => {});
  return agent;
}

test("frames produced before the hello ack wait and leave with the new epoch", async () => {
  const sockets = [];
  const agent = createAgent(sockets);
  try {
    agent.start();
    await once(sockets[0], "open");
    sockets[0].ack("epoch-1");
    assert.equal(agent.connectionEpoch, "epoch-1");
    // Drop the link; the executor keeps streaming while the reconnect is in flight.
    sockets[0].terminate();
    await once(agent, "disconnected");
    await eventually(() => sockets.length === 2);
    const second = sockets[1];
    assert.equal(second.sent.length, 1, "only the hello is on the wire");
    assert.ok(agent.streamSink({ sessionId: "s1", seq: 1, data: "aGk=" }));
    assert.ok(agent.send("result", "r1", { ok: true }));
    assert.equal(
      second.sent.length,
      1,
      "still only the hello while the ack is pending",
    );
    assert.equal(agent.pendingSends.length, 2);
    second.ack("epoch-2");
    assert.equal(second.sent.length, 3);
    assert.deepEqual(
      second.sent.slice(1).map((e) => [e.type, e.connectionEpoch]),
      [
        ["stream", "epoch-2"],
        ["result", "epoch-2"],
      ],
    );
    assert.equal(agent.pendingSends.length, 0);
  } finally {
    agent.stop();
  }
});

test("the pending queue is bounded and sheds the oldest stream frames first", async () => {
  const sockets = [];
  const agent = createAgent(sockets);
  try {
    agent.start();
    await once(sockets[0], "open");
    for (let i = 0; i < 300; i += 1)
      agent.streamSink({ sessionId: "s1", seq: i, data: "x" });
    assert.ok(agent.send("result", "r1", { ok: true }));
    assert.equal(agent.pendingSends.length, 256);
    assert.equal(agent.pendingSends[0].payload.seq, 45);
    assert.equal(agent.pendingSends.at(-1).type, "result");
    const connected = once(agent, "connected");
    sockets[0].ack("epoch-1");
    const [event] = await connected;
    assert.equal(event.droppedWhileConnecting, 45);
  } finally {
    agent.stop();
  }
});

test("1008 'invalid envelope' reconnects; only 1008 'device revoked' ends the agent", async () => {
  const sockets = [];
  const agent = createAgent(sockets);
  const protocolErrors = [];
  agent.on("protocolError", (error) => protocolErrors.push(error.message));
  let revoked = 0;
  agent.on("revoked", () => {
    revoked += 1;
  });
  try {
    agent.start();
    await once(sockets[0], "open");
    sockets[0].ack("epoch-1");
    sockets[0].close(1008, "invalid envelope");
    await once(agent, "disconnected");
    assert.equal(revoked, 0);
    assert.equal(agent.shouldReconnect, true);
    assert.ok(agent.reconnectTimer, "a reconnect is scheduled");
    assert.match(protocolErrors[0], /invalid envelope/);
    await eventually(() => sockets.length === 2);
    sockets[1].ack("epoch-2");
    sockets[1].close(1008, "device revoked");
    await once(agent, "revoked");
    assert.equal(revoked, 1);
    assert.equal(agent.shouldReconnect, false);
    assert.equal(agent.reconnectTimer, null);
  } finally {
    agent.stop();
  }
});
