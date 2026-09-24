import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = "config.json";

export function getConfigDir({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env.ANYREMOTE_CONFIG_DIR) return path.resolve(env.ANYREMOTE_CONFIG_DIR);
  if (platform === "win32") {
    return path.join(
      env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "AnyRemote",
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "anyremote",
  );
}

export function getConfigPath(options = {}) {
  return path.join(getConfigDir(options), CONFIG_FILE);
}

export async function loadConfig(options = {}) {
  try {
    const raw = await fs.readFile(getConfigPath(options), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      throw new Error("configuration must be an object");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`无法读取 AnyRemote 配置：${error.message}`);
  }
}

export async function saveConfig(config, options = {}) {
  const configDir = getConfigDir(options);
  const configPath = getConfigPath(options);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(tempPath, configPath);
  return configPath;
}

export async function updateConfig(update, options = {}) {
  const current = await loadConfig(options);
  const next =
    typeof update === "function" ? update(current) : { ...current, ...update };
  await saveConfig(next, options);
  return next;
}
