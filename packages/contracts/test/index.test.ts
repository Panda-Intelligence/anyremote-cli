import { describe, expect, test } from "bun:test";
import {
  connectionEnvelopeSchema,
  deviceSchema,
  ErrorCode,
  failure,
  helloPayloadSchema,
  MAX_SCREEN_CAPTURE_BYTES,
  MAX_STREAM_FRAME_BYTES,
  MIN_SERIAL_AGENT_VERSION,
  SERIAL_STREAM_GRACE_MS,
  STREAM_CLOSE_RECLAIMED,
  screenCaptureResultSchema,
  serialControlSchema,
  serialOpenParamsSchema,
  serialPortInfoSchema,
  serialReadResultSchema,
  serialSessionSchema,
  streamFrameSchema,
  streamHelloPayloadSchema,
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

  describe("serial contracts", () => {
    const sessionId = "b56d54b6-ec36-45c0-9df1-5e1ee006fcc9";
    const params = serialOpenParamsSchema.parse({ path: "/dev/cu.test" });
    const session = {
      sessionId,
      deviceId: "device-1",
      path: "/dev/cu.test",
      params,
      openedAt: "2026-11-08T00:00:00.000Z",
      lastActivityAt: "2026-11-08T00:00:01.000Z",
      holder: { kind: "mcp" },
      rxCursor: 0,
      txBytes: 0,
      bytesLost: 0,
      state: "open",
    } as const;

    test("exposes the stream type, error codes and agent gate", () => {
      expect(ErrorCode.SERIAL_PORT_BUSY).toBe("SERIAL_PORT_BUSY");
      expect(ErrorCode.SERIAL_PORT_LOST).toBe("SERIAL_PORT_LOST");
      expect(
        failure({
          code: "SERIAL_PORT_LOST",
          message: "gone",
          requestId: "r",
        }).error.code,
      ).toBe("SERIAL_PORT_LOST");
      expect(MIN_SERIAL_AGENT_VERSION).toBe("0.3.0");
      expect(
        connectionEnvelopeSchema.parse({
          version: 1,
          type: "stream",
          requestId: sessionId,
          deviceId: "d",
          connectionEpoch: "e",
          payload: {},
        }).type,
      ).toBe("stream");
    });

    test("applies open defaults and rejects out-of-range values", () => {
      expect(params).toMatchObject({
        baudRate: 115200,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        flowControl: "none",
        bufferBytes: 1024 * 1024,
        idleTimeoutMs: 600_000,
      });
      for (const bad of [
        { baudRate: 49 },
        { baudRate: 4_000_001 },
        { dataBits: 9 },
        { stopBits: 3 },
        { bufferBytes: 1024 },
        { idleTimeoutMs: 1000 },
        { unknown: true },
      ])
        expect(() =>
          serialOpenParamsSchema.parse({ path: "/dev/x", ...bad }),
        ).toThrow();
      expect(() => serialOpenParamsSchema.parse({ path: "" })).toThrow();
    });

    test("validates ports, sessions and read results strictly", () => {
      expect(
        serialPortInfoSchema.parse({ path: "/dev/x", allowed: true }),
      ).toEqual({ path: "/dev/x", allowed: true });
      expect(() =>
        serialPortInfoSchema.parse({ path: "/dev/x", extra: 1 }),
      ).toThrow();
      expect(serialSessionSchema.parse(session)).toEqual(session);
      expect(() =>
        serialSessionSchema.parse({ ...session, state: "weird" }),
      ).toThrow();
      expect(() =>
        serialSessionSchema.parse({ ...session, sessionId: "nope" }),
      ).toThrow();
      const read = {
        sessionId,
        data: "hi",
        encoding: "utf8",
        nextCursor: 2,
        bufferStartCursor: 0,
        bytesLost: 0,
        truncated: false,
        lineState: { cts: false, dsr: false, dcd: false, ri: false },
        state: "open",
      } as const;
      expect(serialReadResultSchema.parse(read)).toEqual(read);
      expect(() =>
        serialReadResultSchema.parse({ ...read, encoding: "latin1" }),
      ).toThrow();
      expect(() =>
        serialReadResultSchema.parse({ ...read, extra: true }),
      ).toThrow();
    });

    test("bounds control sequences by step count and total duration", () => {
      expect(
        serialControlSchema.parse({
          sequence: [
            { dtr: false, rts: true, delayMs: 100 },
            { dtr: true, delayMs: 100 },
          ],
        }).sequence,
      ).toHaveLength(2);
      expect(() =>
        serialControlSchema.parse({
          sequence: Array.from({ length: 17 }, () => ({ delayMs: 0 })),
        }),
      ).toThrow();
      expect(() =>
        serialControlSchema.parse({
          sequence: [{ delayMs: 2000 }, { delayMs: 2000 }, { delayMs: 1001 }],
        }),
      ).toThrow("total delay");
      expect(() => serialControlSchema.parse({ breakMs: 2001 })).toThrow();
      expect(() => serialControlSchema.parse({ purge: "x" })).toThrow();
    });

    test("validates stream frames including base64 size bounds", () => {
      const max = Buffer.alloc(MAX_STREAM_FRAME_BYTES, 1).toString("base64");
      expect(
        streamFrameSchema.parse({ sessionId, seq: 0, kind: "rx", data: max }),
      ).toBeTruthy();
      const over = Buffer.alloc(MAX_STREAM_FRAME_BYTES + 3, 1).toString(
        "base64",
      );
      expect(() =>
        streamFrameSchema.parse({ sessionId, seq: 0, kind: "rx", data: over }),
      ).toThrow();
      expect(() =>
        streamFrameSchema.parse({ sessionId, seq: 0, kind: "tx", data: "@@@" }),
      ).toThrow();
      expect(() =>
        streamFrameSchema.parse({ sessionId, seq: -1, kind: "ack", credit: 1 }),
      ).toThrow();
      expect(() =>
        streamFrameSchema.parse({ sessionId, seq: 0, kind: "rx" }),
      ).toThrow("require data");
      expect(
        streamFrameSchema.parse({
          sessionId,
          seq: 1,
          kind: "ack",
          credit: 4096,
        }).credit,
      ).toBe(4096);
      expect(
        streamFrameSchema.parse({
          sessionId,
          seq: 2,
          kind: "state",
          state: { phase: "paused" },
        }).state?.phase,
      ).toBe("paused");
      expect(() =>
        streamFrameSchema.parse({
          sessionId,
          seq: 2,
          kind: "state",
          state: { phase: "sleeping" },
        }),
      ).toThrow();
      expect(() =>
        streamFrameSchema.parse({
          sessionId,
          seq: 3,
          kind: "control",
          control: { dtr: true },
          extra: 1,
        }),
      ).toThrow();
    });

    test("hello accepts legacy payloads and capability lists", () => {
      expect(
        helloPayloadSchema.parse({
          deviceToken: "t",
          name: "n",
          platform: "macos",
          agentVersion: "0.2.6",
        }),
      ).toBeTruthy();
      expect(
        helloPayloadSchema.parse({ accepted: true, extra: 1 }),
      ).toBeTruthy();
      expect(
        helloPayloadSchema.parse({
          capabilities: ["serial", "serial.stream"],
          sessions: [session],
        }).sessions,
      ).toHaveLength(1);
      expect(() =>
        helloPayloadSchema.parse({ capabilities: ["Serial"] }),
      ).toThrow();
      expect(() =>
        helloPayloadSchema.parse({
          capabilities: Array.from({ length: 33 }, (_, i) => `cap${i}`),
        }),
      ).toThrow();
    });
  });
  test("consumer stream hello takes exactly one of open or resume", () => {
    const sessionId = "7f1c2e4a-3b5d-4c6e-8f90-a1b2c3d4e5f6";
    const opened = streamHelloPayloadSchema.parse({
      open: { path: "/dev/ttyUSB0" },
    });
    expect(opened.open?.baudRate).toBe(115_200);
    expect(
      streamHelloPayloadSchema.parse({ resume: { sessionId, lastSeq: -1 } })
        .resume?.lastSeq,
    ).toBe(-1);
    expect(() => streamHelloPayloadSchema.parse({})).toThrow();
    expect(() =>
      streamHelloPayloadSchema.parse({
        open: { path: "/dev/x" },
        resume: { sessionId, lastSeq: 0 },
      }),
    ).toThrow();
    expect(() =>
      streamHelloPayloadSchema.parse({
        resume: { sessionId: "nope", lastSeq: 0 },
      }),
    ).toThrow();
    expect(() =>
      streamHelloPayloadSchema.parse({ open: { path: "/dev/x", extra: 1 } }),
    ).toThrow();
    expect(SERIAL_STREAM_GRACE_MS).toBe(15_000);
    expect(STREAM_CLOSE_RECLAIMED).toBe(4001);
  });
});
