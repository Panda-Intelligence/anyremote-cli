import process from "node:process";

const SAFE_STATUSES = new Set(["success", "error", "unknown"]);

function safeStatus(status) {
  return SAFE_STATUSES.has(status) ? status : "error";
}

function safeElapsedMs(elapsedMs) {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, Math.round(elapsedMs));
}

/**
 * 只从已经裁剪过的 request 事件中提取固定字段。
 * 不接收或序列化工具参数、结果、路径、命令、环境变量和 token。
 */
export function formatRequestLog(event, { now = Date.now } = {}) {
  if (!event || typeof event !== "object") return null;
  const requestId =
    typeof event.requestId === "string" && event.requestId.length <= 200
      ? event.requestId
      : "unknown";
  const tool =
    typeof event.tool === "string" && event.tool.length <= 200
      ? event.tool
      : "unknown";
  const record = {
    timestamp: new Date(now()).toISOString(),
    requestId,
    tool,
    status: safeStatus(event.status),
    elapsedMs: safeElapsedMs(event.elapsedMs),
  };
  if (event.executionMs !== undefined)
    record.executionMs = safeElapsedMs(event.executionMs);
  if (event.resultBytes !== undefined)
    record.resultBytes =
      Number.isSafeInteger(event.resultBytes) && event.resultBytes >= 0
        ? event.resultBytes
        : 0;
  return record;
}

/**
 * 创建 CLI 本地请求日志监听器。日志固定写 stderr，stdout 保留给命令输出。
 */
export function createRequestLogger({
  write = (line) => process.stderr.write(line),
  now = Date.now,
} = {}) {
  return (event) => {
    const record = formatRequestLog(event, { now });
    if (!record) return;
    write(`${JSON.stringify(record)}\n`);
  };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * 串口会话结束时的计数行：只含会话编号和字节计数，路径固定写占位符，
 * 不记录任何串口数据或参数。
 */
export function formatSerialSessionLog(event, { now = Date.now } = {}) {
  if (!event || typeof event !== "object") return null;
  return {
    timestamp: new Date(now()).toISOString(),
    event: "serial.session.closed",
    sessionId:
      typeof event.sessionId === "string" && event.sessionId.length <= 200
        ? event.sessionId
        : "unknown",
    path: "<redacted>",
    rxBytes: safeCount(event.rxBytes),
    txBytes: safeCount(event.txBytes),
    bytesLost: safeCount(event.bytesLost),
    durationMs: safeCount(Math.round(event.durationMs)),
  };
}

export function createSerialSessionLogger({
  write = (line) => process.stderr.write(line),
  now = Date.now,
} = {}) {
  return (event) => {
    const record = formatSerialSessionLog(event, { now });
    if (!record) return;
    write(`${JSON.stringify(record)}\n`);
  };
}
