import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  connectionEnvelopeSchema,
  PROTOCOL_VERSION,
  toolRequestSchema,
} from "@anyremote/contracts";
import WebSocket from "ws";
import { serializeToolError } from "./errors.js";
import { detectPlatform } from "./platform.js";
import { CLI_VERSION } from "./version.js";

const MAX_COMPLETED_REQUESTS = 1024;
const COMPLETED_RESULT_RETENTION_MS = 60_000;
const MAX_COMPLETED_RESULT_BYTES = 8 * 1024 * 1024;
const SCREEN_CAPTURE_RESULT_RESERVATION_BYTES = 1_500_000;
const MAX_ACTIVE_SCREEN_CAPTURES = 1;

function payloadHash(payload) {
  const comparable = {
    deviceId: payload.deviceId,
    tool: payload.tool,
    arguments: payload.arguments,
  };
  return createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
}

function outcomeUnknownResult(requestId) {
  return {
    status: "unknown",
    error: {
      code: "OUTCOME_UNKNOWN",
      message: "request result is no longer retained; it was not re-executed",
      requestId,
    },
  };
}

function serializedResultBytes(result) {
  return Buffer.byteLength(JSON.stringify(result));
}

export class DeviceAgent extends EventEmitter {
  constructor({
    apiClient,
    deviceId,
    deviceToken,
    deviceName,
    agentVersion = CLI_VERSION,
    executor,
    reconnect = true,
    WebSocketImpl = WebSocket,
    heartbeatMs = 20_000,
    connectTimeoutMs = 15_000,
  } = {}) {
    super();
    if (!apiClient || !deviceId || !deviceToken || !executor)
      throw new Error(
        "apiClient, deviceId, deviceToken and executor are required",
      );
    this.apiClient = apiClient;
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.deviceName = deviceName || `${process.platform} device`;
    this.agentVersion = agentVersion;
    this.executor = executor;
    this.shouldReconnect = reconnect;
    this.WebSocketImpl = WebSocketImpl;
    this.heartbeatMs = heartbeatMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.connectionEpoch = randomUUID();
    this.socket = null;
    this.heartbeatTimer = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.socketAlive = false;
    this.stopping = false;
    this.completed = new Map();
    this.completedResultBytes = 0;
    this.reservedCompletedResultBytes = 0;
    this.activeScreenCaptures = 0;
    this.completedCleanupTimer = null;
    this.inFlight = new Set();
  }

  start() {
    this.stopping = false;
    this.open();
    return this;
  }

  stop() {
    this.stopping = true;
    this.shouldReconnect = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.socketAlive = false;
    if (socket) {
      // 对端不回应 close 时，不能让 WebSocket 的默认长超时拖住 CLI 退出。
      const deadline = setTimeout(() => socket.terminate(), 1000);
      deadline.unref();
      socket.once("close", () => clearTimeout(deadline));
      socket.close(1000, "client stopped");
    }
  }

  async shutdown() {
    this.stop();
    await this.executor.shutdown?.();
  }

  open() {
    if (this.stopping || this.socket) return;
    this.reconnectTimer = null;
    const url = this.apiClient.connectUrl(this.deviceId);
    let socket;
    try {
      socket = new this.WebSocketImpl(url, {
        headers: { authorization: `Bearer ${this.deviceToken}` },
      });
    } catch (error) {
      this.emit("error", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.socketAlive = false;
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this.emit("error", new Error("WebSocket connection timed out"));
      this.terminateSocket(socket);
    }, this.connectTimeoutMs);
    socket.on("open", () => this.handleOpen(socket));
    socket.on("pong", () => this.handlePong(socket));
    socket.on("message", (data) => this.handleMessage(socket, data));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if ([401, 403, 404].includes(response.statusCode)) {
        this.stop();
        this.emit("revoked");
      } else {
        socket.terminate();
      }
    });
    socket.on("close", (code, reason) =>
      this.handleClose(socket, code, reason),
    );
  }

  handleOpen(socket = this.socket) {
    if (!socket || this.socket !== socket) return;
    this.socketAlive = true;
    if (
      !this.send("hello", randomUUID(), {
        deviceToken: this.deviceToken,
        name: this.deviceName,
        platform: detectPlatform(),
        agentVersion: this.agentVersion,
      })
    )
      this.terminateSocket(socket);
  }

  handlePong(socket) {
    if (this.socket === socket) this.socketAlive = true;
  }

  handleClose(socket, code, reason) {
    if (this.socket !== socket) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.socket = null;
    this.socketAlive = false;
    this.emit("disconnected", { code, reason: reason?.toString() });
    if (code === 1008) {
      this.stop();
      this.emit("revoked");
      return;
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopping || !this.shouldReconnect || this.reconnectTimer) return;
    const delay =
      Math.min(30_000, 250 * 2 ** this.reconnectAttempt) +
      Math.round(Math.random() * 250);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  terminateSocket(socket) {
    if (this.socket !== socket) return;
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else socket.close();
    } catch (error) {
      this.emit("error", error);
      this.handleClose(socket, 1006, "socket terminated");
    }
  }

  send(type, requestId, payload) {
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN)
      return false;
    const envelope = {
      version: PROTOCOL_VERSION,
      type,
      requestId,
      deviceId: this.deviceId,
      connectionEpoch: this.connectionEpoch,
      payload,
    };
    try {
      this.socket.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  deleteCompleted(requestId) {
    const entry = this.completed.get(requestId);
    if (!entry) return;
    this.completed.delete(requestId);
    this.completedResultBytes -= entry.resultBytes;
  }

  pruneCompletedResults(now = Date.now()) {
    for (const [requestId, entry] of this.completed) {
      if (!entry.expiresAt || entry.expiresAt > now) continue;
      this.completedResultBytes -= entry.resultBytes;
      entry.result = outcomeUnknownResult(requestId);
      entry.resultBytes = 0;
      entry.expiresAt = null;
    }
    this.scheduleCompletedCleanup();
  }

  scheduleCompletedCleanup() {
    if (this.completedCleanupTimer) {
      clearTimeout(this.completedCleanupTimer);
      this.completedCleanupTimer = null;
    }
    let nextExpiry = Infinity;
    for (const entry of this.completed.values()) {
      if (entry.expiresAt && entry.expiresAt < nextExpiry)
        nextExpiry = entry.expiresAt;
    }
    if (!Number.isFinite(nextExpiry)) return;
    this.completedCleanupTimer = setTimeout(
      () => {
        this.completedCleanupTimer = null;
        this.pruneCompletedResults();
      },
      Math.max(0, nextExpiry - Date.now()),
    );
    this.completedCleanupTimer.unref?.();
  }

  rememberCompleted(requestId, hash, result) {
    const resultBytes = serializedResultBytes(result);
    const canRetainResult =
      this.completedResultBytes +
        this.reservedCompletedResultBytes +
        resultBytes <=
      MAX_COMPLETED_RESULT_BYTES;
    const retainedResult = canRetainResult
      ? result
      : outcomeUnknownResult(requestId);
    const retainedBytes = canRetainResult ? resultBytes : 0;
    this.completed.set(requestId, {
      hash,
      result: retainedResult,
      resultBytes: retainedBytes,
      expiresAt: retainedBytes
        ? Date.now() + COMPLETED_RESULT_RETENTION_MS
        : null,
    });
    this.completedResultBytes += retainedBytes;
    while (this.completed.size > MAX_COMPLETED_REQUESTS)
      this.deleteCompleted(this.completed.keys().next().value);
    this.scheduleCompletedCleanup();
  }

  async handleMessage(socket, data) {
    if (data === undefined) {
      data = socket;
      socket = this.socket;
    }
    if (this.socket !== socket) return;
    let parsed;
    try {
      parsed = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      );
    } catch (error) {
      this.emit("protocolError", error);
      return;
    }
    const result = connectionEnvelopeSchema.safeParse(parsed);
    if (!result.success || result.data.deviceId !== this.deviceId) {
      this.emit("protocolError", new Error("invalid connection envelope"));
      return;
    }
    const envelope = result.data;
    if (envelope.type === "hello") {
      if (
        envelope.payload &&
        typeof envelope.payload === "object" &&
        envelope.payload.accepted === true
      ) {
        this.connectionEpoch = envelope.connectionEpoch;
        this.reconnectAttempt = 0;
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        clearInterval(this.heartbeatTimer);
        this.emit("connected", {
          deviceId: this.deviceId,
          connectionEpoch: this.connectionEpoch,
        });
        this.heartbeatTimer = setInterval(() => {
          if (this.socket !== socket || this.stopping) return;
          if (socket.readyState !== this.WebSocketImpl.OPEN) {
            this.terminateSocket(socket);
            return;
          }
          if (typeof socket.ping === "function") {
            if (!this.socketAlive) {
              this.emit("error", new Error("WebSocket heartbeat timed out"));
              this.terminateSocket(socket);
              return;
            }
            this.socketAlive = false;
            try {
              socket.ping();
            } catch (error) {
              this.emit("error", error);
              this.terminateSocket(socket);
              return;
            }
          }
          if (
            !this.send("heartbeat", randomUUID(), {
              at: new Date().toISOString(),
            })
          )
            this.terminateSocket(socket);
        }, this.heartbeatMs);
      }
      return;
    }
    if (envelope.connectionEpoch !== this.connectionEpoch) {
      this.emit("protocolError", new Error("invalid connection epoch"));
      return;
    }
    if (envelope.type === "request") await this.handleRequest(envelope);
    else if (envelope.type === "cancel") this.emit("cancel", envelope);
  }

  async handleRequest(envelope) {
    this.pruneCompletedResults();
    const request = toolRequestSchema.safeParse({
      ...envelope.payload,
      requestId: envelope.requestId,
      deviceId: this.deviceId,
    });
    if (!request.success) {
      this.send("result", envelope.requestId, {
        status: "error",
        error: {
          code: "VALIDATION_ERROR",
          message: request.error.message,
          requestId: envelope.requestId,
        },
      });
      return;
    }
    const input = request.data;
    const hash = payloadHash(input);
    const previous = this.completed.get(input.requestId);
    if (previous) {
      if (previous.hash !== hash) {
        this.send("result", input.requestId, {
          status: "error",
          error: {
            code: "CONFLICT",
            message: "requestId was already used with different arguments",
            requestId: input.requestId,
          },
        });
      } else {
        this.send("result", input.requestId, previous.result);
      }
      return;
    }
    if (this.inFlight.has(input.requestId)) return;
    const isScreenCapture = input.tool === "screen.capture";
    if (
      isScreenCapture &&
      (this.activeScreenCaptures >= MAX_ACTIVE_SCREEN_CAPTURES ||
        this.completedResultBytes +
          this.reservedCompletedResultBytes +
          SCREEN_CAPTURE_RESULT_RESERVATION_BYTES >
          MAX_COMPLETED_RESULT_BYTES)
    ) {
      const result = {
        status: "error",
        error: {
          code: "RATE_LIMITED",
          message: "Screen capture capacity is full; try again shortly.",
          requestId: input.requestId,
        },
      };
      this.rememberCompleted(input.requestId, hash, result);
      this.send("result", input.requestId, result);
      this.emit("request", {
        requestId: input.requestId,
        tool: input.tool,
        status: result.status,
        elapsedMs: 0,
      });
      return;
    }
    this.inFlight.add(input.requestId);
    let captureExecutionStarted = false;
    let releaseCaptureReservation = () => {};
    if (isScreenCapture) {
      this.activeScreenCaptures += 1;
      this.reservedCompletedResultBytes +=
        SCREEN_CAPTURE_RESULT_RESERVATION_BYTES;
      let reservationReleased = false;
      releaseCaptureReservation = () => {
        if (reservationReleased) return;
        reservationReleased = true;
        this.activeScreenCaptures -= 1;
        this.reservedCompletedResultBytes -=
          SCREEN_CAPTURE_RESULT_RESERVATION_BYTES;
      };
    }
    const startedAt = Date.now();
    let result;
    let timeoutId;
    try {
      const deadline = new Date(input.deadline).getTime();
      const remaining = deadline - Date.now();
      if (!Number.isFinite(deadline) || remaining <= 0)
        throw new Error("request deadline exceeded");
      const timeout = new Promise((_, reject) => {
        const timeoutError = new Error("request deadline exceeded");
        timeoutError.code = "OUTCOME_UNKNOWN";
        timeoutId = setTimeout(() => reject(timeoutError), remaining);
      });
      const execution = Promise.resolve(
        this.executor.execute(input.tool, input.arguments, {
          requestId: input.requestId,
          deadline,
        }),
      );
      captureExecutionStarted = true;
      if (isScreenCapture)
        execution.then(releaseCaptureReservation, releaseCaptureReservation);
      const output = await Promise.race([execution, timeout]);
      result = { status: "success", output };
    } catch (error) {
      if (error?.code === "OUTCOME_UNKNOWN") {
        result = {
          status: "unknown",
          error: {
            code: "OUTCOME_UNKNOWN",
            message: error.message,
            requestId: input.requestId,
          },
        };
      } else {
        result = {
          status: "error",
          error: {
            ...serializeToolError(error),
            requestId: input.requestId,
          },
        };
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.inFlight.delete(input.requestId);
      if (isScreenCapture && !captureExecutionStarted)
        releaseCaptureReservation();
    }
    this.rememberCompleted(input.requestId, hash, result);
    this.send("result", input.requestId, result);
    // 事件只携带 allowlist 元数据；调用方不应通过诊断日志接触原始参数
    // 或执行结果中的路径、文件内容、命令和环境变量。
    this.emit("request", {
      requestId: input.requestId,
      tool: input.tool,
      status: result.status,
      elapsedMs: Date.now() - startedAt,
    });
  }
}
