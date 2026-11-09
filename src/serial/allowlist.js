import path from "node:path";

const MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 255;
const WINDOWS_COM = /^(?:\\\\\.\\)?(COM\d+)$/i;

/**
 * 接受逗号分隔字符串或数组；空值表示全部拒绝。
 * @param {string | string[] | undefined | null} input
 * @returns {string[]}
 */
export function parseSerialAllow(input) {
  if (input === undefined || input === null || input === true) return [];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  const patterns = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const pattern = entry.trim();
    if (!pattern) continue;
    if (pattern.length > MAX_PATTERN_LENGTH)
      throw new Error(
        `serial allow pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
      );
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  if (patterns.length > MAX_PATTERNS)
    throw new Error(`at most ${MAX_PATTERNS} serial allow patterns`);
  return patterns;
}

/**
 * Windows 上 COM3 与 \\.\COM3 指向同一设备，统一成大写 COMn 后再比较。
 * @param {string} value
 */
export function normalizePortPath(value) {
  const match = WINDOWS_COM.exec(value);
  if (match) return match[1].toUpperCase();
  // 折叠 "." / ".." / 重复分隔符，避免 "/dev/../x" 之类的原始路径绕过 "/dev/*"。
  return value.startsWith("/") ? path.posix.normalize(value) : value;
}

/**
 * 只支持 * 与 ?；其余字符按字面匹配。
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  let source = "";
  for (const character of normalizePortPath(pattern)) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

/**
 * 原始路径或规范路径任一匹配 allowlist 即放行；空 allowlist 永远拒绝。
 * @param {string[]} patterns
 * @param {...(string | undefined)} candidates
 */
export function matchesAllow(patterns, ...candidates) {
  if (!patterns?.length) return false;
  const expressions = patterns.map(globToRegExp);
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      expressions.some((expression) =>
        expression.test(normalizePortPath(candidate)),
      ),
  );
}
