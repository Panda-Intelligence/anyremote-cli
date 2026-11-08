import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  MAX_SERIAL_READ_BYTES,
  MAX_SERIAL_WAIT_MS,
  MAX_SERIAL_WRITE_BYTES,
  MAX_STREAM_FRAME_BYTES,
  STREAM_WINDOW_BYTES,
  serialControlSchema,
  serialOpenParamsSchema,
  streamFrameSchema,
} from "@anyremote/contracts";
import { ToolError, toToolError } from "../errors.js";
import { matchesAllow, normalizePortPath } from "./allowlist.js";

const DEADLINE_MARGIN_MS = 10;
const LOST_RETENTION_MS = 60_000;
const MAX_SESSIONS = 16;
const UNTIL_WINDOW_BYTES = 64 * 1024;
const MAX_UNTIL_PATTERN = 128;
const MAX_UNTIL_LITERAL = 256;
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
const DEFAULT_COALESCE_MS = 10;
const EOLS = new Set(["\n", "\r\n", "\r"]);

const sleepUntil = async (target) => {
  // 先用定时器睡到临近目标，再让出事件循环自旋收尾；
  // 序列步骤的间隔因此不受定时器粒度影响（±15 ms 的验收要求）。
  const coarse = target - performance.now() - 3;
  if (coarse > 0) await new Promise((resolve) => setTimeout(resolve, coarse));
  while (performance.now() < target)
    await new Promise((resolve) => setImmediate(resolve));
};

const unrefTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
};

/**
 * serialport 的错误文本因平台而异，统一到稳定的 ErrorCode。
 * @param {unknown} error
 */
// 串口驱动的原始消息常带设备路径（"Opening /dev/cu.x: Permission denied"）；
// 对外只给固定文案，路径不进入 result/stream error，也就不会进入 Worker 日志。
const SERIAL_ERROR_TEXT = {
  FORBIDDEN: "serial port access denied",
  NOT_FOUND: "serial port not found",
  CONFLICT: "serial port state conflict",
  INTERNAL_ERROR: "serial operation failed",
};

export function toSerialError(error) {
  if (error instanceof ToolError) return error;
  if (error?.code === "EACCES" || error?.code === "EPERM")
    return new ToolError("FORBIDDEN", SERIAL_ERROR_TEXT.FORBIDDEN);
  const text = `${error?.code ?? ""} ${error instanceof Error ? error.message : ""}`;
  if (
    /EBUSY|resource temporarily unavailable|locked|in use|access denied/i.test(
      text,
    )
  )
    return new ToolError("SERIAL_PORT_BUSY", "serial port is busy");
  if (/ENOENT|no such file|cannot find|not found/i.test(text))
    return new ToolError("NOT_FOUND", "serial port not found");
  if (/port is not open|port closed|not open/i.test(text))
    return new ToolError(
      "SERIAL_PORT_LOST",
      "serial port is no longer available",
    );
  const mapped = toToolError(error);
  return new ToolError(
    mapped.code,
    SERIAL_ERROR_TEXT[mapped.code] ?? SERIAL_ERROR_TEXT.INTERNAL_ERROR,
  );
}

function limited(value, name, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new ToolError(
      "VALIDATION_ERROR",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  return value;
}

/** 解码 UTF-8，同时记录每个 UTF-16 下标对应的字节偏移；末尾不完整字符不输出。 */
function decodeUtf8(buffer) {
  let text = "";
  const offsets = [];
  let index = 0;
  while (index < buffer.length) {
    const lead = buffer[index];
    let length = 1;
    let valid = true;
    if (lead >= 0x80) {
      if (lead >= 0xc2 && lead <= 0xdf) length = 2;
      else if (lead >= 0xe0 && lead <= 0xef) length = 3;
      else if (lead >= 0xf0 && lead <= 0xf4) length = 4;
      else valid = false;
    }
    if (valid && length > 1) {
      const available = Math.min(length, buffer.length - index);
      for (let step = 1; step < available; step += 1)
        if ((buffer[index + step] & 0xc0) !== 0x80) valid = false;
      if (valid && available < length)
        return { text, offsets, end: index, pending: true };
    }
    let piece = "\ufffd";
    if (valid) {
      piece = buffer.toString("utf8", index, index + length);
      const encodedReplacement =
        length === 3 &&
        buffer[index] === 0xef &&
        buffer[index + 1] === 0xbf &&
        buffer[index + 2] === 0xbd;
      if (piece.includes("\ufffd") && length > 1 && !encodedReplacement) {
        piece = "\ufffd";
        length = 1;
      }
    } else length = 1;
    for (let unit = 0; unit < piece.length; unit += 1) offsets.push(index);
    text += piece;
    index += length;
  }
  return { text, offsets, end: buffer.length, pending: false };
}

function parseUntil(until) {
  if (until === undefined) return undefined;
  if (typeof until !== "string" || until.length === 0)
    throw new ToolError("VALIDATION_ERROR", "until must be a non-empty string");
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(until);
  if (regex) {
    if (regex[1].length > MAX_UNTIL_PATTERN)
      throw new ToolError(
        "VALIDATION_ERROR",
        `until pattern exceeds ${MAX_UNTIL_PATTERN} characters`,
      );
    const flags = [...new Set(`${regex[2].replace(/[gy]/g, "")}u`)].join("");
    try {
      const expression = new RegExp(regex[1], flags);
      return (text) => {
        const match = expression.exec(text);
        return match ? match.index + match[0].length : -1;
      };
    } catch {
      throw new ToolError(
        "VALIDATION_ERROR",
        "until is not a valid regular expression",
      );
    }
  }
  if (until.length > MAX_UNTIL_LITERAL)
    throw new ToolError(
      "VALIDATION_ERROR",
      `until exceeds ${MAX_UNTIL_LITERAL} characters`,
    );
  return (text) => {
    const at = text.indexOf(until);
    return at < 0 ? -1 : at + until.length;
  };
}

export function decodeSerialData(data, encoding = "utf8", eol) {
  if (typeof data !== "string")
    throw new ToolError("VALIDATION_ERROR", "data must be a string");
  if (eol !== undefined && !EOLS.has(eol))
    throw new ToolError("VALIDATION_ERROR", "eol must be \\n, \\r\\n or \\r");
  let buffer;
  if (encoding === "hex") {
    if (data.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(data))
      throw new ToolError("VALIDATION_ERROR", "data is not valid hex");
    buffer = Buffer.from(data, "hex");
  } else if (encoding === "base64") {
    const shape = /^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 !== 1;
    buffer = Buffer.from(data, "base64");
    if (
      !shape ||
      buffer.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")
    )
      throw new ToolError("VALIDATION_ERROR", "data is not valid base64");
  } else if (encoding === "utf8") {
    buffer = Buffer.from(data, "utf8");
  } else
    throw new ToolError(
      "VALIDATION_ERROR",
      "encoding must be utf8, hex or base64",
    );
  if (eol) buffer = Buffer.concat([buffer, Buffer.from(eol, "utf8")]);
  if (buffer.byteLength > MAX_SERIAL_WRITE_BYTES)
    throw new ToolError(
      "VALIDATION_ERROR",
      `write exceeds ${MAX_SERIAL_WRITE_BYTES} bytes`,
    );
  return buffer;
}

function encodeBytes(buffer, encoding) {
  return encoding === "hex"
    ? buffer.toString("hex")
    : buffer.toString("base64");
}

class SerialSession {
  constructor({ manager, id, path, canonicalPath, params, port }) {
    this.manager = manager;
    this.id = id;
    this.path = path;
    this.canonicalPath = canonicalPath;
    this.params = params;
    this.port = port;
    this.state = "open";
    this.closeReason = null;
    this.openedAtMs = Date.now();
    this.lastActivityMs = this.openedAtMs;
    this.holder = { kind: "mcp" };
    this.chunks = [];
    this.bufferedBytes = 0;
    this.startCursor = 0;
    this.endCursor = 0;
    this.deliveredCursor = 0;
    this.purgedCursor = 0;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.bytesLost = 0;
    this.waiters = new Set();
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.retentionTimer = null;
    this.expectedInSeq = 0;
    this.outSeq = 0;
    this.sink = null;
    this.streaming = false;
    this.streamCursor = 0;
    this.unacked = 0;
    this.paused = false;
    this.lostDelta = 0;
    this.flushTimer = null;
    this.expectedClose = false;
    this.reported = false;
    port.on("data", (chunk) => this.receive(chunk));
    port.on("error", () => this.markLost());
    port.on("close", () => {
      if (!this.expectedClose) this.markLost();
    });
    this.touch();
  }

  touch() {
    this.lastActivityMs = Date.now();
    clearTimeout(this.idleTimer);
    if (this.state !== "open") return;
    this.idleTimer = unrefTimer(
      () => void this.manager.finish(this, "idle"),
      this.params.idleTimeoutMs,
    );
  }

  notify() {
    for (const waiter of [...this.waiters]) waiter();
  }

  receive(chunk) {
    if (this.state !== "open") return;
    const buffer = Buffer.from(chunk);
    if (buffer.byteLength === 0) return;
    this.chunks.push({ start: this.endCursor, buffer });
    this.endCursor += buffer.byteLength;
    this.rxBytes += buffer.byteLength;
    this.bufferedBytes += buffer.byteLength;
    this.evict();
    this.touch();
    this.notify();
    if (this.streaming) this.scheduleFlush();
  }

  evict() {
    const excess = this.bufferedBytes - this.params.bufferBytes;
    if (excess <= 0) return;
    const oldStart = this.startCursor;
    let remaining = excess;
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.buffer.byteLength <= remaining) {
        remaining -= first.buffer.byteLength;
        this.chunks.shift();
      } else {
        first.buffer = first.buffer.subarray(remaining);
        first.start += remaining;
        remaining = 0;
      }
    }
    this.bufferedBytes -= excess;
    this.startCursor += excess;
    this.bytesLost += Math.max(
      0,
      this.startCursor - Math.max(oldStart, this.deliveredCursor),
    );
    if (this.streaming && this.streamCursor < this.startCursor) {
      this.lostDelta += this.startCursor - this.streamCursor;
      this.streamCursor = this.startCursor;
    }
  }

  slice(from, maxBytes) {
    const parts = [];
    let taken = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.buffer.byteLength;
      if (chunkEnd <= from) continue;
      const offset = Math.max(0, from - chunk.start);
      const part = chunk.buffer.subarray(offset, offset + (maxBytes - taken));
      parts.push(part);
      taken += part.byteLength;
      if (taken >= maxBytes) break;
    }
    return Buffer.concat(parts);
  }

  clearRing() {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.startCursor = this.endCursor;
    this.deliveredCursor = this.endCursor;
    this.purgedCursor = this.endCursor;
    if (this.streaming) this.streamCursor = this.endCursor;
  }

  assertUsable() {
    if (this.state === "lost")
      throw new ToolError(
        "SERIAL_PORT_LOST",
        "serial port is no longer available",
      );
    if (this.state !== "open")
      throw new ToolError(
        "NOT_FOUND",
        `serial session is closed${this.closeReason ? ` (${this.closeReason})` : ""}`,
      );
  }

  waitForChange(milliseconds) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.waiters.add(done);
    });
  }

  async lineState() {
    try {
      const status = await this.port.get();
      return {
        cts: Boolean(status?.cts),
        dsr: Boolean(status?.dsr),
        dcd: Boolean(status?.dcd),
        ri: Boolean(status?.ri),
      };
    } catch {
      return { cts: false, dsr: false, dcd: false, ri: false };
    }
  }

  async read(
    { cursor = 0, maxBytes, waitMs, until, encoding = "utf8" },
    options = {},
  ) {
    this.assertUsable();
    this.touch();
    if (!["utf8", "hex", "base64"].includes(encoding))
      throw new ToolError(
        "VALIDATION_ERROR",
        "encoding must be utf8, hex or base64",
      );
    const max = limited(
      maxBytes,
      "maxBytes",
      MAX_SERIAL_READ_BYTES,
      1,
      MAX_SERIAL_READ_BYTES,
    );
    const wait = limited(waitMs, "waitMs", 1000, 0, MAX_SERIAL_WAIT_MS);
    limited(cursor, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
    if (cursor > this.endCursor)
      throw new ToolError(
        "VALIDATION_ERROR",
        "cursor is ahead of the received data",
      );
    const matcher = parseUntil(until);
    const budgetMs =
      options.deadline === undefined
        ? wait
        : Math.min(
            wait,
            Math.max(0, options.deadline - Date.now() - DEADLINE_MARGIN_MS),
          );
    const stopAt = performance.now() + budgetMs;
    let result = this.snapshot(cursor, max, matcher, encoding);
    for (;;) {
      const ready = matcher ? result.matched : result.consumed > 0;
      const full = result.length >= max;
      const remaining = stopAt - performance.now();
      if (ready || full || remaining <= 0 || this.state !== "open") break;
      if (options.signal?.aborted)
        throw new ToolError("REQUEST_TIMEOUT", "request was cancelled");
      await this.waitForChange(remaining);
      result = this.snapshot(cursor, max, matcher, encoding);
    }
    if (this.state === "lost" && result.consumed === 0)
      throw new ToolError(
        "SERIAL_PORT_LOST",
        "serial port is no longer available",
      );
    if (result.error) throw new ToolError("VALIDATION_ERROR", result.error);
    this.deliveredCursor = Math.max(this.deliveredCursor, result.nextCursor);
    const output = {
      sessionId: this.id,
      data: result.data,
      encoding,
      nextCursor: result.nextCursor,
      bufferStartCursor: this.startCursor,
      bytesLost: Math.max(
        0,
        this.startCursor - Math.max(cursor, this.purgedCursor),
      ),
      truncated:
        Math.max(cursor, this.purgedCursor) < this.startCursor ||
        this.endCursor > result.nextCursor,
      lineState: await this.lineState(),
      state: this.state,
    };
    if (matcher) output.matched = result.matched;
    return output;
  }

  snapshot(cursor, max, matcher, encoding) {
    const lost = cursor < this.startCursor;
    let start = Math.max(cursor, this.startCursor);
    let bytes = this.slice(start, max);
    if (lost) {
      // 丢弃后的起点可能落在多字节字符中间，跳过孤立的续字节。
      let skip = 0;
      while (skip < bytes.length && (bytes[skip] & 0xc0) === 0x80) skip += 1;
      if (encoding === "utf8" || matcher) {
        bytes = bytes.subarray(skip);
        start += skip;
      }
    }
    const view = decodeUtf8(bytes);
    let end = encoding === "utf8" ? view.end : bytes.byteLength;
    let matched = false;
    if (matcher) {
      const window = view.text.slice(-UNTIL_WINDOW_BYTES);
      const shift = view.text.length - window.length;
      const at = matcher(window);
      if (at >= 0) {
        matched = true;
        const unit = shift + at;
        end = unit >= view.offsets.length ? view.end : view.offsets[unit];
        if (unit >= view.offsets.length) end = view.end;
      }
    }
    const slice = bytes.subarray(0, end);
    let error;
    if (
      encoding === "utf8" &&
      slice.byteLength === 0 &&
      bytes.byteLength >= max &&
      max < 4
    )
      error = `maxBytes cannot hold the next complete UTF-8 character. Read again at cursor ${start} with a larger maxBytes.`;
    return {
      data:
        encoding === "utf8"
          ? slice.toString("utf8")
          : encodeBytes(slice, encoding),
      consumed: slice.byteLength,
      length: bytes.byteLength,
      nextCursor: start + slice.byteLength,
      matched,
      error,
    };
  }

  /** 同一会话上的 write / transact / control / 流帧按到达顺序串行执行。 */
  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async writeBytes(buffer, options = {}) {
    this.assertUsable();
    this.touch();
    const timeoutMs = Math.max(
      1,
      options.deadline === undefined
        ? DEFAULT_WRITE_TIMEOUT_MS
        : Math.min(
            DEFAULT_WRITE_TIMEOUT_MS,
            options.deadline - Date.now() - DEADLINE_MARGIN_MS,
          ),
    );
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ToolError(
              "OUTCOME_UNKNOWN",
              "serial write did not drain in time",
            ),
          ),
        timeoutMs,
      );
    });
    try {
      await Promise.race([
        (async () => {
          await this.port.write(buffer);
          await this.port.drain();
        })(),
        timeout,
      ]);
    } catch (error) {
      if (this.state === "lost") throw toSerialError(new Error("port closed"));
      throw toSerialError(error);
    } finally {
      clearTimeout(timer);
    }
    this.txBytes += buffer.byteLength;
    this.touch();
    return { bytesWritten: buffer.byteLength, txBytes: this.txBytes };
  }

  write({ data, encoding, eol }, options = {}) {
    const buffer = decodeSerialData(data, encoding, eol);
    return this.exclusive(() => this.writeBytes(buffer, options));
  }

  transact(args, options = {}) {
    const buffer = decodeSerialData(args.data, args.encoding, args.eol);
    parseUntil(args.until);
    return this.exclusive(async () => {
      const cursor = args.cursor ?? this.endCursor;
      await this.writeBytes(buffer, options);
      return this.read(
        { ...args, cursor, encoding: args.encoding ?? "utf8" },
        options,
      );
    });
  }

  control(input) {
    const parsed = serialControlSchema.safeParse(input);
    if (!parsed.success)
      throw new ToolError(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid control",
      );
    // Frame format (data bits, parity, stop bits) is fixed for the life of a
    // session; the control schema only allows baud, lines, break and purge.
    return this.exclusive(() => this.applyControl(parsed.data));
  }

  async applyControl(control) {
    this.assertUsable();
    this.touch();
    let applied = 0;
    try {
      if (control.baudRate !== undefined) {
        await this.port.update({ baudRate: control.baudRate });
        this.params = { ...this.params, baudRate: control.baudRate };
        applied += 1;
      }
      if (control.dtr !== undefined || control.rts !== undefined) {
        await this.port.set({
          ...(control.dtr !== undefined ? { dtr: control.dtr } : {}),
          ...(control.rts !== undefined ? { rts: control.rts } : {}),
        });
        applied += 1;
      }
      if (control.purge) {
        await this.port.flush();
        if (control.purge !== "tx") this.clearRing();
        applied += 1;
      }
      if (control.breakMs !== undefined) {
        await this.port.set({ brk: true });
        await sleepUntil(performance.now() + control.breakMs);
        await this.port.set({ brk: false });
        applied += 1;
      }
      // 以绝对时间表推进，单步迟到不会累积到后续步骤。
      let scheduled = performance.now();
      for (const step of control.sequence ?? []) {
        if (step.dtr !== undefined || step.rts !== undefined)
          await this.port.set({
            ...(step.dtr !== undefined ? { dtr: step.dtr } : {}),
            ...(step.rts !== undefined ? { rts: step.rts } : {}),
          });
        scheduled += step.delayMs;
        await sleepUntil(scheduled);
        applied += 1;
      }
    } catch (error) {
      if (this.state === "lost") throw toSerialError(new Error("port closed"));
      throw toSerialError(error);
    }
    this.touch();
    return { lineState: await this.lineState(), applied };
  }

  summary() {
    return {
      sessionId: this.id,
      deviceId: this.manager.deviceId,
      path: this.path,
      params: this.params,
      openedAt: new Date(this.openedAtMs).toISOString(),
      lastActivityAt: new Date(this.lastActivityMs).toISOString(),
      holder: this.holder,
      rxCursor: this.endCursor,
      txBytes: this.txBytes,
      bytesLost: this.bytesLost,
      state: this.state,
    };
  }

  // ---- stream mode ----

  emitFrame(frame) {
    if (!this.sink) return false;
    const full = { sessionId: this.id, seq: this.outSeq, ...frame };
    let accepted = false;
    try {
      accepted = this.sink(full) !== false;
    } catch {
      accepted = false;
    }
    if (accepted) this.outSeq += 1;
    return accepted;
  }

  attachStream(sink, { consumerDeviceId, reset = false } = {}) {
    this.sink = sink;
    this.holder = {
      kind: "stream",
      ...(consumerDeviceId ? { consumerDeviceId } : {}),
    };
    if (!this.streaming) {
      this.streaming = true;
      this.streamCursor = this.endCursor;
      this.unacked = 0;
      this.paused = false;
    } else if (reset) {
      this.unacked = 0;
      this.paused = false;
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (!this.streaming || this.paused || this.state !== "open") return;
    const pending = this.endCursor - this.streamCursor;
    if (pending <= 0) return;
    if (pending >= MAX_STREAM_FRAME_BYTES) this.flush(false);
    if (
      this.endCursor - this.streamCursor > 0 &&
      !this.flushTimer &&
      !this.paused
    ) {
      this.flushTimer = unrefTimer(() => {
        this.flushTimer = null;
        this.flush(true);
      }, this.manager.coalesceMs);
    }
  }

  flush(force) {
    for (;;) {
      if (!this.streaming || this.state !== "open") return;
      const pending = this.endCursor - this.streamCursor;
      if (pending <= 0) return;
      const room = STREAM_WINDOW_BYTES - this.unacked;
      if (room <= 0) {
        if (!this.paused) {
          this.paused = true;
          this.emitFrame({ kind: "state", state: { phase: "paused" } });
        }
        return;
      }
      const size = Math.min(MAX_STREAM_FRAME_BYTES, pending, room);
      if (
        !force &&
        size < MAX_STREAM_FRAME_BYTES &&
        room >= MAX_STREAM_FRAME_BYTES
      )
        return;
      const bytes = this.slice(this.streamCursor, size);
      const lost = this.lostDelta;
      const sent = this.emitFrame({
        kind: "rx",
        data: bytes.toString("base64"),
        ...(lost > 0 ? { state: { phase: "resumed", bytesLost: lost } } : {}),
      });
      if (!sent) return;
      this.lostDelta = 0;
      this.streamCursor += bytes.byteLength;
      this.deliveredCursor = Math.max(this.deliveredCursor, this.streamCursor);
      this.unacked += bytes.byteLength;
    }
  }

  credit(bytes) {
    this.unacked = Math.max(0, this.unacked - bytes);
    if (this.paused && this.unacked < STREAM_WINDOW_BYTES) {
      this.paused = false;
      const lost = this.lostDelta;
      this.emitFrame({
        kind: "state",
        state: { phase: "resumed", ...(lost > 0 ? { bytesLost: lost } : {}) },
      });
      this.lostDelta = 0;
    }
    this.scheduleFlush();
  }

  markLost() {
    if (this.state !== "open") return;
    this.manager.lose(this);
  }
}

export class SerialSessionManager {
  constructor({
    binding,
    allow = [],
    deviceId = "unbound",
    streamCoalesceMs = DEFAULT_COALESCE_MS,
    streamEnabled = true,
    realpath = fs.realpath,
    platform = process.platform,
    exists = fs.access,
    onSessionClosed,
  } = {}) {
    this.binding = binding;
    this.allow = allow;
    this.deviceId = deviceId;
    this.coalesceMs = limited(
      streamCoalesceMs,
      "streamCoalesceMs",
      DEFAULT_COALESCE_MS,
      2,
      50,
    );
    this.streamEnabled = streamEnabled;
    this.realpath = realpath;
    this.platform = platform;
    this.exists = exists;
    this.onSessionClosed = onSessionClosed;
    this.sessions = new Map();
    this.byPath = new Map();
    this.opening = new Set();
    this.available = false;
    this.closed = false;
  }

  /** 探测 serialport 是否可加载；hello 的 capabilities 取决于此结果。 */
  async prepare() {
    this.available = this.allow.length > 0 && (await this.binding.available());
    return this.available;
  }

  capabilities() {
    if (!this.available || this.allow.length === 0) return [];
    return this.streamEnabled ? ["serial", "serial.stream"] : ["serial"];
  }

  announcedSessions() {
    return [...this.sessions.values()]
      .filter((session) => session.state === "open")
      .map((session) => session.summary());
  }

  assertEnabled() {
    if (this.allow.length === 0)
      throw new ToolError(
        "FORBIDDEN",
        "Serial access is not enabled on this device; restart the CLI with --serial-allow",
      );
  }

  async canonical(path) {
    try {
      return normalizePortPath(await this.realpath(path));
    } catch {
      return normalizePortPath(path);
    }
  }

  /**
   * macOS 的 serialport.list() 只给出 /dev/tty.*；对外拨号应使用同名的 /dev/cu.*。
   * 两个节点是不同设备，allowlist 对每个路径单独判断，不互相放行。
   */
  async variants(port) {
    const match = /^\/dev\/tty\.(.+)$/.exec(port.path);
    if (this.platform !== "darwin" || !match) return [port];
    const callout = `/dev/cu.${match[1]}`;
    const exists = await this.exists(callout).then(
      () => true,
      () => false,
    );
    return exists ? [{ ...port, path: callout }, port] : [port];
  }

  async ports() {
    if (this.allow.length === 0) return { ports: [], hint: "serial_disabled" };
    const ports = [];
    for (const listed of await this.binding.list()) {
      for (const port of await this.variants(listed)) {
        if (
          matchesAllow(this.allow, port.path, await this.canonical(port.path))
        )
          ports.push(stripUndefined(port));
      }
    }
    return { ports };
  }

  /** 供 `anyremote serial ports` 使用：列出全部本地候选并标注是否放行。 */
  async candidates() {
    const candidates = [];
    for (const listed of await this.binding.list()) {
      for (const port of await this.variants(listed)) {
        candidates.push({
          ...stripUndefined(port),
          allowed: matchesAllow(
            this.allow,
            port.path,
            await this.canonical(port.path),
          ),
        });
      }
    }
    return candidates;
  }

  async open(args) {
    if (this.closed)
      throw new ToolError("CONFLICT", "executor is shutting down");
    this.assertEnabled();
    const parsed = serialOpenParamsSchema.safeParse(args);
    if (!parsed.success)
      throw new ToolError(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid arguments",
      );
    const params = parsed.data;
    const canonicalPath = await this.canonical(params.path);
    if (!matchesAllow(this.allow, params.path, canonicalPath))
      throw new ToolError(
        "FORBIDDEN",
        "Serial port is not in this device's allowlist",
      );
    if (!(await this.binding.available()))
      throw new ToolError(
        "CONFIGURATION_ERROR",
        "Serial support is unavailable on this device (serial module failed to load)",
      );
    const holderId = this.byPath.get(canonicalPath);
    if (holderId || this.opening.has(canonicalPath)) {
      throw new ToolError(
        "SERIAL_PORT_BUSY",
        "serial port is already open in another session",
        {
          holder: this.sessions.get(holderId)?.holder.kind ?? "mcp",
        },
      );
    }
    if (
      [...this.sessions.values()].filter((s) => s.state === "open").length +
        this.opening.size >=
      MAX_SESSIONS
    )
      throw new ToolError("RATE_LIMITED", "too many open serial sessions", {
        reason: "serial_session_limit",
        limit: MAX_SESSIONS,
      });
    this.opening.add(canonicalPath);
    let port;
    try {
      port = await this.binding.open(params);
      // shutdown 期间才完成的 open 不能留下无人管理的端口。
      if (this.closed)
        throw new ToolError("CONFLICT", "executor is shutting down");
      if (params.dtr !== undefined || params.rts !== undefined)
        await port.set({
          ...(params.dtr !== undefined ? { dtr: params.dtr } : {}),
          ...(params.rts !== undefined ? { rts: params.rts } : {}),
        });
    } catch (error) {
      await port?.close().catch(() => undefined);
      throw toSerialError(error);
    } finally {
      this.opening.delete(canonicalPath);
    }
    const session = new SerialSession({
      manager: this,
      id: randomUUID(),
      path: params.path,
      canonicalPath,
      params,
      port,
    });
    this.sessions.set(session.id, session);
    this.byPath.set(canonicalPath, session.id);
    return session.summary();
  }

  get(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0)
      throw new ToolError(
        "VALIDATION_ERROR",
        "sessionId must be a non-empty string",
      );
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new ToolError(
        "NOT_FOUND",
        `serial session not found: ${sessionId}`,
      );
    return session;
  }

  async read({ sessionId, ...rest }, options) {
    return this.get(sessionId).read(rest, options);
  }

  async write({ sessionId, ...rest }, options) {
    return this.get(sessionId).write(rest, options);
  }

  async transact({ sessionId, ...rest }, options) {
    return this.get(sessionId).transact(rest, options);
  }

  async control({ sessionId, ...rest }) {
    return this.get(sessionId).control(rest);
  }

  list() {
    return {
      sessions: [...this.sessions.values()]
        .filter(
          (session) => session.state === "open" || session.state === "lost",
        )
        .map((session) => session.summary()),
    };
  }

  async close({ sessionId }) {
    const session = this.get(sessionId);
    if (session.state === "lost" || session.state === "open")
      await this.finish(session, "closed");
    return { closed: true, sessionId };
  }

  release(session) {
    if (this.byPath.get(session.canonicalPath) === session.id)
      this.byPath.delete(session.canonicalPath);
  }

  teardown(session) {
    clearTimeout(session.idleTimer);
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
    session.streaming = false;
    session.notify();
    this.release(session);
  }

  report(session, reason) {
    if (session.reported) return;
    session.reported = true;
    try {
      this.onSessionClosed?.({
        sessionId: session.id,
        rxBytes: session.rxBytes,
        txBytes: session.txBytes,
        bytesLost: session.bytesLost,
        durationMs: Date.now() - session.openedAtMs,
        reason,
      });
    } catch {
      // 日志回调不能影响端口释放。
    }
  }

  retain(session) {
    session.retentionTimer = unrefTimer(() => {
      this.sessions.delete(session.id);
    }, LOST_RETENTION_MS);
  }

  async finish(session, reason) {
    if (session.state !== "open" && session.state !== "lost") return;
    const wasOpen = session.state === "open";
    session.state = "closing";
    session.closeReason = reason;
    this.teardown(session);
    session.expectedClose = true;
    if (wasOpen) {
      session.emitFrame({ kind: "state", state: { phase: "closed" } });
    }
    try {
      await session.port.close();
    } catch {
      // 端口可能已被拔出；释放仍然继续。
    }
    session.state = "closed";
    clearTimeout(session.retentionTimer);
    this.report(session, reason);
    if (reason === "closed" || reason === "shutdown")
      this.sessions.delete(session.id);
    else this.retain(session);
  }

  lose(session) {
    session.state = "lost";
    session.closeReason = "lost";
    this.teardown(session);
    session.emitFrame({
      kind: "state",
      state: {
        phase: "lost",
        error: {
          code: "SERIAL_PORT_LOST",
          message: "serial port is no longer available",
          requestId: session.id,
        },
      },
    });
    session.expectedClose = true;
    void session.port.close().catch(() => undefined);
    this.report(session, "lost");
    this.retain(session);
  }

  // ---- stream frames ----

  handleStreamFrame(input, sink) {
    if (!this.streamEnabled) return;
    const parsed = streamFrameSchema.safeParse(input);
    if (!parsed.success) return;
    const frame = parsed.data;
    const session = this.sessions.get(frame.sessionId);
    if (!session || (session.state !== "open" && session.state !== "lost")) {
      sink({
        sessionId: frame.sessionId,
        seq: 0,
        kind: "state",
        state: {
          phase: "closed",
          error: {
            code: "NOT_FOUND",
            message: "serial session not found",
            requestId: frame.sessionId,
          },
        },
      });
      return;
    }
    if (frame.seq < session.expectedInSeq) return;
    session.expectedInSeq = frame.seq + 1;
    if (session.state === "lost") {
      session.sink = sink;
      session.emitFrame({
        kind: "state",
        state: {
          phase: "lost",
          error: {
            code: "SERIAL_PORT_LOST",
            message: "serial port is no longer available",
            requestId: session.id,
          },
        },
      });
      return;
    }
    session.touch();
    const attach = (reset = false) =>
      session.attachStream(sink, {
        consumerDeviceId: frame.state?.session?.holder?.consumerDeviceId,
        reset,
      });
    if (frame.kind === "state") {
      const phase = frame.state?.phase;
      if (phase === "opened" || phase === "resumed")
        attach(phase === "resumed");
      else if (phase === "closed") void this.finish(session, "closed");
      return;
    }
    if (!session.streaming || session.sink !== sink) attach();
    if (frame.kind === "ack") {
      session.credit(frame.credit ?? 0);
    } else if (frame.kind === "tx") {
      const buffer = Buffer.from(frame.data, "base64");
      void session
        .exclusive(() => session.writeBytes(buffer))
        .catch((error) => this.reportFrameError(session, error));
    } else if (frame.kind === "control") {
      void session
        .exclusive(() => session.applyControl(frame.control))
        .catch((error) => this.reportFrameError(session, error));
    }
  }

  reportFrameError(session, error) {
    if (session.state === "lost") return;
    const normalized = toSerialError(error);
    session.emitFrame({
      kind: "state",
      state: {
        phase: session.paused ? "paused" : "resumed",
        error: {
          code: normalized.code,
          message:
            normalized.message.slice(0, 500) || "stream operation failed",
          requestId: session.id,
        },
      },
    });
  }

  async shutdown() {
    this.closed = true;
    const active = [...this.sessions.values()].filter(
      (session) => session.state === "open" || session.state === "lost",
    );
    await Promise.all(
      active.map((session) => this.finish(session, "shutdown")),
    );
    for (const session of this.sessions.values())
      clearTimeout(session.retentionTimer);
    this.sessions.clear();
    this.byPath.clear();
  }
}

function stripUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}
