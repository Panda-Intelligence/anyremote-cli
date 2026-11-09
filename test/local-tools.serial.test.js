import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  serialReadResultSchema,
  serialSessionSchema,
} from "@anyremote/contracts";
import { ToolError } from "../src/errors.js";
import { createLocalToolExecutor } from "../src/local-tools.js";
import {
  createSerialSessionLogger,
  formatSerialSessionLog,
} from "../src/request-log.js";
import { createSerialBinding } from "../src/serial/binding.js";
import { createFakeBinding } from "./helpers/fake-serial.js";

const make = (options = {}) =>
  createLocalToolExecutor({
    serialBinding: createFakeBinding(),
    serialAllow: ["/dev/cu.*"],
    serialRealpath: async (p) => p,
    deviceId: "dev-1",
    ...options,
  });

async function code(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return "none";
}

test("an empty allowlist denies serial access and advertises nothing", async () => {
  const executor = createLocalToolExecutor({
    serialBinding: createFakeBinding(),
    serialAllow: [],
  });
  assert.equal(await executor.prepare(), false);
  assert.deepEqual(executor.capabilities(), []);
  assert.deepEqual(await executor.execute("serial.ports", {}), {
    ports: [],
    hint: "serial_disabled",
  });
  assert.equal(
    await code(executor.execute("serial.open", { path: "/dev/cu.fake0" })),
    "FORBIDDEN",
  );
  await executor.shutdown();
});

test("capabilities are advertised only when allowed and the module loads", async () => {
  const ok = make();
  assert.deepEqual(ok.capabilities(), [], "unknown until prepared");
  await ok.prepare();
  assert.deepEqual(ok.capabilities(), ["serial", "serial.stream"]);
  const noStream = make({ streamEnabled: false });
  await noStream.prepare();
  assert.deepEqual(noStream.capabilities(), ["serial"]);
  const broken = make({
    serialBinding: createFakeBinding({
      loadError: new ToolError("CONFIGURATION_ERROR", "x"),
    }),
  });
  await broken.prepare();
  assert.deepEqual(broken.capabilities(), []);
});

test("ports lists only allowlisted ports and open rejects other paths", async () => {
  const executor = make();
  const { ports } = await executor.execute("serial.ports", {});
  assert.deepEqual(
    ports.map((p) => p.path),
    ["/dev/cu.fake0", "/dev/cu.fake1"],
  );
  assert.equal(ports[0].manufacturer, "Fake");
  assert.equal("allowed" in ports[0], false);
  assert.equal(
    await code(executor.execute("serial.open", { path: "/dev/other" })),
    "FORBIDDEN",
  );
  // 规范路径同样参与判断：符号链接指向被允许的设备。
  const aliased = make({
    serialBinding: createFakeBinding({ ports: [{ path: "/tmp/link" }] }),
    serialAllow: ["/dev/ttyUSB0"],
    serialRealpath: async () => "/dev/ttyUSB0",
  });
  assert.equal(
    (await aliased.execute("serial.open", { path: "/tmp/link" })).state,
    "open",
  );
  await aliased.shutdown();
  await executor.shutdown();
});

test("binding load failure maps to CONFIGURATION_ERROR with fixed text", async () => {
  const executor = createLocalToolExecutor({
    serialAllow: ["/dev/cu.*"],
    serialRealpath: async (p) => p,
    serialBinding: createSerialBinding({
      importer: async () => {
        throw new Error("Cannot find module '/secret/path/bindings.node'");
      },
    }),
  });
  for (const [tool, args] of [
    ["serial.ports", {}],
    ["serial.open", { path: "/dev/cu.x" }],
  ]) {
    const error = await executor.execute(tool, args).catch((e) => e);
    assert.equal(error.code, "CONFIGURATION_ERROR");
    assert.match(
      error.message,
      /^Serial support is unavailable on this device/,
    );
    assert.doesNotMatch(error.message, /secret/);
  }
  assert.equal(await executor.prepare(), false);
});

test("every serial tool returns output that matches the shared schemas", async () => {
  const executor = make();
  await executor.prepare();
  const session = serialSessionSchema.parse(
    await executor.execute("serial.open", {
      path: "/dev/cu.fake0",
      baudRate: 9600,
    }),
  );
  assert.equal(session.params.baudRate, 9600);
  assert.equal(session.params.dataBits, 8);
  const binding = executor.serial.binding;
  binding.last.push("boot\n");
  const read = serialReadResultSchema.parse(
    await executor.execute("serial.read", {
      sessionId: session.sessionId,
      waitMs: 0,
    }),
  );
  assert.equal(read.data, "boot\n");
  assert.deepEqual(
    await executor.execute("serial.write", {
      sessionId: session.sessionId,
      data: "go",
      eol: "\n",
    }),
    { bytesWritten: 3, txBytes: 3 },
  );
  binding.last.onWrite = () => setTimeout(() => binding.last.push("OK\n"), 5);
  const tx = serialReadResultSchema.parse(
    await executor.execute("serial.transact", {
      sessionId: session.sessionId,
      data: "AT",
      eol: "\r",
      until: "OK",
      waitMs: 500,
    }),
  );
  assert.equal(tx.matched, true);
  const control = await executor.execute("serial.control", {
    sessionId: session.sessionId,
    dtr: true,
  });
  assert.equal(control.applied, 1);
  assert.equal(
    serialSessionSchema
      .array()
      .parse((await executor.execute("serial.sessions", {})).sessions).length,
    1,
  );
  assert.equal(executor.serialSessions().length, 1);
  assert.deepEqual(
    await executor.execute("serial.close", { sessionId: session.sessionId }),
    {
      closed: true,
      sessionId: session.sessionId,
    },
  );
  assert.equal(
    await code(
      executor.execute("serial.read", { sessionId: session.sessionId }),
    ),
    "NOT_FOUND",
  );
  await executor.shutdown();
});

test("invalid arguments, busy and missing devices map to stable error codes", async () => {
  const executor = make();
  assert.equal(
    await code(
      executor.execute("serial.open", { path: "/dev/cu.fake0", baudRate: 10 }),
    ),
    "VALIDATION_ERROR",
  );
  assert.equal(
    await code(
      executor.execute("serial.open", { path: "/dev/cu.fake0", extra: 1 }),
    ),
    "VALIDATION_ERROR",
  );
  assert.equal(
    await code(executor.execute("serial.open", {})),
    "VALIDATION_ERROR",
  );
  assert.equal(
    await code(executor.execute("serial.read", {})),
    "VALIDATION_ERROR",
  );
  assert.equal(
    await code(executor.execute("serial.read", { sessionId: "nope" })),
    "NOT_FOUND",
  );
  assert.equal(
    await code(executor.execute("serial.open", { path: "/dev/cu.absent" })),
    "NOT_FOUND",
  );

  const { openErrors } = executor.serial.binding;
  openErrors.set(
    "/dev/cu.fake0",
    Object.assign(new Error("Resource temporarily unavailable"), {
      code: "EBUSY",
    }),
  );
  assert.equal(
    await code(executor.execute("serial.open", { path: "/dev/cu.fake0" })),
    "SERIAL_PORT_BUSY",
  );
  openErrors.set(
    "/dev/cu.fake0",
    Object.assign(new Error("Permission denied"), { code: "EACCES" }),
  );
  assert.equal(
    await code(executor.execute("serial.open", { path: "/dev/cu.fake0" })),
    "FORBIDDEN",
  );
  openErrors.delete("/dev/cu.fake0");
  await executor.execute("serial.open", { path: "/dev/cu.fake0" });
  const busy = await executor
    .execute("serial.open", { path: "/dev/cu.fake0" })
    .catch((e) => e);
  assert.equal(busy.code, "SERIAL_PORT_BUSY");
  assert.equal(busy.details.holder, "mcp");
  await executor.shutdown();
});

test("executor shutdown closes serial ports and rejects new opens", async () => {
  const executor = make();
  await executor.execute("serial.open", { path: "/dev/cu.fake0" });
  const port = executor.serial.binding.last;
  await executor.shutdown();
  assert.equal(port.closeCount, 1);
  assert.equal(
    await code(executor.execute("serial.open", { path: "/dev/cu.fake1" })),
    "CONFLICT",
  );
});

test("the binding adapter wraps the serialport callback API lazily", async () => {
  const calls = [];
  class FakeSerialPort extends EventEmitter {
    static async list() {
      return [
        {
          path: "/dev/x",
          manufacturer: "M",
          pnpId: "ignored",
          vendorId: "1a86",
        },
      ];
    }

    constructor(options) {
      super();
      calls.push(["new", options]);
      this.isOpen = false;
    }

    open(cb) {
      this.isOpen = true;
      cb(null);
    }

    write(buffer, cb) {
      calls.push(["write", buffer.toString()]);
      cb(null);
    }

    drain(cb) {
      cb(null);
    }

    set(options, cb) {
      calls.push(["set", options]);
      cb(null);
    }

    get(cb) {
      cb(null, { cts: true, dsr: false, dcd: true });
    }

    update(options, cb) {
      calls.push(["update", options]);
      cb(null);
    }

    flush(cb) {
      cb(null);
    }

    close(cb) {
      this.isOpen = false;
      cb(null);
    }
  }
  let imports = 0;
  const binding = createSerialBinding({
    importer: async () => {
      imports += 1;
      return { SerialPort: FakeSerialPort };
    },
  });
  assert.equal(imports, 0, "nothing loads until used");
  assert.deepEqual(await binding.list(), [
    {
      path: "/dev/x",
      manufacturer: "M",
      serialNumber: undefined,
      vendorId: "1a86",
      productId: undefined,
    },
  ]);
  const port = await binding.open({
    path: "/dev/x",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "rtscts",
  });
  assert.equal(imports, 1);
  assert.equal(calls[0][1].rtscts, true);
  assert.equal(calls[0][1].autoOpen, false);
  await port.write(Buffer.from("hi"));
  await port.set({ dtr: true });
  await port.update({ baudRate: 57600 });
  assert.deepEqual(await port.get(), {
    cts: true,
    dsr: false,
    dcd: true,
    ri: false,
  });
  await port.close();
  assert.equal(port.isOpen, false);
});

test("the session counters line carries no path, data or arguments", () => {
  const lines = [];
  createSerialSessionLogger({ write: (l) => lines.push(l), now: () => 0 })({
    sessionId: "s-1",
    path: "/dev/cu.SECRET",
    data: "password",
    rxBytes: 10,
    txBytes: 4,
    bytesLost: 1,
    durationMs: 12.7,
    reason: "idle",
  });
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "1970-01-01T00:00:00.000Z",
    event: "serial.session.closed",
    sessionId: "s-1",
    path: "<redacted>",
    rxBytes: 10,
    txBytes: 4,
    bytesLost: 1,
    durationMs: 13,
  });
  assert.doesNotMatch(lines[0], /SECRET|password/);
  assert.equal(formatSerialSessionLog(null), null);
});

test("on macOS the listing offers the cu callout node and judges each path alone", async () => {
  const build = (allow) =>
    make({
      serialBinding: createFakeBinding({
        ports: [{ path: "/dev/tty.usbmodem1" }, { path: "/dev/tty.nocallout" }],
      }),
      serialAllow: allow,
      serialPlatform: "darwin",
      serialExists: async (p) => {
        if (p !== "/dev/cu.usbmodem1") throw new Error("ENOENT");
      },
    });
  const cu = build(["/dev/cu.*"]);
  assert.deepEqual(
    (await cu.execute("serial.ports", {})).ports.map((p) => p.path),
    ["/dev/cu.usbmodem1"],
  );
  const tty = build(["/dev/tty.*"]);
  assert.deepEqual(
    (await tty.execute("serial.ports", {})).ports.map((p) => p.path),
    ["/dev/tty.usbmodem1", "/dev/tty.nocallout"],
  );
  const candidates = await cu.serial.candidates();
  assert.deepEqual(
    candidates.map((c) => [c.path, c.allowed]),
    [
      ["/dev/cu.usbmodem1", true],
      ["/dev/tty.usbmodem1", false],
      ["/dev/tty.nocallout", false],
    ],
  );
  assert.equal(
    await code(cu.execute("serial.open", { path: "/dev/tty.usbmodem1" })),
    "FORBIDDEN",
  );
});

test("serial binding refuses to load under the Bun runtime", async () => {
  let imports = 0;
  const binding = createSerialBinding({
    importer: async () => {
      imports += 1;
      return {};
    },
    runtime: "bun",
  });
  assert.equal(await binding.available(), false);
  const error = await binding.list().catch((e) => e);
  assert.equal(error.code, "CONFIGURATION_ERROR");
  assert.match(error.message, /Node/);
  assert.equal(imports, 0);
  const executor = createLocalToolExecutor({
    serialBinding: binding,
    serialAllow: ["/dev/cu.*"],
  });
  assert.equal(await executor.prepare(), false);
  assert.deepEqual(executor.capabilities(), []);
});
