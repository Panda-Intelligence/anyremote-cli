import process from "node:process";

export function detectPlatform(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function defaultShell(platform = process.platform) {
  if (platform === "win32") return process.env.ComSpec || "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

export function pathSeparator(platform = process.platform) {
  return platform === "win32" ? "\\" : "/";
}
