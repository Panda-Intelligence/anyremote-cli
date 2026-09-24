import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  MAX_SCREEN_CAPTURE_BYTES,
  MAX_SCREEN_CAPTURE_EDGE,
  MAX_SCREEN_CAPTURE_PIXELS,
} from "@anyremote/contracts";
import sharp from "sharp";
import { ToolError } from "./errors.js";

const MAX_SOURCE_PNG_BYTES = 64 * 1024 * 1024;
const MIN_OUTPUT_EDGE = 320;

function nativeCapture(platform, outputPath) {
  if (platform === "darwin")
    return [{ command: "/usr/sbin/screencapture", args: ["-x", outputPath] }];
  if (platform === "linux")
    return [
      { command: "grim", args: [outputPath] },
      { command: "gnome-screenshot", args: ["--file", outputPath] },
      { command: "scrot", args: [outputPath] },
    ];
  if (platform === "win32") {
    const safePath = outputPath.replaceAll("'", "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)",
      "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
      "try {",
      "  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
      `  $bitmap.Save('${safePath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      "} finally { $graphics.Dispose(); $bitmap.Dispose() }",
    ].join("; ");
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
      },
    ];
  }
  throw new ToolError(
    "CONFIGURATION_ERROR",
    "Screen capture is supported on macOS, Linux, and Windows.",
  );
}

function runCaptureCommand(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let child;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      finish(
        reject,
        new ToolError("CONFIGURATION_ERROR", "Screen capture could not start."),
      );
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        reject,
        new ToolError("REQUEST_TIMEOUT", "Screen capture timed out."),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      finish(
        reject,
        error.code === "ENOENT"
          ? new ToolError("NOT_FOUND", "Screen capture utility is unavailable.")
          : new ToolError(
              "CONFIGURATION_ERROR",
              "Screen capture could not access the desktop.",
            ),
      );
    });
    child.once("close", (code) => {
      if (code === 0) finish(resolve);
      else
        finish(
          reject,
          new ToolError(
            "CONFIGURATION_ERROR",
            "Screen capture failed; check desktop permissions.",
          ),
        );
    });
  });
}

async function runNativeCapture(platform, outputPath, runCommand, timeoutMs) {
  const attempts = nativeCapture(platform, outputPath);
  let permissionError;
  for (const attempt of attempts) {
    try {
      await runCommand(attempt.command, attempt.args, { timeoutMs });
      return;
    } catch (error) {
      if (error?.code === "REQUEST_TIMEOUT") throw error;
      if (error?.code !== "NOT_FOUND") permissionError = error;
    }
  }
  if (permissionError) throw permissionError;
  if (platform !== "linux") {
    throw new ToolError(
      "CONFIGURATION_ERROR",
      "Screen capture utility is unavailable.",
    );
  }
  throw new ToolError(
    "CONFIGURATION_ERROR",
    "Install grim, gnome-screenshot, or scrot to capture a Linux desktop.",
  );
}

async function encodePng(inputPath, imageProcessor) {
  let metadata;
  try {
    metadata = await imageProcessor(inputPath, {
      failOn: "error",
      limitInputPixels: MAX_SCREEN_CAPTURE_PIXELS,
      sequentialRead: true,
    }).metadata();
  } catch {
    throw new ToolError(
      "VALIDATION_ERROR",
      "Screen capture produced an invalid PNG.",
    );
  }
  const { width, height } = metadata;
  if (
    !width ||
    !height ||
    width > MAX_SCREEN_CAPTURE_EDGE ||
    height > MAX_SCREEN_CAPTURE_EDGE ||
    width * height > MAX_SCREEN_CAPTURE_PIXELS
  ) {
    throw new ToolError(
      "RATE_LIMITED",
      "Screen capture exceeds the image dimension limit.",
    );
  }

  let edge = Math.max(width, height);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let data;
    try {
      data = await imageProcessor(inputPath, {
        failOn: "error",
        limitInputPixels: MAX_SCREEN_CAPTURE_PIXELS,
        sequentialRead: true,
      })
        .resize({
          width: edge,
          height: edge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png({
          compressionLevel: 9,
          effort: 10,
          palette: true,
          quality: 90,
        })
        .toBuffer();
    } catch {
      throw new ToolError(
        "VALIDATION_ERROR",
        "Screen capture could not be encoded.",
      );
    }
    if (data.byteLength <= MAX_SCREEN_CAPTURE_BYTES) {
      let outputMetadata;
      try {
        outputMetadata = await imageProcessor(data).metadata();
      } catch {
        throw new ToolError(
          "VALIDATION_ERROR",
          "Screen capture could not be encoded.",
        );
      }
      if (!outputMetadata.width || !outputMetadata.height) {
        throw new ToolError(
          "VALIDATION_ERROR",
          "Screen capture could not be encoded.",
        );
      }
      return {
        data,
        width: outputMetadata.width,
        height: outputMetadata.height,
      };
    }
    if (edge <= MIN_OUTPUT_EDGE) break;
    edge = Math.max(
      MIN_OUTPUT_EDGE,
      Math.floor(
        edge * Math.sqrt(MAX_SCREEN_CAPTURE_BYTES / data.byteLength) * 0.9,
      ),
    );
  }
  throw new ToolError(
    "RATE_LIMITED",
    "Screen capture remains too large after resizing.",
  );
}

export async function captureScreen({
  platform = process.platform,
  runCommand = runCaptureCommand,
  imageProcessor = sharp,
  temporaryRoot = os.tmpdir(),
  timeoutMs = 5_000,
  captureId = randomUUID(),
} = {}) {
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(temporaryRoot, "anyremote-screen-"));
  } catch {
    throw new ToolError(
      "CONFIGURATION_ERROR",
      "Unable to create a temporary screen capture directory.",
    );
  }
  const inputPath = path.join(directory, "capture.png");
  try {
    await runNativeCapture(platform, inputPath, runCommand, timeoutMs);
    let stat;
    try {
      stat = await fs.stat(inputPath);
    } catch {
      throw new ToolError(
        "VALIDATION_ERROR",
        "Screen capture did not produce an image.",
      );
    }
    if (!stat.isFile() || stat.size <= 0)
      throw new ToolError(
        "VALIDATION_ERROR",
        "Screen capture did not produce an image.",
      );
    if (stat.size > MAX_SOURCE_PNG_BYTES)
      throw new ToolError(
        "RATE_LIMITED",
        "Screen capture source exceeds the input size limit.",
      );

    const encoded = await encodePng(inputPath, imageProcessor);
    return {
      kind: "screen.capture",
      captureId,
      mimeType: "image/png",
      data: encoded.data.toString("base64"),
      byteLength: encoded.data.byteLength,
      width: encoded.width,
      height: encoded.height,
    };
  } finally {
    await fs
      .rm(directory, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
