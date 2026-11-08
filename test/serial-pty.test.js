import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalToolExecutor } from "../src/local-tools.js";
import { startPtyDevice } from "./helpers/pty-device.js";

// 真实 serialport 绑定 + 真实 PTY；不可用时给出明确的跳过原因。
test("real serialport talks to a real PTY pair", async (t) => {
  if (process.versions.bun)
    return t.skip("serialport open() panics under Bun; run with node --test");
  const device = await startPtyDevice();
  if (device.reason) return t.skip(device.reason);
  const executor = createLocalToolExecutor({ serialAllow: [device.path] });
  try {
    if (!(await executor.prepare()))
      return t.skip("serialport native binding is not installed");
    assert.deepEqual(executor.capabilities(), ["serial", "serial.stream"]);
    const session = await executor.execute("serial.open", {
      path: device.path,
      baudRate: 115200,
    });
    const busy = await executor
      .execute("serial.open", { path: device.path })
      .catch((e) => e);
    assert.equal(busy.code, "SERIAL_PORT_BUSY");

    const reply = await executor.execute("serial.transact", {
      sessionId: session.sessionId,
      data: "ping",
      eol: "\n",
      until: "echo:ping\n",
      waitMs: 5000,
    });
    assert.equal(reply.matched, true, JSON.stringify(reply));
    assert.equal(reply.data, "echo:ping\n");

    const bytes = await executor.execute("serial.transact", {
      sessionId: session.sessionId,
      data: "00ff7f",
      encoding: "hex",
      until: "/echo:/",
      waitMs: 5000,
    });
    assert.equal(bytes.encoding, "hex");
    assert.match(bytes.data, /^6563686f3a/);

    const baud = await executor.execute("serial.control", {
      sessionId: session.sessionId,
      baudRate: 9600,
    });
    assert.equal(baud.applied, 1);
    await executor.execute("serial.close", { sessionId: session.sessionId });
    const again = await executor.execute("serial.open", { path: device.path });
    assert.equal(again.state, "open");
  } finally {
    await executor.shutdown();
    await device.close();
  }
});
