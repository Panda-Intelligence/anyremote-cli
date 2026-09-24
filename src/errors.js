export class ToolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export function toToolError(error, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof ToolError) return error;
  if (error?.code === "ENOENT")
    return new ToolError("NOT_FOUND", error.message);
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new ToolError("FORBIDDEN", error.message);
  }
  if (error?.code === "EEXIST") return new ToolError("CONFLICT", error.message);
  return new ToolError(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
  );
}

export function serializeToolError(error) {
  const normalized = toToolError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    ...(normalized.details ? { details: normalized.details } : {}),
  };
}
