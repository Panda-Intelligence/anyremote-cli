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

const PYTHON_BYTE_DEVICE = `
import os, pty, sys, tty

mode = sys.argv[1]
master, slave = pty.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)

def pattern(start, length):
    return bytes(((i * 31) + (i >> 8)) & 0xFF for i in range(start, start + length))

def write_all(data):
    view = memoryview(data)
    while len(view):
        written = os.write(master, view)
        view = view[written:]

if mode == "echo":
    # 读写分线程：回显写满 PTY 缓冲时也不能停止读取，否则与对端的写互相等待而死锁。
    import queue, threading
    pending = queue.Queue()

    def writer():
        while True:
            chunk = pending.get()
            if chunk is None:
                break
            write_all(chunk)

    threading.Thread(target=writer, daemon=True).start()
    while True:
        data = os.read(master, 65536)
        if not data:
            break
        pending.put(data)
elif mode == "source":
    total = int(sys.argv[2])
    rate = int(sys.argv[3])
    os.read(master, 1)
    import time
    sent = 0
    started = time.monotonic()
    step = 1000 if rate else 16384
    while sent < total:
        size = min(step, total - sent)
        write_all(pattern(sent, size))
        sent += size
        if rate:
            wait = started + sent / rate - time.monotonic()
            if wait > 0:
                time.sleep(wait)
    while True:
        if not os.read(master, 4096):
            break
`;

/**
 * 字节精确的 PTY 设备（python3 pty）：'echo' 原样回显；'source' 收到一个触发字节后按
 * 'rate' 字节/秒（0 = 全速）发送 'bytes' 字节的确定性序列 (i*31 + (i>>8)) & 0xff。
 */
export async function startBytePtyDevice({
  mode = "echo",
  bytes = 0,
  rate = 0,
} = {}) {
  if (process.platform === "win32" || !has("python3"))
    return { reason: "python3 with pty is not available" };
  const args = ["-c", PYTHON_BYTE_DEVICE, mode];
  if (mode === "source") args.push(String(bytes), String(rate));
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "ignore"] });
  const devicePath = await new Promise((resolve) =>
    child.stdout.once("data", (d) => resolve(String(d).trim())),
  );
  return {
    kind: "python-pty-bytes",
    path: devicePath,
    close: async () => child.kill(),
  };
}

export function deterministicPattern(length, start = 0) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1)
    buffer[i] = ((start + i) * 31 + ((start + i) >> 8)) & 0xff;
  return buffer;
}
