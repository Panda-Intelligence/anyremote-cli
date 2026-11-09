import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import {
  MAX_STREAM_FRAME_BYTES,
  PROTOCOL_VERSION,
  SERIAL_STREAM_GRACE_MS,
  STREAM_CLOSE_RECLAIMED,
  STREAM_WINDOW_BYTES,
  serialOpenParamsSchema,
} from "@anyremote/contracts";
import WebSocket from "ws";
import { ApiClient } from "../client.js";
import { loadConfig } from "../config.js";
import {
  createControlCoalescer,
  DEFAULT_CONTROL_COALESCE_MS,
  MAX_CONTROL_COALESCE_MS,
} from "./control-coalescer.js";
import { startSocatPty } from "./pty.js";
import { createRfc2217Connection, MODEM_STATE } from "./rfc2217.js";

/**
 * `anyremote serial attach`（2026-11-08）：消费者机器上的本地端点，把远端串口经 Worker DO 中继到
 * RFC2217 / raw TCP / PTY。只监听 127.0.0.1；载荷与令牌不进入任何输出。
 */

export const ACK_BYTES = 64 * 1024;
export const ACK_INTERVAL_MS = 500;
export const TX_COALESCE_MS = 5;
export const TX_HIGH_WATER = 256 * 1024;
export const TX_LOW_WATER = 64 * 1024;
export const PING_INTERVAL_MS = 2000;
export const STATUS_INTERVAL_MS = 1000;
/** 合成的线状态：设备不流式上报 CTS/DSR/DCD，这里固定为“已就绪”。 */
const SYNTHETIC_MODEM_STATE =
  MODEM_STATE.CTS | MODEM_STATE.DSR | MODEM_STATE.DCD;

export const NOT_ENROLLED_MESSAGE =
  "This computer is not enrolled. Run `anyremote remote` on this machine first.";

const UPGRADE_MESSAGES = {
  UNAUTHENTICATED: `This computer's device credential was rejected. Run \`anyremote remote\` on this machine again.`,
  NOT_FOUND: "Device not found for this account.",
  RATE_LIMITED: "Your plan's concurrent serial session limit has been reached.",
  QUOTA_EXCEEDED: "The monthly usage quota has been reached.",
  DEVICE_OFFLINE: "The target device is offline.",
  CONFIGURATION_ERROR:
    "Serial streaming is not enabled on the target device. Restart its CLI with --serial-allow.",
  VALIDATION_ERROR: "That device cannot be attached from this computer.",
};

function toInteger(name, value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`);
  return number;
}

function toPort(name, value, fallback) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`--${name} must be a port from 0 to 65535`);
  return port;
}

/** 把命令行参数转成 `hello.open`（或 `resume`）载荷。 */
export function buildHello(flags, lastSeq = -1) {
  if (flags.session !== undefined) {
    if (typeof flags.session !== "string")
      throw new Error("--session requires a session id");
    return { resume: { sessionId: flags.session, lastSeq } };
  }
  if (typeof flags.path !== "string" || flags.path.length === 0)
    throw new Error("--path <serial port> is required");
  const input = { path: flags.path };
  const optional = {
    baudRate: toInteger("baud", flags.baud),
    dataBits: toInteger("data", flags.data),
    stopBits: toInteger("stop", flags.stop),
  };
  for (const [key, value] of Object.entries(optional))
    if (value !== undefined) input[key] = value;
  if (flags.parity !== undefined) input.parity = String(flags.parity);
  if (flags.flow !== undefined) input.flowControl = String(flags.flow);
  const parsed = serialOpenParamsSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Invalid serial parameters: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  return { open: parsed.data };
}

async function readUpgradeError(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 4096) break;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
  } catch {
    return undefined;
  }
}

function upgradeError(status, error) {
  const code = error?.code;
  const message =
    (code && UPGRADE_MESSAGES[code]) ||
    (status === 401
      ? UPGRADE_MESSAGES.UNAUTHENTICATED
      : `The relay refused the connection (HTTP ${status}).`);
  const failure = new Error(message);
  failure.code = code ?? "UPGRADE_REFUSED";
  failure.status = status;
  return failure;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

class SerialAttach extends EventEmitter {
  constructor(flags, deps) {
    super();
    this.flags = flags;
    this.deps = deps;
    this.WebSocketImpl = deps.WebSocketImpl ?? WebSocket;
    this.netImpl = deps.net ?? net;
    this.now = deps.now ?? (() => Date.now());
    this.ws = null;
    this.epoch = null;
    this.sessionId = null;
    this.session = null;
    this.lastSeq = -1;
    this.txSeq = 0;
    this.live = false;
    this.deviceOffline = false;
    this.closing = false;
    this.finished = false;
    this.listenersStarted = false;
    this.reconnecting = false;
    this.stats = {
      rxBytes: 0,
      txBytes: 0,
      bytesLost: 0,
      gaps: 0,
      lossUnknown: false,
      rxDiscarded: 0,
      txUnknown: 0,
      rttMs: null,
    };
    this.rfcServer = null;
    this.rawServer = null;
    this.rfc = null;
    this.rawClient = null;
    this.ackUnsent = 0;
    this.ackTimer = null;
    this.statusTimer = null;
    this.pingTimer = null;
    this.pingSentAt = 0;
    this.txBuffers = [];
    this.txBufferedBytes = 0;
    this.txTimer = null;
    this.wsPending = 0;
    this.localPaused = false;
    this.pty = null;
    this.urls = {};
    this.openedWaiter = null;
    const controlCoalesceMs =
      flags.control_coalesce_ms === undefined
        ? DEFAULT_CONTROL_COALESCE_MS
        : Number(flags.control_coalesce_ms);
    if (
      !Number.isInteger(controlCoalesceMs) ||
      controlCoalesceMs < 0 ||
      controlCoalesceMs > MAX_CONTROL_COALESCE_MS
    )
      throw new Error(
        `--control-coalesce-ms must be an integer from 0 to ${MAX_CONTROL_COALESCE_MS}`,
      );
    this.coalescer = createControlCoalescer({
      windowMs: controlCoalesceMs,
      send: (control) => this.sendFrame({ kind: "control", control }),
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  // ---- startup ----

  async start() {
    const config = this.deps.config ?? (await loadConfig());
    const consumerId = config.device?.id;
    const deviceToken = config.deviceToken;
    if (!consumerId || !deviceToken) throw new Error(NOT_ENROLLED_MESSAGE);
    const baseUrl =
      this.flags.base_url || config.baseUrl || this.deps.env?.ANYREMOTE_URL;
    if (!baseUrl) throw new Error(NOT_ENROLLED_MESSAGE);
    if (typeof this.flags.device !== "string" || !this.flags.device)
      throw new Error("--device <id|name> is required");
    this.consumerId = consumerId;
    this.deviceToken = deviceToken;
    this.api = new ApiClient({
      baseUrl,
      token: config.accessToken,
      cookie: config.sessionCookie,
    });
    this.targetId = await this.resolveTarget(config);
    this.hello = buildHello(this.flags, -1);
    this.rfc2217Port = toPort("rfc2217-port", this.flags.rfc2217_port, 4000);
    this.rawPort = toPort("raw-port", this.flags.raw_port, 0);
    await new Promise((resolve, reject) => {
      this.openedWaiter = { resolve, reject };
      this.connect(this.hello);
    });
    return this;
  }

  /** 设备 id 直接可用；名称需要账号登录态（设备凭据不能列设备）。 */
  async resolveTarget(config) {
    const wanted = this.flags.device;
    if (!config.accessToken && !config.sessionCookie) return wanted;
    try {
      const { devices } = await (this.deps.listDevices?.() ??
        this.api.listDevices());
      const byId = devices.find((device) => device.id === wanted);
      if (byId) return byId.id;
      const byName = devices.filter(
        (device) => device.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (byName.length === 1) return byName[0].id;
      if (byName.length > 1)
        throw new Error(
          `More than one device is named "${wanted}". Use the device id.`,
        );
    } catch (error) {
      if (error.message?.startsWith("More than one")) throw error;
      // 无法列出设备（令牌过期、离线）：按 id 继续，由 Worker 决定是否 NOT_FOUND。
    }
    return wanted;
  }

  // ---- WebSocket ----

  connect(helloPayload) {
    const url = this.api.serialStreamUrl(this.targetId, {
      resume: helloPayload.resume?.sessionId,
    });
    const socket = new this.WebSocketImpl(url, {
      headers: {
        authorization: `Bearer ${this.deviceToken}`,
        "x-anyremote-consumer-device-id": this.consumerId,
      },
    });
    this.ws = socket;
    this.epoch = "pending";
    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.sendEnvelope("hello", randomUUID(), helloPayload, "pending");
      this.startPing();
    });
    socket.on("message", (data, isBinary) => {
      if (this.ws !== socket) return;
      this.onMessage(isBinary ? "" : data.toString("utf8"));
    });
    socket.on("unexpected-response", (_request, response) => {
      if (this.ws !== socket) return;
      readUpgradeError(response).then((error) => {
        this.onUpgradeRefused(upgradeError(response.statusCode, error));
      });
    });
    socket.on("error", (error) => {
      if (this.ws !== socket) return;
      this.emit("warning", error.message);
    });
    socket.on("close", (code) => {
      if (this.ws !== socket) return;
      this.onSocketClosed(code);
    });
  }

  onUpgradeRefused(error) {
    this.ws = null;
    if (this.openedWaiter) {
      this.openedWaiter.reject(error);
      this.openedWaiter = null;
      return;
    }
    if (this.reconnecting) {
      // 凭据被撤销、目标不存在或套餐变化：重试没有意义。
      if (error.status === 401 || error.status === 404)
        this.finish("refused", error);
      return;
    }
    this.finish("refused", error);
  }

  sendEnvelope(type, requestId, payload, epoch = this.epoch) {
    const socket = this.ws;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return false;
    socket.send(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type,
        requestId,
        deviceId: this.consumerId,
        connectionEpoch: epoch,
        payload,
      }),
    );
    return true;
  }

  /** 发送一个 stream 帧；返回写入前的挂起字节数用于背压。 */
  sendFrame(frame, bytes = 0) {
    const socket = this.ws;
    if (
      !this.sessionId ||
      !socket ||
      socket.readyState !== this.WebSocketImpl.OPEN ||
      this.epoch === "pending"
    )
      return false;
    const text = JSON.stringify({
      version: PROTOCOL_VERSION,
      type: "stream",
      requestId: this.sessionId,
      deviceId: this.consumerId,
      connectionEpoch: this.epoch,
      payload: { sessionId: this.sessionId, seq: this.txSeq, ...frame },
    });
    this.txSeq += 1;
    if (bytes > 0) {
      this.wsPending += bytes;
      socket.send(text, (error) => {
        this.wsPending -= bytes;
        if (error) this.stats.txUnknown += bytes;
        else this.stats.txBytes += bytes;
        this.maybeResumeLocal();
      });
    } else socket.send(text);
    return true;
  }

  onMessage(text) {
    if (text === "pong") {
      if (this.pingSentAt) {
        const rtt = performance.now() - this.pingSentAt;
        this.stats.rttMs =
          this.stats.rttMs === null ? rtt : this.stats.rttMs * 0.7 + rtt * 0.3;
        this.pingSentAt = 0;
      }
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    if (envelope?.version !== PROTOCOL_VERSION) return;
    if (envelope.type === "hello") {
      if (envelope.payload?.accepted === true)
        this.epoch = envelope.connectionEpoch;
      return;
    }
    if (envelope.type !== "stream" || !envelope.payload) return;
    this.onFrame(envelope.payload);
  }

  // ---- frames from the relay ----

  onFrame(frame) {
    if (typeof frame.seq === "number" && frame.seq > this.lastSeq) {
      if (
        frame.kind === "rx" &&
        this.lastSeq >= 0 &&
        frame.seq !== this.lastSeq + 1
      )
        this.stats.gaps += 1;
      this.lastSeq = frame.seq;
    }
    if (frame.kind === "rx") {
      this.onRx(frame);
      return;
    }
    if (frame.kind !== "state" || !frame.state) return;
    const { phase, error, bytesLost, session } = frame.state;
    if (typeof bytesLost === "number") this.stats.bytesLost += bytesLost;
    if (error?.code === "OUTCOME_UNKNOWN") {
      this.stats.lossUnknown = true;
      this.emit(
        "warning",
        "Some serial data may have been lost while reconnecting.",
      );
    }
    if (phase === "opened") this.onOpened(frame.sessionId, session);
    else if (phase === "resumed") {
      if (!this.listenersStarted) {
        // `--session` 续传一个已存在的会话：参数来自中继，之后与新开会话相同。
        this.onOpened(frame.sessionId, session);
        return;
      }
      this.deviceOffline = false;
      this.live = true;
      this.finishReconnect();
      this.flushTx();
      this.maybeResumeLocal();
      this.emit("state", "resumed");
    } else if (phase === "paused") {
      if (error?.code === "DEVICE_OFFLINE") {
        this.deviceOffline = true;
        this.emit("state", "device-offline");
      } else this.emit("state", "paused");
    } else if (phase === "closed" || phase === "lost") {
      const failure = error
        ? Object.assign(new Error(error.message), { code: error.code })
        : undefined;
      if (this.openedWaiter && !this.sessionId) {
        this.openedWaiter.reject(
          failure ?? new Error("The relay closed the stream."),
        );
        this.openedWaiter = null;
        this.finish("closed-before-open", failure);
        return;
      }
      if (phase === "closed" && !failure) {
        // 正常关闭帧之后紧跟 WebSocket close：4001 表示被回收，所以等 close 事件决定原因。
        const timer = setTimeout(() => this.finish("closed"), 1000);
        timer.unref?.();
        return;
      }
      this.finish(phase, failure);
    }
  }

  onOpened(sessionId, session) {
    this.sessionId = sessionId;
    this.session = session;
    this.live = true;
    this.txSeq = 0;
    void this.startLocal()
      .then(() => {
        this.openedWaiter?.resolve();
        this.openedWaiter = null;
        this.startTimers();
        this.emit("opened", { sessionId, urls: this.urls });
      })
      .catch((error) => {
        this.openedWaiter?.reject(error);
        this.openedWaiter = null;
        void this.close();
      });
  }

  onRx(frame) {
    const data = Buffer.from(frame.data, "base64");
    this.stats.rxBytes += data.length;
    if (typeof frame.state?.bytesLost === "number")
      this.stats.bytesLost += frame.state.bytesLost;
    this.deliver(data);
  }

  deliver(data) {
    const sinks = [];
    if (this.rfc && !this.rfc.socket.destroyed)
      sinks.push({
        ok: this.rfc.connection.writeRx(data),
        socket: this.rfc.socket,
      });
    if (this.rawClient && !this.rawClient.destroyed)
      sinks.push({ ok: this.rawClient.write(data), socket: this.rawClient });
    if (sinks.length === 0) this.stats.rxDiscarded += data.length;
    const waiting = sinks.filter((sink) => !sink.ok);
    if (waiting.length === 0) {
      this.consumed(data.length);
      return;
    }
    // 本地客户端写缓冲已满：等它们 drain（或断开）之后才确认，窗口会反压到设备。
    let remaining = waiting.length;
    for (const sink of waiting) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        remaining -= 1;
        if (remaining === 0) this.consumed(data.length);
      };
      sink.socket.once("drain", release);
      sink.socket.once("close", release);
    }
  }

  consumed(bytes) {
    this.ackUnsent += bytes;
    if (this.ackUnsent >= ACK_BYTES) this.sendAck();
  }

  sendAck() {
    while (this.ackUnsent > 0) {
      const credit = Math.min(this.ackUnsent, STREAM_WINDOW_BYTES);
      if (!this.sendFrame({ kind: "ack", credit })) return;
      this.ackUnsent -= credit;
    }
  }

  // ---- local endpoints ----

  async startLocal() {
    if (this.listenersStarted) return;
    this.listenersStarted = true;
    const params = this.session?.params ?? {};
    const settings = {
      baudRate: params.baudRate ?? 115200,
      dataBits: params.dataBits ?? 8,
      parity: params.parity ?? "none",
      stopBits: params.stopBits ?? 1,
      flowControl: params.flowControl ?? "none",
    };
    this.rfcServer = this.netImpl.createServer((socket) =>
      this.onRfcClient(socket, settings),
    );
    this.rawServer = this.netImpl.createServer((socket) =>
      this.onRawClient(socket),
    );
    await Promise.all([
      this.listen(this.rfcServer, this.rfc2217Port),
      this.listen(this.rawServer, this.rawPort),
    ]);
    this.urls.rfc2217 = `rfc2217://127.0.0.1:${this.rfcServer.address().port}`;
    this.urls.raw = `socket://127.0.0.1:${this.rawServer.address().port}`;
    if (typeof this.flags.pty === "string") {
      const pty = (this.deps.startPty ?? startSocatPty)({
        link: this.flags.pty,
        rawPort: this.rawServer.address().port,
        spawn: this.deps.spawn,
      });
      if (pty.started) {
        this.pty = pty;
        this.urls.pty = pty.link;
      } else this.emit("warning", pty.message);
    }
  }

  listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once("error", (error) =>
        reject(
          error.code === "EADDRINUSE"
            ? new Error(
                `Local port ${port} is already in use. Pass another port with --rfc2217-port or --raw-port.`,
              )
            : error,
        ),
      );
      server.listen(port, "127.0.0.1", resolve);
    });
  }

  onRfcClient(socket, settings) {
    if (this.rfc) {
      socket.end("AnyRemote: another RFC2217 client is already connected.\r\n");
      return;
    }
    socket.setNoDelay(true);
    const connection = createRfc2217Connection(socket, {
      settings: { ...settings },
      modemState: SYNTHETIC_MODEM_STATE,
      onTx: (data) => this.writeLocal(data),
      onBaudRate: ({ baudRate }) => {
        this.coalescer.flush();
        this.sendFrame({ kind: "control", control: { baudRate } });
      },
      onControl: (control) => {
        if (control.dtr !== undefined || control.rts !== undefined)
          this.coalescer.change(control);
        else {
          this.coalescer.flush();
          this.sendFrame({ kind: "control", control });
        }
      },
      onPurge: (which) => {
        this.coalescer.flush();
        if (which !== "rx") this.dropTxBuffer();
        this.sendFrame({
          kind: "control",
          control: { purge: which },
        });
      },
    });
    this.rfc = { socket, connection };
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.coalescer.flush();
      if (this.rfc?.socket === socket) this.rfc = null;
    });
    this.emit("client", "rfc2217");
  }

  onRawClient(socket) {
    if (this.rawClient) {
      socket.end();
      return;
    }
    socket.setNoDelay(true);
    this.rawClient = socket;
    socket.on("data", (chunk) => {
      if (this.writeLocal(chunk) === false) socket.pause();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.rawClient === socket) this.rawClient = null;
    });
    this.emit("client", "raw");
  }

  /** 本地客户端 → 设备。返回 false 表示需要暂停读取。 */
  writeLocal(data) {
    this.txBuffers.push(Buffer.from(data));
    this.txBufferedBytes += data.length;
    if (this.live && !this.deviceOffline) {
      if (this.txBufferedBytes >= MAX_STREAM_FRAME_BYTES) this.flushTx();
      else if (!this.txTimer) {
        this.txTimer = setTimeout(() => {
          this.txTimer = null;
          this.flushTx();
        }, TX_COALESCE_MS);
        this.txTimer.unref?.();
      }
    }
    if (
      this.wsPending + this.txBufferedBytes >= TX_HIGH_WATER ||
      !this.live ||
      this.deviceOffline
    ) {
      this.localPaused = true;
      return false;
    }
    return true;
  }

  dropTxBuffer() {
    this.txBuffers = [];
    this.txBufferedBytes = 0;
  }

  flushTx() {
    if (this.txTimer) {
      clearTimeout(this.txTimer);
      this.txTimer = null;
    }
    if (!this.live || this.deviceOffline) return;
    // 控制变化排在它之前写入的数据之后，保持用户可见的顺序。
    while (this.txBufferedBytes > 0) {
      const joined =
        this.txBuffers.length === 1
          ? this.txBuffers[0]
          : Buffer.concat(this.txBuffers);
      const chunk = joined.subarray(0, MAX_STREAM_FRAME_BYTES);
      const rest = joined.subarray(chunk.length);
      if (
        !this.sendFrame(
          { kind: "tx", data: chunk.toString("base64") },
          chunk.length,
        )
      )
        return;
      this.txBuffers = rest.length > 0 ? [rest] : [];
      this.txBufferedBytes = rest.length;
    }
    this.maybeResumeLocal();
  }

  maybeResumeLocal() {
    if (!this.localPaused) return;
    if (!this.live || this.deviceOffline) return;
    if (this.wsPending + this.txBufferedBytes > TX_LOW_WATER) return;
    this.localPaused = false;
    this.rfc?.connection.resume();
    if (this.rawClient && !this.rawClient.destroyed) this.rawClient.resume();
  }

  // ---- timers, status, reconnect ----

  startTimers() {
    this.ackTimer = setInterval(() => {
      if (this.ackUnsent > 0) this.sendAck();
    }, ACK_INTERVAL_MS);
    this.pingTimer = setInterval(() => this.startPing(), PING_INTERVAL_MS);
    this.statusTimer = setInterval(
      () => this.emit("status", this.statusLine()),
      this.deps.statusIntervalMs ?? STATUS_INTERVAL_MS,
    );
    for (const timer of [this.ackTimer, this.pingTimer, this.statusTimer])
      timer.unref?.();
  }

  startPing() {
    const socket = this.ws;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) return;
    this.pingSentAt = performance.now();
    socket.send("ping");
  }

  statusLine() {
    const { rxBytes, txBytes, bytesLost, rttMs, lossUnknown } = this.stats;
    const parts = [
      `rx ${formatBytes(rxBytes)}`,
      `tx ${formatBytes(txBytes)}`,
      `lost ${bytesLost}${lossUnknown ? "+" : ""} B`,
      `rtt ${rttMs === null ? "-" : `${Math.round(rttMs)} ms`}`,
    ];
    if (this.deviceOffline) parts.push("device offline");
    else if (!this.live) parts.push("reconnecting");
    return parts.join("  ");
  }

  onSocketClosed(code) {
    this.ws = null;
    this.live = false;
    clearInterval(this.pingTimer);
    if (this.finished) return;
    if (this.closing) {
      this.finish("closed");
      return;
    }
    if (code === STREAM_CLOSE_RECLAIMED) {
      this.finish(
        "reclaimed",
        Object.assign(
          new Error(
            "The session was reclaimed from the console or by an MCP client.",
          ),
          {
            code: "RECLAIMED",
          },
        ),
      );
      return;
    }
    if (code === 1000 || code === 1008 || !this.sessionId) {
      if (this.openedWaiter) {
        this.openedWaiter.reject(
          new Error(
            "The relay closed the connection before the session opened.",
          ),
        );
        this.openedWaiter = null;
      }
      this.finish("closed");
      return;
    }
    void this.reconnect();
  }

  async reconnect() {
    if (this.reconnecting || this.finished) return;
    this.reconnecting = true;
    this.emit("state", "reconnecting");
    const deadline = Date.now() + SERIAL_STREAM_GRACE_MS - 1500;
    let delay = 250;
    while (!this.finished && Date.now() < deadline && this.reconnecting) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
      if (this.finished || !this.reconnecting) return;
      this.connect({
        resume: { sessionId: this.sessionId, lastSeq: this.lastSeq },
      });
      // 等到这条连接结束或成功恢复。
      const socket = this.ws;
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (this.ws !== socket || this.live || this.finished) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
      if (this.live) return;
    }
    if (!this.finished)
      this.finish(
        "lost-connection",
        Object.assign(
          new Error("Could not resume the stream within the grace period."),
          {
            code: "RESUME_FAILED",
          },
        ),
      );
  }

  finishReconnect() {
    this.reconnecting = false;
  }

  // ---- shutdown ----

  /** Ctrl-C：让设备关闭端口并结束租约，然后清理本地监听。 */
  async close() {
    if (this.finished) return this.closed;
    this.closing = true;
    this.coalescer.close();
    this.flushTx();
    this.sendFrame({ kind: "state", state: { phase: "closed" } });
    const socket = this.ws;
    if (!socket) {
      this.finish("closed");
      return this.closed;
    }
    const deadline = setTimeout(() => this.finish("closed"), 2000);
    deadline.unref?.();
    this.closed.then(() => clearTimeout(deadline));
    return this.closed;
  }

  finish(reason, error) {
    if (this.finished) return;
    this.finished = true;
    this.reconnecting = false;
    this.live = false;
    this.coalescer.close();
    clearTimeout(this.txTimer);
    clearInterval(this.ackTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.statusTimer);
    this.pty?.stop?.();
    this.rfc?.socket.destroy();
    this.rawClient?.destroy();
    this.rfcServer?.close();
    this.rawServer?.close();
    const socket = this.ws;
    this.ws = null;
    try {
      if (socket && socket.readyState === this.WebSocketImpl.OPEN)
        socket.close(1000, "done");
      else socket?.terminate?.();
    } catch {
      // 已关闭。
    }
    if (this.openedWaiter) {
      this.openedWaiter.reject(
        error ?? new Error("The stream closed before it opened."),
      );
      this.openedWaiter = null;
    }
    this.resolveClosed({
      reason,
      error,
      stats: { ...this.stats },
      sessionId: this.sessionId,
    });
  }
}

/**
 * 连接并启动本地端点。resolve 的对象带 `urls`、`events`（EventEmitter）与 `closed`（结束时 resolve）。
 */
export async function runSerialAttach(flags, deps = {}) {
  const attach = new SerialAttach(flags, deps);
  try {
    await attach.start();
  } catch (error) {
    attach.finish("failed", error);
    throw error;
  }
  return {
    events: attach,
    urls: attach.urls,
    sessionId: attach.sessionId,
    stats: () => ({ ...attach.stats }),
    statusLine: () => attach.statusLine(),
    close: () => attach.close(),
    closed: attach.closed,
  };
}
