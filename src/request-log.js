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
  return {
    timestamp: new Date(now()).toISOString(),
    requestId,
    tool,
    status: safeStatus(event.status),
    elapsedMs: safeElapsedMs(event.elapsedMs),
  };
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
