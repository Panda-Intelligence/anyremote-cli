import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const SOCAT_MISSING_MESSAGE =
  "socat was not found on PATH, so no PTY was created. Install it (for example `brew install socat` or `apt install socat`) or point the tool at the RFC2217 or raw TCP URL instead. A PTY has fixed parameters: baud rate and DTR/RTS changes made through the PTY are not forwarded.";

export function expandHome(value, home = os.homedir()) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function hasSocat(spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl("socat", ["-V"], { stdio: "ignore" });
  return !result.error;
}

/**
 * 通过 `socat` 把本地 raw TCP 端口接成 PTY（决策 §9.4）；没有 socat 时只返回提示，不报错。
 * PTY 参数固定：用 `stty` 在 PTY 上改波特率或 DTR/RTS 不会传到设备。
 */
export function startSocatPty({
  link,
  rawPort,
  spawn = nodeSpawn,
  detect = hasSocat,
  home,
}) {
  if (!detect()) return { started: false, message: SOCAT_MISSING_MESSAGE };
  const target = expandHome(link, home);
  const child = spawn(
    "socat",
    [`pty,raw,echo=0,link=${target}`, `tcp:127.0.0.1:${rawPort}`],
    { stdio: "ignore" },
  );
  child.on?.("error", () => undefined);
  return {
    started: true,
    link: target,
    child,
    stop() {
      child.kill?.();
    },
  };
}
