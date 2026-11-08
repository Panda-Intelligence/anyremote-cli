import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";

/** 可编排接收数据、故障注入和调制解调器状态的假串口。 */
export class FakePort extends EventEmitter {
  constructor(path, params) {
    super();
    this.path = path;
    this.params = params;
    this.isOpen = true;
    this.written = [];
    this.calls = [];
    this.modem = { cts: false, dsr: false, dcd: false, ri: false };
    this.writeDelayMs = 0;
    this.writeError = null;
    this.closeCount = 0;
    this.timers = new Set();
  }

  push(data) {
    this.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  /** schedule: [{ at: ms, data }]，相对调用时刻。 */
  script(schedule) {
    for (const { at, data } of schedule) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.push(data);
      }, at);
      this.timers.add(timer);
    }
  }

  unplug(error = new Error("device disconnected")) {
    this.isOpen = false;
    this.emit("error", error);
    this.emit("close");
  }

  async write(buffer) {
    if (!this.isOpen) throw new Error("Port is not open");
    if (this.writeError) throw this.writeError;
    if (this.writeDelayMs)
      await new Promise((r) => setTimeout(r, this.writeDelayMs));
    this.written.push(Buffer.from(buffer));
    this.calls.push({ op: "write", at: performance.now() });
    this.onWrite?.(Buffer.from(buffer));
  }

  async drain() {}

  async set(options) {
    if (!this.isOpen) throw new Error("Port is not open");
    this.calls.push({ op: "set", options, at: performance.now() });
  }

  async get() {
    if (!this.isOpen) throw new Error("Port is not open");
    return { ...this.modem };
  }

  async update(options) {
    this.calls.push({ op: "update", options, at: performance.now() });
  }

  async flush() {
    this.calls.push({ op: "flush", at: performance.now() });
  }

  async close() {
    this.closeCount += 1;
    this.isOpen = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  get writtenText() {
    return Buffer.concat(this.written).toString("utf8");
  }
}

export function createFakeBinding({
  ports = [
    { path: "/dev/cu.fake0", manufacturer: "Fake", serialNumber: "A1" },
    { path: "/dev/cu.fake1" },
    { path: "/dev/other" },
  ],
  loadError = null,
} = {}) {
  const opened = [];
  const openErrors = new Map();
  const binding = {
    opened,
    openErrors,
    async available() {
      return loadError === null;
    },
    async list() {
      if (loadError) throw loadError;
      return ports.map((port) => ({ ...port }));
    },
    async open(params) {
      if (loadError) throw loadError;
      const failure = openErrors.get(params.path);
      if (failure) throw failure;
      if (!ports.some((port) => port.path === params.path))
        throw Object.assign(new Error("No such file or directory"), {
          code: "ENOENT",
        });
      const port = new FakePort(params.path, params);
      opened.push(port);
      return port;
    },
    get last() {
      return opened.at(-1);
    },
  };
  return binding;
}

export async function eventually(check, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
