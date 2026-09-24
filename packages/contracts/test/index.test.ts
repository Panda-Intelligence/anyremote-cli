import { describe, expect, test } from "bun:test";
import {
  connectionEnvelopeSchema,
  deviceSchema,
  ErrorCode,
  failure,
  MAX_SCREEN_CAPTURE_BYTES,
  screenCaptureResultSchema,
  success,
} from "../src/index.js";

describe("shared contracts", () => {
  test("validates a device record and rejects malformed platform values", () => {
    const device = {
      id: "device-1",
      ownerId: "user-1",
      name: "Development Mac",
      platform: "macos",
      agentVersion: "0.1.0",
      status: "offline",
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
    } as const;

    expect(deviceSchema.parse(device)).toEqual(device);
    expect(() => deviceSchema.parse({ ...device, platform: "ios" })).toThrow();
  });

  test("uses one API envelope shape", () => {
    expect(success({ ok: true })).toEqual({ data: { ok: true } });
    expect(
      failure({
        code: ErrorCode.NOT_FOUND,
        message: "missing",
        requestId: "req-1",
      }),
    ).toEqual({
      error: { code: "NOT_FOUND", message: "missing", requestId: "req-1" },
    });
  });

  test("requires versioned connection metadata", () => {
    const envelope = {
      version: 1,
      type: "request",
      requestId: "req-1",
      deviceId: "device-1",
      connectionEpoch: "epoch-1",
      payload: { tool: "files.read" },
    } as const;

    expect(connectionEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() =>
      connectionEnvelopeSchema.parse({ ...envelope, version: 2 }),
    ).toThrow();
  });

  test("validates screenshot media and its PNG metadata", () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX/AAAZ4gk3AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";
    const capture = {
      kind: "screen.capture",
      captureId: "b56d54b6-ec36-45c0-9df1-5e1ee006fcc9",
      mimeType: "image/png",
      data: png,
      byteLength: 103,
      width: 1,
      height: 1,
    } as const;

    expect(screenCaptureResultSchema.parse(capture)).toEqual(capture);
    expect(() =>
      screenCaptureResultSchema.parse({ ...capture, byteLength: 67 }),
    ).toThrow("byteLength does not match data");
    expect(() =>
      screenCaptureResultSchema.parse({ ...capture, width: 2 }),
    ).toThrow("PNG dimensions do not match metadata");
    expect(() =>
      screenCaptureResultSchema.parse({ ...capture, data: "not a PNG" }),
    ).toThrow();
    expect(() =>
      screenCaptureResultSchema.parse({
        ...capture,
        width: 8192,
        height: 8192,
      }),
    ).toThrow("image exceeds the pixel limit");
    expect(() =>
      screenCaptureResultSchema.parse({
        ...capture,
        data: "A".repeat(Math.ceil(MAX_SCREEN_CAPTURE_BYTES / 3) * 4 + 4),
      }),
    ).toThrow();
  });
});
