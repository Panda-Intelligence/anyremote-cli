import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const ErrorCode = Object.freeze({
  BAD_REQUEST: "BAD_REQUEST",
  CONFLICT: "CONFLICT",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  DEVICE_LIMIT_REACHED: "DEVICE_LIMIT_REACHED",
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  FILE_CONFLICT: "FILE_CONFLICT",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  INVALID_PAIRING: "INVALID_PAIRING",
  NOT_FOUND: "NOT_FOUND",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  PROCESS_LOST: "PROCESS_LOST",
  PROCESS_NOT_FOUND: "PROCESS_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
});

export const errorCodeSchema = z.enum([
  ErrorCode.BAD_REQUEST,
  ErrorCode.CONFLICT,
  ErrorCode.CONFIGURATION_ERROR,
  ErrorCode.DEVICE_LIMIT_REACHED,
  ErrorCode.DEVICE_OFFLINE,
  ErrorCode.FILE_CONFLICT,
  ErrorCode.FORBIDDEN,
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.INVALID_CREDENTIALS,
  ErrorCode.INVALID_PAIRING,
  ErrorCode.NOT_FOUND,
  ErrorCode.OUTCOME_UNKNOWN,
  ErrorCode.PAYMENT_REQUIRED,
  ErrorCode.PROCESS_LOST,
  ErrorCode.PROCESS_NOT_FOUND,
  ErrorCode.RATE_LIMITED,
  ErrorCode.QUOTA_EXCEEDED,
  ErrorCode.REQUEST_TIMEOUT,
  ErrorCode.SERVICE_UNAVAILABLE,
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.VALIDATION_ERROR,
]);

export const idSchema = z.string().trim().min(1).max(128);
export const requestIdSchema = z.string().trim().min(1).max(128);
export const isoTimestampSchema = z.string().datetime({ offset: true });

export const platformSchema = z.enum(["macos", "linux", "windows"]);
export const deviceStatusSchema = z.enum(["online", "offline", "revoked"]);

export const deviceSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  name: z.string().trim().min(1).max(120),
  platform: platformSchema,
  agentVersion: z.string().trim().min(1).max(64),
  status: deviceStatusSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  lastSeenAt: isoTimestampSchema.nullable(),
  revokedAt: isoTimestampSchema.nullable(),
});

export const pairingStatusSchema = z.enum([
  "pending",
  "approved",
  "expired",
  "revoked",
]);
export const pairingSchema = z.object({
  id: idSchema,
  code: z.string().regex(/^[A-Z0-9]{6,12}$/),
  status: pairingStatusSchema,
  expiresAt: isoTimestampSchema,
  pollIntervalSeconds: z.number().int().positive().max(60),
  verificationUri: z.string().url(),
});

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1).max(500),
  requestId: requestIdSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});

export const apiSuccessSchema = z.object({
  data: z.unknown(),
});

export const apiFailureSchema = z.object({
  error: apiErrorSchema,
});

export const authUserSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  name: z.string().min(1).max(120),
});

export const connectionMessageTypeSchema = z.enum([
  "hello",
  "heartbeat",
  "request",
  "result",
  "cancel",
  "error",
]);

export const toolRequestSchema = z.object({
  requestId: requestIdSchema,
  deviceId: idSchema,
  tool: z.string().trim().min(1).max(120),
  arguments: z.record(z.string(), z.unknown()),
  deadline: isoTimestampSchema,
});

export const toolResultSchema = z.object({
  requestId: requestIdSchema,
  deviceId: idSchema,
  status: z.enum(["success", "error", "unknown"]),
  output: z.unknown().optional(),
  error: apiErrorSchema.optional(),
});

export const MAX_SCREEN_CAPTURE_BYTES = 1024 * 1024;
export const MAX_SCREEN_CAPTURE_EDGE = 8192;
export const MAX_SCREEN_CAPTURE_PIXELS = 33_554_432;

/**
 * @param {{ data?: unknown, byteLength?: unknown, width?: unknown, height?: unknown }} value
 * @param {{ addIssue: (issue: { code: "custom", message: string }) => void }} context
 */
function screenCapturePngIssue(value, context) {
  if (typeof value.data !== "string") return;
  const data = value.data;
  if (
    data.length < 44 ||
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "data must be canonical base64",
    });
    return;
  }

  let decoded;
  try {
    decoded = atob(data);
  } catch {
    context.addIssue({ code: "custom", message: "data must be valid base64" });
    return;
  }
  if (btoa(decoded) !== data) {
    context.addIssue({
      code: "custom",
      message: "data must be canonical base64",
    });
    return;
  }

  const byteLength = decoded.length;
  if (byteLength !== value.byteLength) {
    context.addIssue({
      code: "custom",
      message: "byteLength does not match data",
    });
    return;
  }
  if (byteLength > MAX_SCREEN_CAPTURE_BYTES) {
    context.addIssue({
      code: "custom",
      message: "image exceeds the byte limit",
    });
    return;
  }

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index += 1) {
    if (decoded.charCodeAt(index) !== signature[index]) {
      context.addIssue({ code: "custom", message: "data must be a PNG image" });
      return;
    }
  }
  const view = new DataView(
    Uint8Array.from(decoded.slice(8, 24), (character) =>
      character.charCodeAt(0),
    ).buffer,
  );
  if (
    view.getUint32(0) !== 13 ||
    decoded.slice(12, 16) !== "IHDR" ||
    view.getUint32(8) !== value.width ||
    view.getUint32(12) !== value.height
  ) {
    context.addIssue({
      code: "custom",
      message: "PNG dimensions do not match metadata",
    });
  }
}

export const screenCaptureResultSchema = z
  .object({
    kind: z.literal("screen.capture"),
    captureId: z.string().uuid(),
    mimeType: z.literal("image/png"),
    data: z
      .string()
      .min(44)
      .max(Math.ceil(MAX_SCREEN_CAPTURE_BYTES / 3) * 4),
    byteLength: z.number().int().positive().max(MAX_SCREEN_CAPTURE_BYTES),
    width: z.number().int().positive().max(MAX_SCREEN_CAPTURE_EDGE),
    height: z.number().int().positive().max(MAX_SCREEN_CAPTURE_EDGE),
  })
  .strict()
  .superRefine(
    /** @param {{ width: number, height: number } & Parameters<typeof screenCapturePngIssue>[0]} value @param {Parameters<typeof screenCapturePngIssue>[1]} context */
    (value, context) => {
      if (value.width * value.height > MAX_SCREEN_CAPTURE_PIXELS) {
        context.addIssue({
          code: "custom",
          message: "image exceeds the pixel limit",
        });
        return;
      }
      screenCapturePngIssue(value, context);
    },
  );

export const connectionEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: connectionMessageTypeSchema,
  requestId: requestIdSchema,
  deviceId: idSchema,
  connectionEpoch: z.string().trim().min(1).max(128),
  payload: z.unknown(),
});

/** @typedef {z.infer<typeof deviceSchema>} Device */
/** @typedef {z.infer<typeof pairingSchema>} Pairing */
/** @typedef {z.infer<typeof authUserSchema>} AuthUser */
/** @typedef {z.infer<typeof apiErrorSchema>} ApiError */
/** @typedef {typeof ErrorCode[keyof typeof ErrorCode]} ErrorCode */
/** @typedef {z.infer<typeof connectionMessageTypeSchema>} ConnectionMessageType */
/** @typedef {z.infer<typeof connectionEnvelopeSchema>} ConnectionEnvelope */
/** @typedef {z.infer<typeof toolRequestSchema>} ToolRequest */
/** @typedef {z.infer<typeof toolResultSchema>} ToolResult */
/** @template T @typedef {{data: T}} ApiSuccess */
/** @typedef {{error: ApiError}} ApiFailure */

/** @template T @param {T} data @returns {ApiSuccess<T>} */
export function success(data) {
  return { data };
}

/** @param {ApiError} error @returns {ApiFailure} */
export function failure(error) {
  return { error };
}

/** @template T @param {z.ZodType<T>} schema @param {unknown} value @returns {T} */
export function parseOrThrow(schema, value) {
  return schema.parse(value);
}
