import { ToolError } from "../errors.js";

export const SERIAL_UNAVAILABLE_MESSAGE =
  "Serial support is unavailable on this device (serial module failed to load)";
export const SERIAL_BUN_UNSUPPORTED_MESSAGE =
  "Serial support requires running the AnyRemote CLI with Node, for example: npx @panda-ai/anyremote@latest remote --serial-allow <globs>. The Bun runtime cannot open serial ports.";

/** Bun 1.4 opens serialport via an unsupported libuv call and panics the whole process. */
export function detectSerialRuntime(versions = process.versions) {
  return versions?.bun ? "bun" : "node";
}

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) =>
      error ? reject(error) : resolve(value),
    );
  });
}

function adapt(port) {
  return {
    write: (buffer) => call(port, "write", buffer),
    drain: () => call(port, "drain"),
    set: (options) => call(port, "set", options),
    get: async () => {
      const status = await call(port, "get");
      return {
        cts: Boolean(status?.cts),
        dsr: Boolean(status?.dsr),
        dcd: Boolean(status?.dcd),
        ri: false,
      };
    },
    update: (options) => call(port, "update", options),
    flush: () => call(port, "flush"),
    close: () =>
      port.isOpen ? call(port, "close") : Promise.resolve(undefined),
    on: (event, listener) => {
      port.on(event, listener);
    },
    get isOpen() {
      return port.isOpen;
    },
  };
}

/**
 * serialport 在首次使用时才动态加载；加载失败只影响 serial 能力。
 * @param {{ importer?: () => Promise<any> }} [options]
 */
export function createSerialBinding({
  importer = () => import("serialport"),
  runtime = detectSerialRuntime(),
} = {}) {
  let loaded;

  async function load() {
    if (loaded) return loaded;
    if (runtime === "bun")
      throw new ToolError(
        "CONFIGURATION_ERROR",
        SERIAL_BUN_UNSUPPORTED_MESSAGE,
      );
    try {
      const module = await importer();
      const SerialPort = module?.SerialPort ?? module?.default?.SerialPort;
      if (typeof SerialPort?.list !== "function")
        throw new Error("serialport exports are missing");
      loaded = SerialPort;
      return loaded;
    } catch {
      throw new ToolError("CONFIGURATION_ERROR", SERIAL_UNAVAILABLE_MESSAGE);
    }
  }

  return {
    async available() {
      try {
        await load();
        return true;
      } catch {
        return false;
      }
    },

    async list() {
      const SerialPort = await load();
      const ports = await SerialPort.list();
      return ports.map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId,
        productId: port.productId,
      }));
    },

    async open(params) {
      const SerialPort = await load();
      const port = new SerialPort({
        path: params.path,
        baudRate: params.baudRate,
        dataBits: params.dataBits,
        stopBits: params.stopBits,
        parity: params.parity,
        rtscts: params.flowControl === "rtscts",
        xon: params.flowControl === "xonxoff",
        xoff: params.flowControl === "xonxoff",
        autoOpen: false,
      });
      await call(port, "open");
      return adapt(port);
    },
  };
}
