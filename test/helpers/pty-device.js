import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PYTHON_DEVICE = `
import os, pty, tty
master, slave = pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)
while True:
    data = os.read(master, 4096)
    if not data:
        break
    os.write(master, b"echo:" + data)
`;

const has = (command, args = ["--version"]) =>
  !spawnSync(command, args, { stdio: "ignore" }).error;

/**
 * 真实 PTY 对：优先 socat（两端都是 PTY 链接）；没有 socat 时退回 python3 的 pty。
 * 都不可用时返回 null 与跳过原因。
 */
export async function startPtyDevice() {
  if (process.platform === "win32")
    return { reason: "PTY pairs are not available on Windows" };
  if (has("socat", ["-V"])) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anyremote-pty-"));
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    const child = spawn(
      "socat",
      [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`],
      { stdio: "ignore" },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const ready = await Promise.all([fs.stat(a), fs.stat(b)]).then(
        () => true,
        () => false,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const reader = createReadStream(b);
    const writer = createWriteStream(b);
    reader.on("data", (data) =>
      writer.write(Buffer.concat([Buffer.from("echo:"), data])),
    );
    reader.on("error", () => {});
    writer.on("error", () => {});
    return {
      kind: "socat",
      path: a,
      async close() {
        reader.destroy();
        writer.destroy();
        child.kill();
        await fs.rm(dir, { recursive: true, force: true });
      },
    };
  }
  if (has("python3")) {
    const child = spawn("python3", ["-c", PYTHON_DEVICE], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const devicePath = await new Promise((resolve) =>
      child.stdout.once("data", (d) => resolve(String(d).trim())),
    );
    return {
      kind: "python-pty",
      path: devicePath,
      close: async () => child.kill(),
    };
  }
  return { reason: "neither socat nor python3 is installed" };
}
