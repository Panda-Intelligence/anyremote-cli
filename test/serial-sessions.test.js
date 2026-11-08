import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SERIAL_WRITE_BYTES,
  serialReadResultSchema,
} from "@anyremote/contracts";
import { SerialSessionManager } from "../src/serial/sessions.js";
import { createFakeBinding, eventually } from "./helpers/fake-serial.js";

function setup({ ports, allow = ["/dev/cu.*"], realpath, ...rest } = {}) {
  const binding = createFakeBinding(ports ? { ports } : undefined);
  const closed = [];
  const manager = new SerialSessionManager({
    binding,
    allow,
    deviceId: "dev-1",
    realpath: realpath ?? (async (p) => p),
    onSessionClosed: (event) => closed.push(event),
    ...rest,
  });
  return { binding, manager, closed };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

test("a port has a single holder per canonical path and is reusable after close", async () => {
  const { manager, binding } = setup({
    ports: [{ path: "/dev/cu.fake0" }, { path: "/dev/cu.alias" }],
    realpath: async (p) => (p === "/dev/cu.alias" ? "/dev/cu.fake0" : p),
  });
  const first = await manager.open({ path: "/dev/cu.fake0" });
  assert.equal(first.state, "open");
  assert.equal(first.deviceId, "dev-1");
  await rejectsWith(
    manager.open({ path: "/dev/cu.fake0" }),
    "SERIAL_PORT_BUSY",
  );
  await rejectsWith(
    manager.open({ path: "/dev/cu.alias" }),
    "SERIAL_PORT_BUSY",
  );
  const result = await manager.close({ sessionId: first.sessionId });
  assert.deepEqual(result, { closed: true, sessionId: first.sessionId });
  assert.equal(binding.last.closeCount, 1);
  const second = await manager.open({ path: "/dev/cu.fake0" });
  assert.notEqual(second.sessionId, first.sessionId);
  await manager.shutdown();
});

test("concurrent opens of one path admit exactly one session", async () => {
  const { manager } = setup();
  const results = await Promise.allSettled([
    manager.open({ path: "/dev/cu.fake0" }),
    manager.open({ path: "/dev/cu.fake0" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "SERIAL_PORT_BUSY",
  );
  await manager.shutdown();
});

test("read pages by absolute cursor and long-polls for new data", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  binding.last.push("hello world");
  const one = await manager.read({ sessionId, maxBytes: 5, waitMs: 0 });
  assert.equal(one.data, "hello");
  assert.equal(one.nextCursor, 5);
  assert.equal(one.truncated, true);
  const two = await manager.read({
    sessionId,
    cursor: one.nextCursor,
    waitMs: 0,
  });
  assert.equal(two.data, " world");
  assert.equal(two.nextCursor, 11);
  assert.equal(two.truncated, false);
  assert.deepEqual(serialReadResultSchema.parse(two).lineState, {
    cts: false,
    dsr: false,
    dcd: false,
    ri: false,
  });
  // 重读同一游标得到同样字节（读取不消费）。
  assert.equal(
    (await manager.read({ sessionId, cursor: 5, waitMs: 0 })).data,
    " world",
  );

  const startedAt = Date.now();
  setTimeout(() => binding.last.push("late"), 40);
  const late = await manager.read({ sessionId, cursor: 11, waitMs: 2000 });
  assert.equal(late.data, "late");
  assert.ok(Date.now() - startedAt < 1000);

  const idle = Date.now();
  const empty = await manager.read({ sessionId, cursor: 15, waitMs: 80 });
  assert.equal(empty.data, "");
  assert.ok(Date.now() - idle >= 70);
  await rejectsWith(
    manager.read({ sessionId, cursor: 99, waitMs: 0 }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.read({ sessionId, waitMs: 10_001 }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.read({ sessionId, maxBytes: 65_537 }),
    "VALIDATION_ERROR",
  );
  await manager.shutdown();
});

test("read wait is bounded by the request deadline minus a margin", async () => {
  const { manager } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  const startedAt = Date.now();
  await manager.read(
    { sessionId, waitMs: 10_000 },
    { deadline: Date.now() + 120 },
  );
  assert.ok(Date.now() - startedAt < 200);
  await manager.shutdown();
});

test("until stops at the match for literal and regex patterns", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  setTimeout(() => binding.last.push("boot ok\r\n>"), 20);
  setTimeout(() => binding.last.push(" more"), 40);
  const literal = await manager.read({
    sessionId,
    until: "\r\n>",
    waitMs: 1000,
  });
  assert.equal(literal.matched, true);
  assert.equal(literal.data.endsWith("\r\n>"), true);
  const rest = await manager.read({
    sessionId,
    cursor: literal.nextCursor,
    waitMs: 200,
  });
  assert.equal(rest.data, " more");
  assert.equal(rest.matched, undefined);

  binding.last.push("version 12 build");
  const regex = await manager.read({
    sessionId,
    cursor: rest.nextCursor,
    until: "/version (\\d+)/",
    waitMs: 100,
  });
  assert.equal(regex.matched, true);
  assert.equal(regex.data, "version 12");

  const miss = await manager.read({
    sessionId,
    cursor: regex.nextCursor,
    until: "NEVER",
    waitMs: 60,
  });
  assert.equal(miss.matched, false);
  assert.equal(miss.data, " build");
  await rejectsWith(
    manager.read({ sessionId, until: "/(/", waitMs: 0 }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.read({ sessionId, until: `/${"a".repeat(129)}/`, waitMs: 0 }),
    "VALIDATION_ERROR",
  );
  await manager.shutdown();
});

test("utf8 reads never split a code point; hex and base64 are byte exact", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  binding.last.push(Buffer.from([0x68, 0xc3]));
  const partial = await manager.read({ sessionId, waitMs: 0 });
  assert.equal(partial.data, "h");
  assert.equal(partial.nextCursor, 1);
  binding.last.push(Buffer.from([0xa9, 0x69]));
  const whole = await manager.read({
    sessionId,
    cursor: partial.nextCursor,
    waitMs: 0,
  });
  assert.equal(whole.data, "éi");
  assert.equal(whole.nextCursor, 4);

  binding.last.push("aé");
  const capped = await manager.read({
    sessionId,
    cursor: 4,
    maxBytes: 2,
    waitMs: 0,
  });
  assert.equal(capped.data, "a");
  assert.equal(capped.nextCursor, 5);
  const tiny = await manager
    .read({ sessionId, cursor: 5, maxBytes: 1, waitMs: 0 })
    .catch((e) => e);
  assert.equal(tiny.code, "VALIDATION_ERROR");

  binding.last.push(Buffer.from([0xff, 0x00, 0x10]));
  const hex = await manager.read({
    sessionId,
    cursor: 5,
    encoding: "hex",
    maxBytes: 100,
    waitMs: 0,
  });
  assert.equal(hex.data, "c3a9ff0010");
  const b64 = await manager.read({
    sessionId,
    cursor: 7,
    encoding: "base64",
    waitMs: 0,
  });
  assert.equal(Buffer.from(b64.data, "base64").toString("hex"), "ff0010");
  assert.equal(b64.encoding, "base64");
  await manager.shutdown();
});

test("write honours encodings, eol and the 64 KiB bound", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  const text = await manager.write({ sessionId, data: "AT", eol: "\r\n" });
  assert.deepEqual(text, { bytesWritten: 4, txBytes: 4 });
  await manager.write({ sessionId, data: "ff00", encoding: "hex" });
  await manager.write({
    sessionId,
    data: Buffer.from([1, 2]).toString("base64"),
    encoding: "base64",
  });
  assert.equal(
    Buffer.concat(binding.last.written).toString("hex"),
    "41540d0aff000102",
  );
  const full = await manager.write({
    sessionId,
    data: "x".repeat(MAX_SERIAL_WRITE_BYTES),
  });
  assert.equal(full.bytesWritten, MAX_SERIAL_WRITE_BYTES);
  await rejectsWith(
    manager.write({ sessionId, data: "x".repeat(MAX_SERIAL_WRITE_BYTES + 1) }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.write({
      sessionId,
      data: "x".repeat(MAX_SERIAL_WRITE_BYTES),
      eol: "\n",
    }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.write({ sessionId, data: "abc", encoding: "hex" }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.write({ sessionId, data: "!!", encoding: "base64" }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.write({ sessionId, data: "x", eol: "|" }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(manager.write({ sessionId, data: 5 }), "VALIDATION_ERROR");
  await manager.shutdown();
});

test("a write that never drains returns OUTCOME_UNKNOWN within the deadline", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  binding.last.writeDelayMs = 5000;
  const startedAt = Date.now();
  await rejectsWith(
    manager.write({ sessionId, data: "x" }, { deadline: Date.now() + 150 }),
    "OUTCOME_UNKNOWN",
  );
  assert.ok(Date.now() - startedAt < 1000);
  await manager.shutdown();
});

test("concurrent transacts are serialised and never interleave", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  const port = binding.last;
  const events = [];
  port.onWrite = (buffer) => {
    const command = buffer.toString().trim();
    events.push(`write:${command}`);
    setTimeout(() => {
      events.push(`reply:${command}`);
      port.push(`re-${command}\n`);
    }, 25);
  };
  const [a, b, c] = await Promise.all(
    ["A", "B", "C"].map((data) =>
      manager.transact({
        sessionId,
        data,
        eol: "\n",
        until: "\n",
        waitMs: 1000,
      }),
    ),
  );
  assert.deepEqual([a.data, b.data, c.data], ["re-A\n", "re-B\n", "re-C\n"]);
  assert.deepEqual([a.matched, b.matched, c.matched], [true, true, true]);
  assert.deepEqual(events, [
    "write:A",
    "reply:A",
    "write:B",
    "reply:B",
    "write:C",
    "reply:C",
  ]);
  await manager.shutdown();
});

test("transact reads only what arrives after its write", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  binding.last.push("stale banner\n");
  binding.last.onWrite = () =>
    setTimeout(() => binding.last.push("pong\n"), 10);
  const result = await manager.transact({
    sessionId,
    data: "ping\n",
    until: "pong",
    waitMs: 500,
  });
  assert.equal(result.data, "pong");
  await manager.shutdown();
});

test("control applies lines, baud, break and purge; format changes are rejected", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  const port = binding.last;
  binding.last.modem.cts = true;
  const lines = await manager.control({
    sessionId,
    dtr: true,
    rts: false,
    baudRate: 9600,
  });
  assert.equal(lines.lineState.cts, true);
  assert.equal(lines.applied, 2);
  assert.deepEqual(port.calls.find((c) => c.op === "update").options, {
    baudRate: 9600,
  });
  assert.deepEqual(port.calls.find((c) => c.op === "set").options, {
    dtr: true,
    rts: false,
  });

  const before = port.calls.length;
  const startedAt = performance.now();
  await manager.control({ sessionId, breakMs: 60 });
  assert.ok(performance.now() - startedAt >= 55);
  const breaks = port.calls.slice(before).map((c) => c.options?.brk);
  assert.deepEqual(breaks, [true, false]);

  port.push("stale");
  await manager.control({ sessionId, purge: "rx" });
  assert.equal(port.calls.at(-1).op, "flush");
  const afterPurge = await manager.read({ sessionId, waitMs: 0 });
  assert.equal(afterPurge.data, "");
  assert.equal(afterPurge.bytesLost, 0);
  assert.equal(afterPurge.nextCursor, 5);

  await rejectsWith(
    manager.control({ sessionId, parity: "even" }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.control({ sessionId, breakMs: 5000 }),
    "VALIDATION_ERROR",
  );
  await rejectsWith(
    manager.control({ sessionId, bogus: true }),
    "VALIDATION_ERROR",
  );
  await manager.shutdown();
});

test("a four-step reset sequence runs locally within 15 ms per step", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  const port = binding.last;
  const delays = [100, 50, 120, 30];
  const result = await manager.control({
    sessionId,
    sequence: [
      { dtr: false, rts: true, delayMs: delays[0] },
      { dtr: true, rts: false, delayMs: delays[1] },
      { dtr: false, delayMs: delays[2] },
      { rts: false, delayMs: delays[3] },
    ],
  });
  assert.equal(result.applied, 4);
  const sets = port.calls.filter((c) => c.op === "set");
  assert.equal(sets.length, 4);
  for (let step = 0; step < 3; step += 1) {
    const measured = sets[step + 1].at - sets[step].at;
    assert.ok(
      Math.abs(measured - delays[step]) <= 15,
      `step ${step}: expected ${delays[step]} ms, measured ${measured.toFixed(1)} ms`,
    );
  }
  assert.deepEqual(
    sets.map((c) => c.options),
    [
      { dtr: false, rts: true },
      { dtr: true, rts: false },
      { dtr: false },
      { rts: false },
    ],
  );
  await manager.shutdown();
});

test("idle timeout closes the port with an unref'd timer and records the reason", async () => {
  const { manager, binding, closed } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  const session = manager.get(sessionId);
  assert.equal(session.idleTimer.hasRef(), false);
  session.params = { ...session.params, idleTimeoutMs: 60 };
  session.touch();
  await wait(35);
  await manager.read({ sessionId, waitMs: 0 });
  await wait(35);
  assert.equal(session.state, "open", "activity resets the idle timer");
  await eventually(() => session.state === "closed");
  assert.equal(binding.last.closeCount, 1);
  assert.equal(closed[0].reason, "idle");
  await rejectsWith(manager.read({ sessionId, waitMs: 0 }), "NOT_FOUND");
  assert.equal((await manager.open({ path: "/dev/cu.fake0" })).state, "open");
  await manager.shutdown();
});

test("unplugging marks the session lost and releases the path", async () => {
  const { manager, binding, closed } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  binding.last.unplug();
  await rejectsWith(manager.read({ sessionId, waitMs: 0 }), "SERIAL_PORT_LOST");
  await rejectsWith(
    manager.write({ sessionId, data: "x" }),
    "SERIAL_PORT_LOST",
  );
  await rejectsWith(
    manager.control({ sessionId, dtr: true }),
    "SERIAL_PORT_LOST",
  );
  assert.equal(manager.list().sessions[0].state, "lost");
  assert.equal(manager.announcedSessions().length, 0);
  assert.equal(closed[0].reason, "lost");
  const reopened = await manager.open({ path: "/dev/cu.fake0" });
  assert.notEqual(reopened.sessionId, sessionId);
  assert.deepEqual(await manager.close({ sessionId }), {
    closed: true,
    sessionId,
  });
  assert.equal(closed.length, 1, "counters are reported once per session");
  await manager.shutdown();
});

test("a pending read is released with SERIAL_PORT_LOST when the port vanishes", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({ path: "/dev/cu.fake0" });
  setTimeout(() => binding.last.unplug(), 30);
  await rejectsWith(
    manager.read({ sessionId, waitMs: 5000 }),
    "SERIAL_PORT_LOST",
  );
});

test("the RX ring drops oldest bytes and reports bytesLost", async () => {
  const { manager, binding } = setup();
  const { sessionId } = await manager.open({
    path: "/dev/cu.fake0",
    bufferBytes: 65_536,
  });
  const chunk = Buffer.alloc(10_000, 0x61);
  for (let index = 0; index < 10; index += 1) binding.last.push(chunk);
  const result = await manager.read({
    sessionId,
    cursor: 0,
    maxBytes: 65_536,
    encoding: "base64",
    waitMs: 0,
  });
  assert.equal(result.bufferStartCursor, 100_000 - 65_536);
  assert.equal(result.bytesLost, 100_000 - 65_536);
  assert.equal(result.truncated, true);
  assert.equal(result.nextCursor, 100_000);
  assert.equal(Buffer.from(result.data, "base64").length, 65_536);
  assert.equal(manager.list().sessions[0].rxCursor, 100_000);
  assert.equal(manager.list().sessions[0].bytesLost, 100_000 - 65_536);
  await manager.shutdown();
});

test("shutdown closes every port and reports counters without path or data", async () => {
  const { manager, binding, closed } = setup();
  const a = await manager.open({ path: "/dev/cu.fake0" });
  await manager.open({ path: "/dev/cu.fake1" });
  binding.opened[0].push("secret-bytes");
  await manager.write({ sessionId: a.sessionId, data: "hi" });
  await manager.shutdown();
  assert.deepEqual(
    binding.opened.map((p) => p.closeCount),
    [1, 1],
  );
  assert.equal(closed.length, 2);
  for (const event of closed) {
    assert.deepEqual(Object.keys(event).sort(), [
      "bytesLost",
      "durationMs",
      "reason",
      "rxBytes",
      "sessionId",
      "txBytes",
    ]);
  }
  assert.equal(closed.find((e) => e.sessionId === a.sessionId).rxBytes, 12);
  await rejectsWith(manager.open({ path: "/dev/cu.fake0" }), "CONFLICT");
});
