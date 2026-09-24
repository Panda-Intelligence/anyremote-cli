import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDeviceName } from "../src/device-name.js";

test("explicit names preserve Unicode and bypass all system probes", async () => {
  const fail = () => assert.fail("must not probe");
  for (const name of ["工作电脑 💻", "a".repeat(120)]) {
    assert.equal(
      await resolveDeviceName(name, { run: fail, getHostname: fail }),
      name,
    );
  }
});

test("invalid explicit names fail instead of silently using a fallback", async () => {
  for (const name of [
    "",
    "  ",
    "a".repeat(121),
    "a\nb",
    "a\u0000b",
    true,
    null,
  ]) {
    await assert.rejects(resolveDeviceName(name), /--name/);
  }
});

for (const [platform, command, args] of [
  ["darwin", "/usr/sbin/scutil", ["--get", "ComputerName"]],
  ["linux", "hostnamectl", ["--pretty"]],
]) {
  test(`${platform} friendly name wins with bounded shell-free probing`, async () => {
    assert.equal(
      await resolveDeviceName(undefined, {
        platform,
        getHostname: () => "host",
        run: async (file, argv, options) => {
          assert.equal(file, command);
          assert.deepEqual(argv, args);
          assert.equal(options.shell, false);
          assert.equal(options.timeout, 750);
          assert.equal(options.maxBuffer, 4096);
          assert.equal(options.killSignal, "SIGKILL");
          return { stdout: "  工作电脑\n" };
        },
      }),
      "工作电脑",
    );
  });

  for (const outcome of ["empty", "missing", "timeout", "overflow"]) {
    test(`${platform} ${outcome} probe falls back to hostname`, async () => {
      assert.equal(
        await resolveDeviceName(undefined, {
          platform,
          getHostname: () => " fallback-host ",
          run: async () => {
            if (outcome === "empty") return { stdout: "\n " };
            throw Object.assign(new Error(outcome), {
              code:
                outcome === "missing"
                  ? "ENOENT"
                  : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              killed: outcome === "timeout",
            });
          },
        }),
        "fallback-host",
      );
    });
  }
}

test("Windows uses hostname without invoking a shell command", async () => {
  assert.equal(
    await resolveDeviceName(undefined, {
      platform: "win32",
      getHostname: () => "OFFICE-PC",
      run: () => assert.fail("must not run"),
    }),
    "OFFICE-PC",
  );
});

test("automatic names sanitize controls and never split Unicode at the limit", async () => {
  assert.equal(
    await resolveDeviceName(undefined, {
      platform: "win32",
      getHostname: () => `\u0000 ${"a".repeat(119)}💻 \n`,
    }),
    "a".repeat(119),
  );
  assert.equal(
    await resolveDeviceName(undefined, {
      platform: "win32",
      getHostname: () => " 💻电脑\u007f ",
    }),
    "💻电脑",
  );
});

test("empty and failing hostname probes use the platform fallback", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const getHostname of [
      () => "\n",
      () => {
        throw new Error("unavailable");
      },
    ]) {
      assert.equal(
        await resolveDeviceName(undefined, {
          platform,
          getHostname,
          run: async () => {
            throw new Error("unavailable");
          },
        }),
        `${platform} computer`,
      );
    }
  }
});
