import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSerialAllow } from "../src/config.js";
import {
  globToRegExp,
  matchesAllow,
  normalizePortPath,
  parseSerialAllow,
} from "../src/serial/allowlist.js";

test("parseSerialAllow splits, trims, dedupes and treats empty as deny-all", () => {
  assert.deepEqual(parseSerialAllow(" /dev/cu.* , /dev/ttyUSB?,/dev/cu.* "), [
    "/dev/cu.*",
    "/dev/ttyUSB?",
  ]);
  assert.deepEqual(parseSerialAllow(""), []);
  assert.deepEqual(parseSerialAllow(undefined), []);
  assert.deepEqual(parseSerialAllow(["COM3", " "]), ["COM3"]);
  assert.throws(() => parseSerialAllow("x".repeat(300)), /exceeds/);
});

test("glob supports only * and ? and escapes everything else", () => {
  assert.ok(globToRegExp("/dev/cu.usb*").test("/dev/cu.usbmodem1"));
  assert.ok(!globToRegExp("/dev/cu.usb*").test("/dev/tty.usbmodem1"));
  assert.ok(globToRegExp("/dev/ttyUSB?").test("/dev/ttyUSB0"));
  assert.ok(!globToRegExp("/dev/ttyUSB?").test("/dev/ttyUSB10"));
  assert.ok(!globToRegExp("/dev/a.b").test("/dev/aXb"));
  assert.ok(!globToRegExp("[ab]").test("a"));
});

test("matching checks raw and canonical paths and denies by default", () => {
  assert.equal(matchesAllow([], "/dev/cu.x"), false);
  assert.equal(matchesAllow(["/dev/cu.*"], "/dev/cu.x"), true);
  assert.equal(matchesAllow(["/dev/cu.*"], "/dev/tty.x"), false);
  // 符号链接：原始路径不匹配但规范路径匹配，或反之，均放行。
  assert.equal(
    matchesAllow(["/dev/ttyUSB0"], "/dev/serial/by-id/x", "/dev/ttyUSB0"),
    true,
  );
  assert.equal(
    matchesAllow(
      ["/dev/serial/by-id/*"],
      "/dev/serial/by-id/x",
      "/dev/ttyUSB0",
    ),
    true,
  );
  assert.equal(
    matchesAllow(["/dev/ttyUSB0"], "/tmp/link", "/dev/ttyACM0"),
    false,
  );
});

test("Windows COM names normalise across forms and case", () => {
  assert.equal(normalizePortPath("\\\\.\\com3"), "COM3");
  assert.equal(matchesAllow(["COM3"], "\\\\.\\COM3"), true);
  assert.equal(matchesAllow(["\\\\.\\COM3"], "com3"), true);
  assert.equal(matchesAllow(["COM*"], "COM12"), true);
  assert.equal(matchesAllow(["COM3"], "COM30"), false);
});

test("resolveSerialAllow lets the flag replace or clear the saved value", () => {
  assert.deepEqual(resolveSerialAllow({ saved: ["/a"] }), ["/a"]);
  assert.deepEqual(resolveSerialAllow({ flag: "/b", saved: ["/a"] }), ["/b"]);
  assert.deepEqual(resolveSerialAllow({ flag: "", saved: ["/a"] }), []);
  assert.deepEqual(resolveSerialAllow({}), []);
  assert.throws(() => resolveSerialAllow({ flag: true }), /requires a value/);
});

test("raw paths are normalised before matching so dot segments cannot escape", () => {
  assert.equal(matchesAllow(["/dev/*"], "/dev/../etc/passwd"), false);
  assert.equal(matchesAllow(["/dev/cu.*"], "/dev//cu.usbserial-1"), true);
});
