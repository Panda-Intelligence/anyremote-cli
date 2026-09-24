import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const controls = /\p{Cc}/gu;

function automaticName(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(controls, "").trim();
  let name = "";
  for (const character of clean) {
    if (name.length + character.length > 120) break;
    name += character;
  }
  return name.trim();
}

export async function resolveDeviceName(
  explicitName,
  { platform = process.platform, getHostname = hostname, run = runFile } = {},
) {
  if (explicitName !== undefined) {
    if (
      typeof explicitName !== "string" ||
      !explicitName.trim() ||
      explicitName.length > 120 ||
      /\p{Cc}/u.test(explicitName)
    ) {
      throw new Error(
        "--name must contain 1–120 characters and no control characters.",
      );
    }
    return explicitName;
  }

  const command =
    platform === "darwin"
      ? ["/usr/sbin/scutil", ["--get", "ComputerName"]]
      : platform === "linux"
        ? ["hostnamectl", ["--pretty"]]
        : null;
  if (command) {
    try {
      const { stdout } = await run(command[0], command[1], {
        encoding: "utf8",
        timeout: 750,
        maxBuffer: 4096,
        killSignal: "SIGKILL",
        windowsHide: true,
        shell: false,
      });
      const name = automaticName(stdout);
      if (name) return name;
    } catch {
      // 系统命名服务不可用时仍允许通过主机名登记。
    }
  }
  try {
    const name = automaticName(getHostname());
    if (name) return name;
  } catch {
    // 主机名读取失败不阻断设备授权。
  }
  return `${platform} computer`;
}
