import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createReadStream,
  existsSync,
  constants as fsConstants,
  statSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { ToolError, toToolError } from "./errors.js";
import { defaultShell } from "./platform.js";
import { captureScreen } from "./screen-capture.js";

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_SEARCH_FILES = 10_000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_RESULT_PAGE_BYTES = 64 * 1024;
const DEFAULT_PROCESS_WAIT_MS = 1000;
const MAX_PROCESS_WAIT_MS = 10_000;
const DEADLINE_RESPONSE_MARGIN_MS = 10;

function assertString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ToolError(
      "VALIDATION_ERROR",
      `${name} must be a non-empty string`,
    );
  }
}

function limitInteger(value, name, fallback, maximum, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolError(
      "VALIDATION_ERROR",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function versionForBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function utf8SafeLength(buffer, limit) {
  const end = Math.min(buffer.byteLength, limit);
  let lead = end - 1;
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return end;
  const first = buffer[lead];
  const expected =
    first < 0x80
      ? 1
      : first >= 0xc2 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : 1;
  return end - lead < expected ? lead : end;
}

async function readFileVersion(filePath) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function resolvePath(input) {
  assertString(input, "path");
  if (input === "~")
    return process.env.HOME || process.env.USERPROFILE || process.cwd();
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(
      process.env.HOME || process.env.USERPROFILE || process.cwd(),
      input.slice(2),
    );
  }
  return path.resolve(input);
}

function decodeContent(content, encoding = "utf8") {
  assertString(content, "content", { allowEmpty: true });
  if (encoding === "base64") {
    const normalized = content.replace(/=+$/, "");
    const validShape =
      /^[A-Za-z0-9+/]*={0,2}$/.test(content) && content.length % 4 !== 1;
    const buffer = Buffer.from(content, "base64");
    if (
      !validShape ||
      buffer.toString("base64").replace(/=+$/, "") !== normalized
    )
      throw new ToolError("VALIDATION_ERROR", "content is not valid base64");
    return buffer;
  }
  if (encoding !== "utf8")
    throw new ToolError("VALIDATION_ERROR", "encoding must be utf8 or base64");
  return Buffer.from(content, "utf8");
}

function normalizeToolArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ToolError("VALIDATION_ERROR", "arguments must be an object");
  }
  return args;
}

function processResponseOptions({ waitMs, maxBytes }, options) {
  const wait = limitInteger(
    waitMs,
    "waitMs",
    DEFAULT_PROCESS_WAIT_MS,
    MAX_PROCESS_WAIT_MS,
    0,
  );
  const max = limitInteger(
    maxBytes,
    "maxBytes",
    DEFAULT_RESULT_PAGE_BYTES,
    DEFAULT_RESULT_PAGE_BYTES,
  );
  if (
    options.deadline !== undefined &&
    (!Number.isFinite(options.deadline) || options.deadline <= Date.now())
  )
    throw new ToolError("REQUEST_TIMEOUT", "request deadline exceeded");
  if (options.signal?.aborted)
    throw new ToolError("REQUEST_TIMEOUT", "request was cancelled");
  return { wait, max };
}

class ProcessState extends EventEmitter {
  constructor({ id, child, maxOutputBytes }) {
    super();
    this.id = id;
    this.child = child;
    this.maxOutputBytes = maxOutputBytes;
    this.events = [];
    this.outputBytes = 0;
    this.cursor = 0;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.exitCode = null;
    this.signal = null;
    this.error = null;
    // 并发读者各自清理等待监听；数量不受单个流默认的十个监听限制。
    this.setMaxListeners(0);
    this.attach();
  }

  attach() {
    // 原生流解码器先拼完 UTF-8 字符；游标只计算进入正文缓冲的字节。
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    const append = (stream, chunk) => {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      if (buffer.byteLength === 0) return;
      const startCursor = this.cursor;
      this.cursor += buffer.byteLength;
      this.events.push({ startCursor, endCursor: this.cursor, stream, buffer });
      this.outputBytes += buffer.byteLength;
      while (this.outputBytes > this.maxOutputBytes && this.events.length > 1) {
        const removed = this.events.shift();
        this.outputBytes -= removed.buffer.byteLength;
      }
      if (this.outputBytes > this.maxOutputBytes && this.events.length === 1) {
        const only = this.events[0];
        only.buffer = only.buffer.subarray(
          only.buffer.byteLength - this.maxOutputBytes,
        );
        only.startCursor = only.endCursor - only.buffer.byteLength;
        this.outputBytes = only.buffer.byteLength;
      }
      this.emit("changed");
    };
    this.child.stdout?.on("data", (chunk) => append("stdout", chunk));
    this.child.stderr?.on("data", (chunk) => append("stderr", chunk));
    this.child.stdin?.on("error", () => undefined);
    this.child.once("error", (error) => {
      this.error = toToolError(error);
      this.finishedAt = new Date().toISOString();
      this.emit("changed");
    });
    this.child.once("close", (exitCode, signal) => {
      this.exitCode = exitCode;
      this.signal = signal;
      this.finishedAt = new Date().toISOString();
      this.emit("changed");
    });
  }

  read(cursor = 0, maxBytes = DEFAULT_RESULT_PAGE_BYTES) {
    if (!Number.isInteger(cursor) || cursor < 0)
      throw new ToolError(
        "VALIDATION_ERROR",
        "cursor must be a non-negative integer",
      );
    const outputStartCursor = this.events[0]?.startCursor ?? this.cursor;
    const start = Math.max(cursor, outputStartCursor);
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let nextCursor = start;
    for (const event of this.events) {
      if (event.endCursor <= start) continue;
      const from = Math.max(start, event.startCursor) - event.startCursor;
      const limit = Math.min(event.buffer.byteLength - from, maxBytes - bytes);
      const take = utf8SafeLength(
        event.buffer.subarray(from, from + limit),
        limit,
      );
      if (take <= 0) break;
      const part = event.buffer.subarray(from, from + take);
      bytes += part.byteLength;
      nextCursor = event.startCursor + from + part.byteLength;
      (event.stream === "stderr" ? stderr : stdout).push(part);
      if (bytes >= maxBytes) break;
    }
    const decode = (buffer) => {
      let leading = 0;
      // 淘汰或显式游标可能从多字节字符中间开始；丢失部分不生成伪造正文。
      while (leading < buffer.byteLength && (buffer[leading] & 0xc0) === 0x80)
        leading += 1;
      return new StringDecoder("utf8").end(buffer.subarray(leading));
    };
    return {
      stdout: decode(Buffer.concat(stdout)),
      stderr: decode(Buffer.concat(stderr)),
      nextCursor,
      outputStartCursor,
      truncated: cursor < outputStartCursor || this.cursor > nextCursor,
      exited: this.finishedAt !== null,
      exitCode: this.exitCode,
      signal: this.signal,
      error:
        this.error?.message ||
        (nextCursor === start
          ? this.pageSizeError(start, maxBytes)
          : undefined),
    };
  }

  pageSizeError(cursor, maxBytes) {
    const first = this.events.find((event) => event.endCursor > cursor);
    if (!first) return undefined;
    const bytes = [];
    // 只前瞻首个字符的最多四个字节，未写完的流不误判成小页错误。
    for (const event of this.events) {
      if (event.stream !== first.stream || event.endCursor <= cursor) continue;
      const from = Math.max(cursor, event.startCursor) - event.startCursor;
      for (let offset = from; offset < event.buffer.byteLength; offset += 1) {
        bytes.push(event.buffer[offset]);
        const prefix = Buffer.from(bytes);
        if (utf8SafeLength(prefix, prefix.byteLength) > 0) {
          const needed = event.startCursor + offset + 1 - cursor;
          return needed > maxBytes
            ? `VALIDATION_ERROR: maxBytes cannot hold the next complete UTF-8 character. Read this process again at cursor ${cursor} with maxBytes at least ${needed}.`
            : undefined;
        }
        if (bytes.length === 4) return undefined;
      }
    }
    return undefined;
  }

  async wait({ cursor = 0, waitMs, untilExit = false, deadline, signal }) {
    const ready = () =>
      this.finishedAt !== null || (!untilExit && this.cursor > cursor);
    const budget =
      deadline === undefined
        ? waitMs
        : Math.min(
            waitMs,
            Math.max(0, deadline - Date.now() - DEADLINE_RESPONSE_MARGIN_MS),
          );
    if (ready() || budget <= 0) return;
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("changed", changed);
        signal?.removeEventListener("abort", cancelled);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const changed = () => {
        if (ready()) finish();
      };
      const cancelled = () => {
        cleanup();
        reject(new ToolError("REQUEST_TIMEOUT", "request was cancelled"));
      };
      this.on("changed", changed);
      signal?.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(finish, budget);
      if (signal?.aborted) cancelled();
      else changed();
    });
  }

  summary() {
    return {
      processId: this.id,
      pid: this.child.pid,
      command: this.child.spawnargs?.join(" "),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      exitCode: this.exitCode,
      signal: this.signal,
      running: this.finishedAt === null,
    };
  }
}

export class LocalToolExecutor {
  constructor({
    maxReadBytes = DEFAULT_MAX_READ_BYTES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxSearchFiles = DEFAULT_MAX_SEARCH_FILES,
    screenCapture = captureScreen,
  } = {}) {
    this.maxReadBytes = maxReadBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.maxSearchFiles = maxSearchFiles;
    this.screenCapture = screenCapture;
    this.processes = new Map();
    this.nextProcessId = 1;
    this.shutdownPromise = null;
  }

  async execute(tool, input, options = {}) {
    const args = normalizeToolArguments(input);
    try {
      switch (tool) {
        case "files.list":
          return await this.listFiles(args);
        case "files.read":
          return await this.readFile(args);
        case "files.write":
          return await this.writeFile(args);
        case "files.move":
          return await this.moveFile(args);
        case "files.mkdir":
          return await this.makeDirectory(args);
        case "files.search":
          return await this.searchFiles(args);
        case "screen.capture":
          return await this.screenCapture();
        case "process.start":
          return await this.startProcess(args, options);
        case "process.read":
          return await this.readProcess(args, options);
        case "process.write":
          return await this.writeProcess(args, options);
        case "process.list":
          return this.listProcesses();
        case "process.stop":
          return await this.stopProcess(args);
        default:
          throw new ToolError("NOT_FOUND", `unknown tool: ${tool}`);
      }
    } catch (error) {
      throw toToolError(error);
    }
  }

  async listFiles({ path: inputPath, cursor = 0, limit = 100 } = {}) {
    const directory = resolvePath(inputPath);
    const pageSize = limitInteger(limit, "limit", 100, 500);
    if (!Number.isInteger(cursor) || cursor < 0)
      throw new ToolError(
        "VALIDATION_ERROR",
        "cursor must be a non-negative integer",
      );
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const page = entries.slice(cursor, cursor + pageSize);
    return {
      path: directory,
      entries: await Promise.all(
        page.map(async (entry) => {
          const entryPath = path.join(directory, entry.name);
          let stat;
          try {
            stat = await fs.stat(entryPath);
          } catch {
            stat = null;
          }
          return {
            name: entry.name,
            path: entryPath,
            type: entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "file",
            size: stat?.size ?? null,
            modifiedAt: stat?.mtime?.toISOString() ?? null,
          };
        }),
      ),
      nextCursor:
        cursor + page.length < entries.length ? cursor + page.length : null,
    };
  }

  async readFile({
    path: inputPath,
    encoding = "utf8",
    cursor = 0,
    maxBytes = this.maxReadBytes,
  } = {}) {
    const filePath = resolvePath(inputPath);
    const max = limitInteger(
      maxBytes,
      "maxBytes",
      this.maxReadBytes,
      this.maxReadBytes,
    );
    if (!Number.isInteger(cursor) || cursor < 0)
      throw new ToolError(
        "VALIDATION_ERROR",
        "cursor must be a non-negative integer",
      );
    if (encoding !== "base64" && encoding !== "utf8")
      throw new ToolError(
        "VALIDATION_ERROR",
        "encoding must be utf8 or base64",
      );
    const handle = await fs.open(filePath, fsConstants.O_RDONLY);
    try {
      const stat = await handle.stat();
      if (cursor > stat.size)
        throw new ToolError("VALIDATION_ERROR", "cursor is past end of file");
      const length = Math.min(max, stat.size - cursor);
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, cursor);
      const outputBuffer =
        encoding === "utf8" && length < stat.size - cursor
          ? buffer.subarray(0, utf8SafeLength(buffer, length) || length)
          : buffer;
      const output =
        encoding === "base64"
          ? outputBuffer.toString("base64")
          : outputBuffer.toString("utf8");
      return {
        path: filePath,
        encoding,
        content: output,
        size: stat.size,
        cursor,
        nextCursor:
          cursor + outputBuffer.byteLength < stat.size
            ? cursor + outputBuffer.byteLength
            : null,
        truncated: cursor + outputBuffer.byteLength < stat.size,
        ...(outputBuffer.byteLength === stat.size
          ? { version: versionForBuffer(outputBuffer) }
          : {}),
        modifiedAt: stat.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  async writeFile({
    path: inputPath,
    content,
    encoding = "utf8",
    expectedVersion,
  } = {}) {
    const filePath = resolvePath(inputPath);
    const buffer = decodeContent(content, encoding);
    if (buffer.byteLength > this.maxReadBytes)
      throw new ToolError(
        "RATE_LIMITED",
        `content exceeds maxBytes (${this.maxReadBytes})`,
      );
    if (expectedVersion !== undefined) {
      const currentVersion = await readFileVersion(filePath);
      if (currentVersion !== expectedVersion) {
        throw new ToolError(
          "CONFLICT",
          "file version does not match expectedVersion",
          { expectedVersion, currentVersion },
        );
      }
    }
    await fs.writeFile(filePath, buffer, { flag: "w" });
    return {
      path: filePath,
      size: buffer.byteLength,
      version: versionForBuffer(buffer),
    };
  }

  async moveFile({ source, destination, overwrite = false } = {}) {
    const from = resolvePath(source);
    const to = resolvePath(destination);
    if (!overwrite) {
      try {
        await fs.access(to);
        throw new ToolError("CONFLICT", "destination already exists");
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await fs.rename(from, to);
    return { source: from, destination: to };
  }

  async makeDirectory({ path: inputPath, recursive = true } = {}) {
    const directory = resolvePath(inputPath);
    await fs.mkdir(directory, { recursive: Boolean(recursive) });
    return { path: directory, created: true };
  }

  async searchFiles({
    root,
    query,
    mode = "filename",
    cursor = 0,
    limit = DEFAULT_MAX_SEARCH_RESULTS,
    caseSensitive = false,
    maxFiles = this.maxSearchFiles,
  } = {}) {
    const rootPath = resolvePath(root);
    assertString(query, "query");
    if (mode !== "filename" && mode !== "content")
      throw new ToolError(
        "VALIDATION_ERROR",
        "mode must be filename or content",
      );
    const pageSize = limitInteger(
      limit,
      "limit",
      DEFAULT_MAX_SEARCH_RESULTS,
      500,
    );
    const fileLimit = limitInteger(
      maxFiles,
      "maxFiles",
      this.maxSearchFiles,
      this.maxSearchFiles,
    );
    if (!Number.isInteger(cursor) || cursor < 0)
      throw new ToolError(
        "VALIDATION_ERROR",
        "cursor must be a non-negative integer",
      );
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches = [];
    let visited = 0;
    let truncated = false;
    const walk = async (directory) => {
      if (visited >= fileLimit) {
        truncated = true;
        return;
      }
      if (matches.length > cursor + pageSize) return;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (visited >= fileLimit) {
          truncated = true;
          break;
        }
        if (matches.length > cursor + pageSize) break;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        visited += 1;
        let matched = false;
        let preview;
        if (mode === "filename") {
          const candidate = caseSensitive
            ? entry.name
            : entry.name.toLocaleLowerCase();
          matched = candidate.includes(needle);
        } else {
          try {
            const stat = await fs.stat(entryPath);
            if (stat.size <= this.maxReadBytes) {
              const text = await fs.readFile(entryPath, "utf8");
              const candidate = caseSensitive ? text : text.toLocaleLowerCase();
              matched = candidate.includes(needle);
              if (matched)
                preview = text.slice(
                  Math.max(0, candidate.indexOf(needle) - 80),
                  Math.min(
                    text.length,
                    candidate.indexOf(needle) + query.length + 80,
                  ),
                );
            }
          } catch {
            matched = false;
          }
        }
        if (matched)
          matches.push({
            path: entryPath,
            name: entry.name,
            ...(preview ? { preview } : {}),
            index: matches.length,
          });
      }
    };
    await walk(rootPath);
    const page = matches.slice(cursor, cursor + pageSize);
    const hasMoreMatches = matches.length > cursor + pageSize;
    return {
      root: rootPath,
      mode,
      matches: page,
      nextCursor:
        page.length === pageSize && (hasMoreMatches || truncated)
          ? cursor + page.length
          : null,
      scannedFiles: visited,
      truncated: truncated || hasMoreMatches,
    };
  }

  async startProcess(
    { command, args = [], cwd, shell = false, env, waitMs, maxBytes } = {},
    options = {},
  ) {
    if (this.shutdownPromise)
      throw new ToolError("CONFLICT", "executor is shutting down");
    const { wait, max } = processResponseOptions({ waitMs, maxBytes }, options);
    assertString(command, "command");
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string"))
      throw new ToolError(
        "VALIDATION_ERROR",
        "args must be an array of strings",
      );
    const workingDirectory = cwd ? resolvePath(cwd) : process.cwd();
    if (
      !existsSync(workingDirectory) ||
      !statSync(workingDirectory).isDirectory()
    )
      throw new ToolError(
        "NOT_FOUND",
        `cwd does not exist: ${workingDirectory}`,
      );
    const child = spawn(command, args, {
      cwd: workingDirectory,
      env:
        env && typeof env === "object"
          ? { ...process.env, ...env }
          : process.env,
      shell:
        shell === true
          ? defaultShell()
          : typeof shell === "string"
            ? shell
            : false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const processId = `proc-${process.pid}-${this.nextProcessId++}`;
    const state = new ProcessState({
      id: processId,
      child,
      maxOutputBytes: options.maxOutputBytes || this.maxOutputBytes,
    });
    this.processes.set(processId, state);
    await state.wait({ ...options, waitMs: wait, untilExit: true });
    return { ...state.summary(), ...state.read(0, max) };
  }

  getProcess(processId) {
    assertString(processId, "processId");
    const state = this.processes.get(processId);
    if (!state)
      throw new ToolError("NOT_FOUND", `process not found: ${processId}`);
    return state;
  }

  async readProcess(
    { processId, cursor = 0, maxBytes, waitMs } = {},
    options = {},
  ) {
    const state = this.getProcess(processId);
    const { wait, max } = processResponseOptions({ waitMs, maxBytes }, options);
    limitInteger(cursor, "cursor", 0, Number.MAX_SAFE_INTEGER, 0);
    await state.wait({ ...options, cursor, waitMs: wait });
    return { ...state.summary(), ...state.read(cursor, max) };
  }

  async writeProcess(
    { processId, stdin, eof = false, cursor, maxBytes, waitMs } = {},
    options = {},
  ) {
    const state = this.getProcess(processId);
    const { wait, max } = processResponseOptions({ waitMs, maxBytes }, options);
    const outputCursor = cursor === undefined ? state.cursor : cursor;
    limitInteger(outputCursor, "cursor", 0, Number.MAX_SAFE_INTEGER, 0);
    if (typeof stdin !== "string")
      throw new ToolError("VALIDATION_ERROR", "stdin must be a string");
    if (state.finishedAt) throw new ToolError("CONFLICT", "process has exited");
    if (
      !state.child.stdin ||
      state.child.stdin.destroyed ||
      state.child.stdin.writableEnded
    )
      throw new ToolError("CONFLICT", "process stdin is closed");
    try {
      state.child.stdin.write(stdin);
      if (eof) state.child.stdin.end();
    } catch (error) {
      throw new ToolError(
        "CONFLICT",
        `process stdin is unavailable: ${error.message}`,
      );
    }
    await state.wait({ ...options, cursor: outputCursor, waitMs: wait });
    return {
      ...state.summary(),
      ...state.read(outputCursor, max),
      accepted: true,
      eof: Boolean(eof),
    };
  }

  listProcesses() {
    return {
      processes: [...this.processes.values()].map((state) => state.summary()),
    };
  }

  shutdown({ graceMs = 1000 } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    // 只终止本实例仍持有的任务；断线重连不调用此终结操作。
    this.shutdownPromise = (async () => {
      const active = [...this.processes.values()].filter(
        (state) => !state.finishedAt,
      );
      await Promise.all(
        active.map((state) => this.stopProcess({ processId: state.id })),
      );
      const wait = async (milliseconds) => {
        const deadline = Date.now() + milliseconds;
        while (
          active.some((state) => !state.finishedAt) &&
          Date.now() < deadline
        )
          await delay(25);
      };
      await wait(graceMs);
      await Promise.all(
        active
          .filter((state) => !state.finishedAt)
          .map((state) =>
            this.stopProcess({ processId: state.id, force: true }),
          ),
      );
      await wait(1000);
      if (active.some((state) => !state.finishedAt))
        throw new ToolError(
          "CONFLICT",
          "Managed processes did not stop before shutdown deadline",
        );
    })();
    return this.shutdownPromise;
  }

  async stopProcess({ processId, force = false } = {}) {
    const state = this.getProcess(processId);
    if (state.finishedAt) return { ...state.summary(), stopped: false };
    if (process.platform === "win32" && state.child.pid) {
      await new Promise((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/PID", String(state.child.pid), "/T", ...(force ? ["/F"] : [])],
          { windowsHide: true, timeout: 2000 },
        );
        killer.once("close", resolve);
        killer.once("error", resolve);
      });
    } else {
      try {
        process.kill(-(state.child.pid || 0), force ? "SIGKILL" : "SIGTERM");
      } catch {
        state.child.kill(force ? "SIGKILL" : "SIGTERM");
      }
    }
    return { ...state.summary(), stopped: true };
  }
}

export function createLocalToolExecutor(options) {
  return new LocalToolExecutor(options);
}
