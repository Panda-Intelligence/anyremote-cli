import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_STREAM_FRAME_BYTES,
  STREAM_WINDOW_BYTES,
  streamFrameSchema,
} from "@anyremote/contracts";
import { SerialSessionManager } from "../src/serial/sessions.js";
import { createFakeBinding, eventually } from "./helpers/fake-serial.js";

const SESSION = "00000000-0000-4000-8000-000000000000";

async function setup(options = {}) {
  const binding = createFakeBinding();
  const manager = new SerialSessionManager({
    binding,
    allow: ["/dev/cu.*"],
    deviceId: "dev-1",
    realpath: async (p) => p,
    ...options,
  });
  const session = await manager.open({
    path: "/dev/cu.fake0",
    bufferBytes: options.bufferBytes ?? 4 * 1024 * 1024,
  });
  const frames = [];
  const sink = (frame) => {
    streamFrameSchema.parse(frame);
    frames.push(frame);
    return true;
  };
  let seq = 0;
  const send = (frame) =>
    manager.handleStreamFrame(
      { sessionId: session.sessionId, seq: seq++, ...frame },
      sink,
    );
  send({ kind: "state", state: { phase: "opened" } });
  return { binding, manager, session, frames, sink, send, port: binding.last };
}

const rxBytes = (frames) =>
  Buffer.concat(
    frames
      .filter((f) => f.kind === "rx")
      .map((f) => Buffer.from(f.data, "base64")),
  );

function pattern(length) {
  const buffer = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1)
    buffer[index] = (index * 31 + (index >> 8)) & 0xff;
  return buffer;
}

test("1 MiB streams in order with bounded frames when the consumer acks", async () => {
  const { manager, frames, send, port } = await setup();
  const data = pattern(1024 * 1024);
  let acked = 0;
  for (let offset = 0; offset < data.length; offset += 4096) {
    port.push(data.subarray(offset, offset + 4096));
    // 消费者随到随确认。
    const received = rxBytes(frames).length;
    if (received > acked) {
      send({ kind: "ack", credit: received - acked });
      acked = received;
    }
  }
  await eventually(() => rxBytes(frames).length === data.length);
  assert.ok(rxBytes(frames).equals(data));
  const rx = frames.filter((f) => f.kind === "rx");
  assert.ok(
    rx.every(
      (f) => Buffer.from(f.data, "base64").length <= MAX_STREAM_FRAME_BYTES,
    ),
  );
  for (const [index, frame] of frames.entries())
    assert.equal(frame.seq, index, "seq is contiguous per direction");
  assert.ok(
    frames.every((f) => f.kind !== "state" || f.state.phase !== "paused"),
  );
  await manager.shutdown();
});

test("the credit window pauses delivery once and resumes on ack", async () => {
  const { manager, session, frames, send, port } = await setup();
  const data = pattern(1024 * 1024);
  for (let offset = 0; offset < data.length; offset += 4096)
    port.push(data.subarray(offset, offset + 4096));
  assert.equal(rxBytes(frames).length, STREAM_WINDOW_BYTES);
  assert.equal(
    frames.filter((f) => f.kind === "state" && f.state.phase === "paused")
      .length,
    1,
  );
  // 暂停期间字节仍在环形缓冲里，serial.read 可以读到。
  const peek = await manager.read({
    sessionId: session.sessionId,
    cursor: STREAM_WINDOW_BYTES,
    maxBytes: 16,
    encoding: "hex",
    waitMs: 0,
  });
  assert.equal(
    peek.data,
    data
      .subarray(STREAM_WINDOW_BYTES, STREAM_WINDOW_BYTES + 16)
      .toString("hex"),
  );

  let acked = 0;
  while (rxBytes(frames).length < data.length) {
    const received = rxBytes(frames).length;
    assert.ok(received - acked <= STREAM_WINDOW_BYTES);
    send({ kind: "ack", credit: received - acked });
    acked = received;
    await eventually(
      () => rxBytes(frames).length > received || received === data.length,
    );
  }
  assert.ok(rxBytes(frames).equals(data));
  const phases = frames
    .filter((f) => f.kind === "state")
    .map((f) => f.state.phase);
  assert.ok(phases.length >= 2);
  for (const [index, phase] of phases.entries())
    assert.equal(phase, index % 2 === 0 ? "paused" : "resumed");
  await manager.shutdown();
});

test("ring overflow while paused is reported as bytesLost after resume", async () => {
  const { manager, frames, send, port } = await setup({ bufferBytes: 65_536 });
  const total = 1024 * 1024;
  const data = pattern(total);
  for (let offset = 0; offset < total; offset += 4096)
    port.push(data.subarray(offset, offset + 4096));
  assert.equal(rxBytes(frames).length, STREAM_WINDOW_BYTES);
  send({ kind: "ack", credit: STREAM_WINDOW_BYTES });
  await eventually(
    () => rxBytes(frames).length === STREAM_WINDOW_BYTES + 65_536,
  );
  const reported = frames.reduce(
    (sum, f) => sum + (f.state?.bytesLost ?? 0),
    0,
  );
  assert.equal(reported, total - STREAM_WINDOW_BYTES - 65_536);
  assert.equal(rxBytes(frames).length + reported, total);
  // 恢复后收到的是环里保留的最新字节。
  assert.ok(
    rxBytes(frames)
      .subarray(STREAM_WINDOW_BYTES)
      .equals(data.subarray(total - 65_536)),
  );
  assert.equal(manager.list().sessions[0].bytesLost, reported);
  await manager.shutdown();
});

test("RX is coalesced for the configured window instead of one frame per chunk", async () => {
  const { manager, frames, port } = await setup({ streamCoalesceMs: 10 });
  port.push("ab");
  assert.equal(frames.filter((f) => f.kind === "rx").length, 0);
  port.push("cd");
  await eventually(() => frames.some((f) => f.kind === "rx"));
  assert.equal(frames.filter((f) => f.kind === "rx").length, 1);
  assert.equal(
    Buffer.from(frames.find((f) => f.kind === "rx").data, "base64").toString(),
    "abcd",
  );
  // 满 16 KiB 立即发送，不等待定时器。
  port.push(Buffer.alloc(MAX_STREAM_FRAME_BYTES, 1));
  assert.equal(frames.filter((f) => f.kind === "rx").length, 2);
  await manager.shutdown();
});

test("tx and control frames are applied in arrival order and duplicates are dropped", async () => {
  const { manager, send, port, session, binding, frames, sink } = await setup();
  const b64 = (text) => Buffer.from(text).toString("base64");
  send({ kind: "tx", data: b64("a") });
  send({ kind: "control", control: { dtr: true } });
  send({ kind: "tx", data: b64("b") });
  send({ kind: "tx", data: b64("c") });
  manager.handleStreamFrame(
    { sessionId: session.sessionId, seq: 2, kind: "tx", data: b64("DUP") },
    sink,
  );
  await eventually(() => port.writtenText === "abc");
  assert.deepEqual(
    port.calls.map((c) => (c.op === "write" ? "w" : c.op)),
    ["w", "set", "w", "w"],
  );
  assert.equal(manager.list().sessions[0].txBytes, 3);
  assert.equal(manager.list().sessions[0].holder.kind, "stream");
  assert.equal(
    frames.some((f) => f.state?.error),
    false,
  );
  assert.equal(binding.opened.length, 1);
  await manager.shutdown();
});

test("unknown sessions, bad frames and failed writes produce state frames, not crashes", async () => {
  const { manager, send, port, frames, sink } = await setup();
  const before = frames.length;
  manager.handleStreamFrame({ nonsense: true }, sink);
  assert.equal(frames.length, before);
  manager.handleStreamFrame(
    { sessionId: SESSION, seq: 0, kind: "ack", credit: 1 },
    sink,
  );
  assert.equal(frames.at(-1).state.error.code, "NOT_FOUND");
  port.writeError = new Error("device hiccup");
  const count = frames.length;
  send({ kind: "tx", data: Buffer.from("x").toString("base64") });
  await eventually(() => frames.length > count);
  assert.equal(frames.at(-1).state.error.code, "INTERNAL_ERROR");
  await manager.shutdown();
});

test("unplug and close are announced on the stream", async () => {
  const first = await setup();
  first.port.unplug();
  const lost = first.frames.at(-1);
  assert.equal(lost.state.phase, "lost");
  assert.equal(lost.state.error.code, "SERIAL_PORT_LOST");
  await first.manager.shutdown();

  const second = await setup();
  await second.manager.close({ sessionId: second.session.sessionId });
  assert.equal(second.frames.at(-1).state.phase, "closed");
  await second.manager.shutdown();
});

test("a sink that rejects frames keeps bytes in the ring for the next attach", async () => {
  const { manager, session, port, frames, sink } = await setup();
  let down = true;
  const flaky = (frame) => (down ? false : sink(frame));
  manager.handleStreamFrame(
    {
      sessionId: session.sessionId,
      seq: 100,
      kind: "state",
      state: { phase: "resumed" },
    },
    flaky,
  );
  port.push(Buffer.alloc(MAX_STREAM_FRAME_BYTES, 7));
  assert.equal(frames.filter((f) => f.kind === "rx").length, 0);
  down = false;
  manager.handleStreamFrame(
    {
      sessionId: session.sessionId,
      seq: 101,
      kind: "state",
      state: { phase: "resumed" },
    },
    flaky,
  );
  assert.equal(rxBytes(frames).length, MAX_STREAM_FRAME_BYTES);
  await manager.shutdown();
});
