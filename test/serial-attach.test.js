import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { PROTOCOL_VERSION, streamFrameSchema } from "@anyremote/contracts";
import { WebSocketServer } from "ws";
import { buildHello, runSerialAttach } from "../src/serial/attach.js";
import {
  hasSocat,
  SOCAT_MISSING_MESSAGE,
  startSocatPty,
} from "../src/serial/pty.js";
import { CP, subnegotiation } from "../src/serial/rfc2217.js";
import { eventually } from "./helpers/fake-serial.js";

const SESSION = "7f1c2e4a-3b5d-4c6e-8f90-a1b2c3d4e5f6";
const TOKEN = "device-token-secret";

function sessionFixture(params = {}) {
  return {
    sessionId: SESSION,
    deviceId: "target",
    path: "/dev/ttyUSB0",
    params: {
      path: "/dev/ttyUSB0",
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      bufferBytes: 1048576,
      idleTimeoutMs: 600000,
      ...params,
    },
    openedAt: "2026-11-08T00:00:00.000Z",
    lastActivityAt: "2026-11-08T00:00:00.000Z",
    holder: { kind: "stream", consumerDeviceId: "consumer" },
    rxCursor: 0,
    txBytes: 0,
    bytesLost: 0,
    state: "open",
  };
}

/** 假中继：扮演 Worker DO，说同一套 hello / stream 协议。 */
async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const state = {
    requests: [],
    hellos: [],
    frames: [],
    sockets: new Set(),
    rxSeq: 0,
    epoch: randomUUID(),
    pings: 0,
  };
  wss.on("connection", (socket, request) => {
    state.requests.push({ url: request.url, headers: request.headers });
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("message", (data) => {
      const text = data.toString();
      if (text === "ping") {
        state.pings += 1;
        socket.send("pong");
        return;
      }
      const envelope = JSON.parse(text);
      if (envelope.type === "hello") {
        state.hellos.push(envelope.payload);
        socket.send(
          JSON.stringify({
            version: PROTOCOL_VERSION,
            type: "hello",
            requestId: envelope.requestId,
            deviceId: envelope.deviceId,
            connectionEpoch: state.epoch,
            payload: { accepted: true },
          }),
        );
        const phase = envelope.payload.open ? "opened" : "resumed";
        state.send(
          socket,
          {
            kind: "state",
            state: {
              phase,
              session: sessionFixture(envelope.payload.open ?? {}),
            },
          },
          true,
        );
        return;
      }
      assert.equal(
        envelope.connectionEpoch,
        state.epoch,
        "consumer uses the relay-issued epoch",
      );
      assert.equal(envelope.requestId, SESSION);
      streamFrameSchema.parse(envelope.payload);
      state.frames.push(envelope.payload);
      if (
        envelope.payload.kind === "state" &&
        envelope.payload.state.phase === "closed"
      )
        socket.close(1000, "closed");
    });
  });
  state.send = (socket, frame, doOriginated = false) => {
    socket.send(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "stream",
        requestId: SESSION,
        deviceId: "consumer",
        connectionEpoch: state.epoch,
        payload: {
          sessionId: SESSION,
          seq: doOriginated ? Math.max(0, state.rxSeq - 1) : state.rxSeq,
          ...frame,
        },
      }),
    );
  };
  state.rx = (data) => {
    for (const socket of state.sockets) {
      state.send(socket, {
        kind: "rx",
        data: Buffer.from(data).toString("base64"),
      });
    }
    state.rxSeq += 1;
  };
  state.broadcast = (frame) => {
    for (const socket of state.sockets) state.send(socket, frame, true);
  };
  state.url = `http://127.0.0.1:${wss.address().port}`;
  state.close = async () => {
    for (const socket of state.sockets) socket.terminate();
    wss.close();
  };
  state.wss = wss;
  return state;
}

const flags = (extra = {}) => ({
  device: "target",
  path: "/dev/ttyUSB0",
  rfc2217_port: "0",
  raw_port: "0",
  ...extra,
});

function config(relay) {
  return { baseUrl: relay.url, device: { id: "consumer" }, deviceToken: TOKEN };
}

async function attach(relay, extra = {}, deps = {}) {
  const run = await runSerialAttach(flags(extra), {
    config: config(relay),
    ...deps,
  });
  const port = (url) =>
    Number(new URL(url.replace(/^(rfc2217|socket):/, "tcp:")).port);
  return { run, rawPort: port(run.urls.raw), rfcPort: port(run.urls.rfc2217) };
}

async function rawClient(port) {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  return { socket, received: () => Buffer.concat(chunks) };
}

const pattern = (length) => {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = (i * 31 + (i >> 8)) & 0xff;
  return buffer;
};
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

test("missing device credentials fail with the enrollment hint before any connection", async () => {
  await assert.rejects(
    runSerialAttach(flags(), { config: { baseUrl: "http://127.0.0.1:1" } }),
    /Run `anyremote remote` on this machine first/,
  );
});

test("--control-coalesce-ms outside 0..1000 is rejected", async () => {
  for (const value of ["-1", "1001", "x"])
    await assert.rejects(
      runSerialAttach(flags({ control_coalesce_ms: value }), {
        config: {
          baseUrl: "http://127.0.0.1:1",
          device: { id: "c" },
          deviceToken: TOKEN,
        },
      }),
      /--control-coalesce-ms must be an integer from 0 to 1000/,
    );
});

test("connects with the saved device credentials, opens with validated params and listens on loopback only", async () => {
  const relay = await fakeRelay();
  const { run, rawPort } = await attach(relay, {
    baud: "921600",
    parity: "even",
  });
  try {
    assert.equal(relay.requests[0].url, "/api/devices/target/serial/stream");
    assert.equal(relay.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(
      relay.requests[0].headers["x-anyremote-consumer-device-id"],
      "consumer",
    );
    assert.equal(relay.hellos[0].open.path, "/dev/ttyUSB0");
    assert.equal(relay.hellos[0].open.baudRate, 921600);
    assert.equal(relay.hellos[0].open.parity, "even");
    assert.equal(run.sessionId, SESSION);
    assert.match(run.urls.rfc2217, /^rfc2217:\/\/127\.0\.0\.1:\d+$/);
    assert.match(run.urls.raw, /^socket:\/\/127\.0\.0\.1:\d+$/);
    // Loopback only: the listener address is 127.0.0.1.
    const probe = net.connect(rawPort, "127.0.0.1");
    await once(probe, "connect");
    assert.equal(probe.remoteAddress, "127.0.0.1");
    probe.destroy();
  } finally {
    await run.close();
    await relay.close();
  }
});

test("buildHello validates parameters and supports resume", () => {
  assert.deepEqual(buildHello({ session: SESSION }, 42), {
    resume: { sessionId: SESSION, lastSeq: 42 },
  });
  assert.throws(() => buildHello({}), /--path/);
  assert.throws(() => buildHello({ path: "/dev/x", baud: "fast" }), /--baud/);
  assert.throws(
    () => buildHello({ path: "/dev/x", data: 9 }),
    /Invalid serial parameters/,
  );
  assert.equal(buildHello({ path: "/dev/x", stop: "1.5" }).open.stopBits, 1.5);
});

test("raw TCP carries 1 MiB each way in order with bounded frames, acks and no token leakage", async () => {
  const relay = await fakeRelay();
  const messages = [];
  const { run, rawPort } = await attach(relay);
  run.events.on("warning", (m) => messages.push(m));
  run.events.on("status", (m) => messages.push(m));
  const client = await rawClient(rawPort);
  try {
    const down = pattern(1024 * 1024);
    for (let offset = 0; offset < down.length; offset += 16384)
      relay.rx(down.subarray(offset, offset + 16384));
    await eventually(() => client.received().length === down.length, {
      timeoutMs: 10_000,
    });
    assert.equal(sha(client.received()), sha(down), "rx checksum");

    const up = pattern(1024 * 1024 + 123);
    for (let offset = 0; offset < up.length; offset += 7000)
      client.socket.write(up.subarray(offset, offset + 7000));
    const sent = () =>
      Buffer.concat(
        relay.frames
          .filter((f) => f.kind === "tx")
          .map((f) => Buffer.from(f.data, "base64")),
      );
    await eventually(() => sent().length === up.length, { timeoutMs: 10_000 });
    assert.equal(sha(sent()), sha(up), "tx checksum");
    const tx = relay.frames.filter((f) => f.kind === "tx");
    assert.ok(tx.every((f) => Buffer.from(f.data, "base64").length <= 16384));
    assert.ok(
      tx.length < Math.ceil(up.length / 7000),
      "small writes are coalesced",
    );
    // seq is contiguous per direction starting at 0.
    for (const [index, frame] of relay.frames.entries())
      assert.equal(frame.seq, index);

    // Every consumed byte is acknowledged: 64 KiB steps, remainder on the 500 ms timer.
    await eventually(
      () =>
        relay.frames
          .filter((f) => f.kind === "ack")
          .reduce((sum, f) => sum + f.credit, 0) === down.length,
      { timeoutMs: 3000 },
    );
    assert.ok(
      relay.frames
        .filter((f) => f.kind === "ack")
        .every((f) => f.credit <= 262144),
    );
    assert.equal(run.stats().rxBytes, down.length);
    assert.equal(run.stats().bytesLost, 0);
    assert.equal(run.stats().gaps, 0);
    assert.ok(!JSON.stringify(messages).includes(TOKEN));
  } finally {
    client.socket.destroy();
    await run.close();
    await relay.close();
  }
});

test("rx with no local client is discarded, counted and still acknowledged so the window keeps moving", async () => {
  const relay = await fakeRelay();
  const { run } = await attach(relay);
  try {
    relay.rx(pattern(100_000));
    await eventually(() => run.stats().rxBytes === 100_000);
    await eventually(
      () =>
        relay.frames
          .filter((f) => f.kind === "ack")
          .reduce((s, f) => s + f.credit, 0) === 100_000,
      { timeoutMs: 2000 },
    );
  } finally {
    await run.close();
    await relay.close();
  }
});

test("device bytesLost and seq gaps are surfaced, never hidden", async () => {
  const relay = await fakeRelay();
  const { run } = await attach(relay);
  try {
    relay.rx("a");
    for (const socket of relay.sockets) {
      relay.send(socket, {
        kind: "rx",
        data: "Yg==",
        state: { phase: "resumed", bytesLost: 4096 },
      });
    }
    relay.rxSeq += 1;
    relay.rxSeq += 2; // two frames vanish
    relay.rx("c");
    await eventually(() => run.stats().rxBytes === 3);
    assert.equal(run.stats().bytesLost, 4096);
    assert.equal(run.stats().gaps, 1);
    assert.match(run.statusLine(), /lost 4096 B/);
  } finally {
    await run.close();
    await relay.close();
  }
});

test("RFC2217: baud, purge and a DTR/RTS burst become control frames; the burst is one sequence", async () => {
  const relay = await fakeRelay();
  const { run, rfcPort } = await attach(relay);
  const client = await rawClient(rfcPort);
  try {
    await eventually(() => client.received().length > 0);
    const baud = Buffer.alloc(4);
    baud.writeUInt32BE(460800);
    client.socket.write(subnegotiation(CP.SET_BAUDRATE, baud));
    client.socket.write(subnegotiation(CP.PURGE_DATA, [3]));
    await eventually(() =>
      relay.frames.some((f) => f.control?.purge === "both"),
    );
    assert.deepEqual(relay.frames.find((f) => f.control?.baudRate)?.control, {
      baudRate: 460800,
    });

    // 4 toggles, 15 ms apart (all within 100 ms): esptool-style reset.
    const toggle = (code) =>
      client.socket.write(subnegotiation(CP.SET_CONTROL, [code]));
    const started = performance.now();
    for (const code of [9, 11, 8, 12]) {
      toggle(code);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const elapsed = performance.now() - started;
    await eventually(() => relay.frames.some((f) => f.control?.sequence), {
      timeoutMs: 1500,
    });
    const sequences = relay.frames.filter((f) => f.control?.sequence);
    assert.equal(sequences.length, 1, "one control frame for the whole burst");
    const steps = sequences[0].control.sequence;
    assert.equal(steps.length, 4);
    assert.deepEqual(
      steps.map((s) => [s.dtr, s.rts]),
      [
        [false, undefined],
        [undefined, true],
        [true, undefined],
        [undefined, false],
      ],
    );
    const total = steps.slice(0, 3).reduce((sum, s) => sum + s.delayMs, 0);
    assert.ok(
      Math.abs(total - (elapsed - 15)) <= 40,
      `recorded delays ${total} track the real gaps ${elapsed - 15}`,
    );
    assert.equal(steps[3].delayMs, 0);
  } finally {
    client.socket.destroy();
    await run.close();
    await relay.close();
  }
});

test("a single DTR change goes out alone when the control window ends", async () => {
  const relay = await fakeRelay();
  const { run, rfcPort } = await attach(relay);
  const client = await rawClient(rfcPort);
  try {
    client.socket.write(subnegotiation(CP.SET_CONTROL, [8]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      relay.frames.some((f) => f.kind === "control"),
      false,
    );
    await eventually(() => relay.frames.some((f) => f.kind === "control"), {
      timeoutMs: 1000,
    });
    assert.deepEqual(relay.frames.find((f) => f.kind === "control").control, {
      dtr: true,
    });
  } finally {
    client.socket.destroy();
    await run.close();
    await relay.close();
  }
});

test("a second RFC2217 client is refused with a message while the first keeps working", async () => {
  const relay = await fakeRelay();
  const { run, rfcPort } = await attach(relay);
  const first = await rawClient(rfcPort);
  try {
    await eventually(() => first.received().length > 0);
    const second = await rawClient(rfcPort);
    await once(second.socket, "close");
    assert.match(second.received().toString(), /another RFC2217 client/);
    relay.rx("still-here");
    await eventually(() => first.received().toString().includes("still-here"));
  } finally {
    first.socket.destroy();
    await run.close();
    await relay.close();
  }
});

test("device offline pauses local input without sending; resumed flushes it in order", async () => {
  const relay = await fakeRelay();
  const { run, rawPort } = await attach(relay);
  const client = await rawClient(rawPort);
  try {
    relay.broadcast({
      kind: "state",
      state: {
        phase: "paused",
        error: { code: "DEVICE_OFFLINE", message: "x" },
      },
    });
    await eventually(() => /device offline/.test(run.statusLine()));
    client.socket.write("queued");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(relay.frames.filter((f) => f.kind === "tx").length, 0);
    relay.broadcast({ kind: "state", state: { phase: "resumed" } });
    await eventually(() => relay.frames.some((f) => f.kind === "tx"));
    assert.equal(
      Buffer.from(
        relay.frames.find((f) => f.kind === "tx").data,
        "base64",
      ).toString(),
      "queued",
    );
  } finally {
    client.socket.destroy();
    await run.close();
    await relay.close();
  }
});

test("a dropped connection resumes with the last seen seq and keeps the local client attached", async () => {
  const relay = await fakeRelay();
  const { run, rawPort } = await attach(relay);
  const client = await rawClient(rawPort);
  try {
    relay.rx("one");
    relay.rx("two");
    await eventually(() => client.received().toString() === "onetwo");
    for (const socket of relay.sockets) socket.terminate();
    await eventually(() => relay.hellos.length === 2, { timeoutMs: 5000 });
    assert.deepEqual(relay.hellos[1], {
      resume: { sessionId: SESSION, lastSeq: 1 },
    });
    assert.equal(
      relay.requests[1].url,
      `/api/devices/target/serial/stream?resume=${SESSION}`,
      "resume is announced in the URL so the Worker can skip metering",
    );
    relay.rx("three");
    await eventually(() => client.received().toString() === "onetwothree", {
      timeoutMs: 3000,
    });
    assert.equal(run.stats().bytesLost, 0);
  } finally {
    client.socket.destroy();
    await run.close();
    await relay.close();
  }
});

test("close code 4001 ends the attach with a reclaimed error", async () => {
  const relay = await fakeRelay();
  const { run, rawPort } = await attach(relay);
  const raw = await rawClient(rawPort);
  for (const socket of relay.sockets) socket.close(4001, "reclaimed");
  const result = await run.closed;
  assert.equal(result.reason, "reclaimed");
  assert.match(result.error.message, /reclaimed/);
  await once(raw.socket, "close");
  await relay.close();
  await assert.rejects(rawClient(rawPort), /ECONNREFUSED/);
});

test("Ctrl-C style close sends state closed to the relay and stops every listener", async () => {
  const relay = await fakeRelay();
  const { run, rawPort, rfcPort } = await attach(relay);
  const result = run.close();
  await eventually(() =>
    relay.frames.some((f) => f.kind === "state" && f.state.phase === "closed"),
  );
  for (const socket of relay.sockets) socket.close(1000, "closed");
  assert.equal((await result).reason, "closed");
  await assert.rejects(rawClient(rawPort), /ECONNREFUSED/);
  await assert.rejects(rawClient(rfcPort), /ECONNREFUSED/);
  await relay.close();
});

test("--session resumes instead of opening and takes parameters from the relay", async () => {
  const relay = await fakeRelay();
  const run = await runSerialAttach(
    { device: "target", session: SESSION, rfc2217_port: "0", raw_port: "0" },
    { config: config(relay) },
  );
  try {
    assert.deepEqual(relay.hellos[0], {
      resume: { sessionId: SESSION, lastSeq: -1 },
    });
    assert.equal(run.sessionId, SESSION);
  } finally {
    await run.close();
    await relay.close();
  }
});

test("status line reports rx/tx/bytesLost and a ping-based round trip estimate", async () => {
  const relay = await fakeRelay();
  const { run } = await attach(relay);
  try {
    await eventually(() => run.stats().rttMs !== null);
    relay.rx("12345");
    await eventually(() => run.stats().rxBytes === 5);
    assert.match(
      run.statusLine(),
      /^rx 5 B {2}tx 0 B {2}lost 0 B {2}rtt \d+ ms$/,
    );
  } finally {
    await run.close();
    await relay.close();
  }
});

for (const [status, code, pattern_] of [
  [401, "UNAUTHENTICATED", /Run `anyremote remote` on this machine again/],
  [429, "RATE_LIMITED", /concurrent serial session limit/],
  [404, "NOT_FOUND", /Device not found/],
]) {
  test(`a refused upgrade (${status} ${code}) becomes a clear error`, async () => {
    const server = http.createServer();
    server.on("upgrade", (_request, socket) => {
      const body = JSON.stringify({ error: { code, message: "server text" } });
      socket.end(
        `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      await assert.rejects(
        runSerialAttach(flags(), {
          config: {
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            device: { id: "consumer" },
            deviceToken: TOKEN,
          },
        }),
        (error) => {
          assert.match(error.message, pattern_);
          assert.equal(error.code, code);
          assert.ok(!error.message.includes(TOKEN));
          return true;
        },
      );
    } finally {
      server.close();
    }
  });
}

test("an open failure reported by the relay rejects with the fixed code", async () => {
  const relay = await fakeRelay();
  relay.wss.removeAllListeners("connection");
  relay.wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      if (data.toString() === "ping") return socket.send("pong");
      const envelope = JSON.parse(data.toString());
      if (envelope.type !== "hello") return;
      socket.send(
        JSON.stringify({
          version: 1,
          type: "hello",
          requestId: envelope.requestId,
          deviceId: "consumer",
          connectionEpoch: "e",
          payload: { accepted: true },
        }),
      );
      socket.send(
        JSON.stringify({
          version: 1,
          type: "stream",
          requestId: SESSION,
          deviceId: "consumer",
          connectionEpoch: "e",
          payload: {
            sessionId: SESSION,
            seq: 0,
            kind: "state",
            state: {
              phase: "closed",
              error: {
                code: "SERIAL_PORT_BUSY",
                message: "The serial port is held by another session.",
              },
            },
          },
        }),
      );
      socket.close(1000, "open failed");
    });
  });
  await assert.rejects(
    runSerialAttach(flags(), { config: config(relay) }),
    (error) => error.code === "SERIAL_PORT_BUSY",
  );
  await relay.close();
});

test("--pty starts the injected PTY helper against the raw port and reports a missing socat", async () => {
  const relay = await fakeRelay();
  const started = [];
  const messages = [];
  const first = await runSerialAttach(flags({ pty: "~/tty/esp32" }), {
    config: config(relay),
    startPty: ({ link, rawPort }) => {
      started.push({ link, rawPort });
      return { started: true, link: "/home/u/tty/esp32", stop() {} };
    },
  });
  assert.equal(started.length, 1);
  assert.equal(first.urls.pty, "/home/u/tty/esp32");
  assert.equal(
    started[0].rawPort,
    Number(new URL(first.urls.raw.replace("socket:", "tcp:")).port),
  );
  await first.close();
  const second = await runSerialAttach(flags({ pty: "/tmp/link" }), {
    config: config(relay),
    startPty: () => ({ started: false, message: SOCAT_MISSING_MESSAGE }),
  });
  second.events.on("warning", (m) => messages.push(m));
  assert.equal(second.urls.pty, undefined);
  await second.close();
  await relay.close();
});

test("startSocatPty builds the socat command or explains how to get it", () => {
  const missing = startSocatPty({
    link: "/tmp/x",
    rawPort: 1,
    detect: () => false,
  });
  assert.equal(missing.started, false);
  assert.match(missing.message, /socat/);
  assert.match(missing.message, /fixed parameters|fixed/);
  const calls = [];
  const fake = {
    on() {},
    kill() {
      calls.push("kill");
    },
  };
  const ok = startSocatPty({
    link: "~/tty/a",
    rawPort: 5555,
    detect: () => true,
    home: "/home/u",
    spawn: (command, args) => {
      calls.push([command, args]);
      return fake;
    },
  });
  assert.equal(ok.started, true);
  assert.deepEqual(calls[0], [
    "socat",
    ["pty,raw,echo=0,link=/home/u/tty/a", "tcp:127.0.0.1:5555"],
  ]);
  ok.stop();
  assert.equal(calls[1], "kill");
  assert.equal(typeof hasSocat(), "boolean");
});
