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
  SERIAL_PORT_BUSY: "SERIAL_PORT_BUSY",
  SERIAL_PORT_LOST: "SERIAL_PORT_LOST",
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
  ErrorCode.SERIAL_PORT_BUSY,
  ErrorCode.SERIAL_PORT_LOST,
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
  "stream",
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

export const MIN_SERIAL_AGENT_VERSION = "0.3.0";
export const MAX_SERIAL_READ_BYTES = 65_536;
export const MAX_SERIAL_WRITE_BYTES = 65_536;
export const MAX_SERIAL_WAIT_MS = 10_000;
export const MAX_STREAM_FRAME_BYTES = 16_384;
export const STREAM_WINDOW_BYTES = 262_144;
export const MAX_STREAM_REPLAY_BYTES = 262_144;
export const MAX_SERIAL_SEQUENCE_STEPS = 16;
export const MAX_SERIAL_SEQUENCE_MS = 5000;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const capabilitySchema = z.string().regex(/^[a-z][a-z0-9.-]{1,39}$/);

export const serialParitySchema = z.enum([
  "none",
  "even",
  "odd",
  "mark",
  "space",
]);
export const serialStateSchema = z.enum(["open", "closing", "lost", "closed"]);

export const serialPortInfoSchema = z
  .object({
    path: z.string().min(1).max(255),
    manufacturer: z.string().max(255).optional(),
    serialNumber: z.string().max(255).optional(),
    vendorId: z.string().max(16).optional(),
    productId: z.string().max(16).optional(),
    allowed: z.boolean().optional(),
  })
  .strict();

export const serialOpenParamsSchema = z
  .object({
    path: z.string().min(1).max(255),
    baudRate: z.number().int().min(50).max(4_000_000).default(115_200),
    dataBits: z
      .union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)])
      .default(8),
    parity: serialParitySchema.default("none"),
    stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
    flowControl: z.enum(["none", "rtscts", "xonxoff"]).default("none"),
    dtr: z.boolean().optional(),
    rts: z.boolean().optional(),
    bufferBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(4 * 1024 * 1024)
      .default(1024 * 1024),
    idleTimeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(6 * 60 * 60 * 1000)
      .default(10 * 60 * 1000),
  })
  .strict();

export const serialSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    deviceId: idSchema,
    path: z.string().min(1).max(255),
    params: serialOpenParamsSchema,
    openedAt: isoTimestampSchema,
    lastActivityAt: isoTimestampSchema,
    holder: z
      .object({
        kind: z.enum(["mcp", "stream"]),
        consumerDeviceId: idSchema.optional(),
      })
      .strict(),
    rxCursor: z.number().int().min(0),
    txBytes: z.number().int().min(0),
    bytesLost: z.number().int().min(0),
    state: serialStateSchema,
  })
  .strict();

export const serialControlSchema = z
  .object({
    dtr: z.boolean().optional(),
    rts: z.boolean().optional(),
    breakMs: z.number().int().min(1).max(2000).optional(),
    purge: z.enum(["rx", "tx", "both"]).optional(),
    baudRate: z.number().int().min(50).max(4_000_000).optional(),
    sequence: z
      .array(
        z
          .object({
            dtr: z.boolean().optional(),
            rts: z.boolean().optional(),
            delayMs: z.number().int().min(0).max(2000),
          })
          .strict(),
      )
      .max(MAX_SERIAL_SEQUENCE_STEPS)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const total = (value.sequence ?? []).reduce(
      (sum, step) => sum + step.delayMs,
      0,
    );
    if (total > MAX_SERIAL_SEQUENCE_MS)
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: `sequence total delay must not exceed ${MAX_SERIAL_SEQUENCE_MS} ms`,
      });
  });

export const serialLineStateSchema = z
  .object({
    cts: z.boolean(),
    dsr: z.boolean(),
    dcd: z.boolean(),
    ri: z.boolean(),
  })
  .strict();

export const serialReadResultSchema = z
  .object({
    sessionId: z.string().uuid(),
    data: z.string(),
    encoding: z.enum(["utf8", "hex", "base64"]),
    nextCursor: z.number().int().min(0),
    bufferStartCursor: z.number().int().min(0),
    bytesLost: z.number().int().min(0),
    truncated: z.boolean(),
    matched: z.boolean().optional(),
    lineState: serialLineStateSchema,
    state: serialStateSchema,
  })
  .strict();

const streamDataSchema = z
  .string()
  .max(Math.ceil(MAX_STREAM_FRAME_BYTES / 3) * 4)
  .regex(BASE64_PATTERN);

export const streamFrameSchema = z
  .object({
    sessionId: z.string().uuid(),
    seq: z.number().int().min(0),
    kind: z.enum(["rx", "tx", "control", "ack", "state"]),
    data: streamDataSchema.optional(),
    control: serialControlSchema.optional(),
    credit: z.number().int().min(0).max(STREAM_WINDOW_BYTES).optional(),
    state: z
      .object({
        phase: z.enum(["opened", "resumed", "paused", "lost", "closed"]),
        session: serialSessionSchema.optional(),
        lastSeq: z.number().int().min(0).optional(),
        bytesLost: z.number().int().min(0).optional(),
        error: apiErrorSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    /** @type {"data" | "control" | "credit" | "state"} */
    const required = {
      rx: /** @type {const} */ ("data"),
      tx: /** @type {const} */ ("data"),
      control: /** @type {const} */ ("control"),
      ack: /** @type {const} */ ("credit"),
      state: /** @type {const} */ ("state"),
    }[value.kind];
    if (value[required] === undefined)
      context.addIssue({
        code: "custom",
        path: [required],
        message: `${value.kind} frames require ${required}`,
      });
  });

export const helloPayloadSchema = z.looseObject({
  deviceToken: z.string().optional(),
  name: z.string().optional(),
  platform: z.string().optional(),
  agentVersion: z.string().optional(),
  accepted: z.boolean().optional(),
  capabilities: z.array(capabilitySchema).max(32).optional(),
  sessions: z.array(serialSessionSchema).max(16).optional(),
});

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
/** @typedef {z.infer<typeof serialPortInfoSchema>} SerialPortInfo */
/** @typedef {z.input<typeof serialOpenParamsSchema>} SerialOpenInput */
/** @typedef {z.infer<typeof serialOpenParamsSchema>} SerialOpenParams */
/** @typedef {z.infer<typeof serialSessionSchema>} SerialSession */
/** @typedef {z.infer<typeof serialControlSchema>} SerialControl */
/** @typedef {z.infer<typeof serialReadResultSchema>} SerialReadResult */
/** @typedef {z.infer<typeof streamFrameSchema>} StreamFrame */
/** @typedef {z.infer<typeof helloPayloadSchema>} HelloPayload */
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
