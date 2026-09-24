import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_SCREEN_CAPTURE_BYTES,
  screenCaptureResultSchema,
} from "@anyremote/contracts";
import { ToolError } from "../src/errors.js";
import { LocalToolExecutor } from "../src/local-tools.js";
import { captureScreen } from "../src/screen-capture.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAMAAAAoyzS7AAAAA1BMVEX/AAAZ4gk3AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
  "base64",
);

async function withTemporaryRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "anyremote-capture-test-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("macOS adapter produces a bounded synthetic PNG and removes temporary files", async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    let invocation;
    const result = await captureScreen({
      platform: "darwin",
      temporaryRoot,
      captureId: "b56d54b6-ec36-45c0-9df1-5e1ee006fcc9",
      runCommand: async (command, args, options) => {
        invocation = { command, args, options };
        await writeFile(args[1], png);
      },
    });

    assert.equal(invocation.command, "/usr/sbin/screencapture");
    assert.deepEqual(invocation.args.slice(0, 1), ["-x"]);
    assert.equal(invocation.options.timeoutMs, 5_000);
    assert.equal(result.kind, "screen.capture");
    assert.equal(result.captureId, "b56d54b6-ec36-45c0-9df1-5e1ee006fcc9");
    assert.equal(result.mimeType, "image/png");
    assert.ok(result.byteLength <= MAX_SCREEN_CAPTURE_BYTES);
    assert.equal(result.data.length % 4, 0);
    assert.equal(screenCaptureResultSchema.safeParse(result).success, true);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("Linux adapter falls through missing desktop capture utilities without a shell", async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    const commands = [];
    const result = await captureScreen({
      platform: "linux",
      temporaryRoot,
      runCommand: async (command, args) => {
        commands.push(command);
        if (command === "grim")
          throw new ToolError("NOT_FOUND", "not installed");
        assert.equal(command, "gnome-screenshot");
        await writeFile(args[1], png);
      },
    });

    assert.deepEqual(commands, ["grim", "gnome-screenshot"]);
    assert.equal(result.kind, "screen.capture");
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("missing native capture executables map to configuration errors on macOS and Windows", async () => {
  for (const platform of ["darwin", "win32"]) {
    await withTemporaryRoot(async (temporaryRoot) => {
      await assert.rejects(
        captureScreen({
          platform,
          temporaryRoot,
          runCommand: async () => {
            throw new ToolError("NOT_FOUND", "executable is missing");
          },
        }),
        { code: "CONFIGURATION_ERROR" },
      );
      assert.deepEqual(await readdir(temporaryRoot), []);
    });
  }
});

test("Windows adapter uses a fixed encoded PowerShell capture script", async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    let invocation;
    await captureScreen({
      platform: "win32",
      temporaryRoot,
      runCommand: async (command, args) => {
        invocation = { command, args };
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.match(script, /Screen\]::PrimaryScreen/);
        assert.match(script, /CopyFromScreen/);
        assert.match(script, /ImageFormat\]::Png/);
        const match = script.match(/\$bitmap\.Save\('((?:[^']|'')+)'/);
        const outputPath = match?.[1].replaceAll("''", "'");
        assert.ok(outputPath);
        await writeFile(outputPath, png);
      },
    });

    assert.equal(invocation.command, "powershell.exe");
    assert.deepEqual(invocation.args.slice(0, 5), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("capture failures, invalid images, dimensions and source size are bounded and cleaned", async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    await assert.rejects(
      captureScreen({
        platform: "darwin",
        temporaryRoot,
        runCommand: async () => {
          throw new ToolError("REQUEST_TIMEOUT", "capture timed out");
        },
      }),
      { code: "REQUEST_TIMEOUT" },
    );
    assert.deepEqual(await readdir(temporaryRoot), []);

    await assert.rejects(
      captureScreen({
        platform: "darwin",
        temporaryRoot,
        runCommand: async (_command, args) => writeFile(args[1], "not png"),
      }),
      { code: "VALIDATION_ERROR" },
    );
    assert.deepEqual(await readdir(temporaryRoot), []);

    await assert.rejects(
      captureScreen({
        platform: "darwin",
        temporaryRoot,
        runCommand: async (_command, args) => writeFile(args[1], png),
        imageProcessor: (input) => ({
          metadata: async () =>
            typeof input === "string"
              ? { width: 9000, height: 1 }
              : { width: 1, height: 1 },
        }),
      }),
      { code: "RATE_LIMITED" },
    );
    assert.deepEqual(await readdir(temporaryRoot), []);

    await assert.rejects(
      captureScreen({
        platform: "darwin",
        temporaryRoot,
        runCommand: async (_command, args) => {
          await writeFile(args[1], Buffer.alloc(1));
          await truncate(args[1], 64 * 1024 * 1024 + 1);
        },
      }),
      { code: "RATE_LIMITED" },
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("capture rejects images that remain over the encoded size limit", async () => {
  await withTemporaryRoot(async (temporaryRoot) => {
    const alwaysOversizedImage = (input) => ({
      metadata: async () =>
        typeof input === "string"
          ? { width: 640, height: 480 }
          : { width: 320, height: 240 },
      resize() {
        return this;
      },
      png() {
        return this;
      },
      toBuffer: async () => Buffer.alloc(MAX_SCREEN_CAPTURE_BYTES + 1),
    });
    await assert.rejects(
      captureScreen({
        platform: "darwin",
        temporaryRoot,
        runCommand: async (_command, args) => writeFile(args[1], png),
        imageProcessor: alwaysOversizedImage,
      }),
      { code: "RATE_LIMITED" },
    );
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
});

test("LocalToolExecutor routes screen.capture through its injected adapter", async () => {
  const capture = {
    kind: "screen.capture",
    captureId: "b56d54b6-ec36-45c0-9df1-5e1ee006fcc9",
    mimeType: "image/png",
    data: png.toString("base64"),
    byteLength: png.byteLength,
    width: 1,
    height: 1,
  };
  const executor = new LocalToolExecutor({
    screenCapture: async () => capture,
  });
  assert.deepEqual(await executor.execute("screen.capture", {}), capture);
});
