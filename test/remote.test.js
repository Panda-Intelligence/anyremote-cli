import assert from "node:assert/strict";
import { test } from "node:test";
import { enrollRemoteDevice } from "../src/remote.js";

function fixture({
  errors = [],
  expiresIn = 120,
  openFails = false,
  enrollmentFails = false,
  existingDeviceId,
  enrollmentResponses = [],
  signal,
} = {}) {
  const calls = [];
  const messages = [];
  const sleeps = [];
  let clock = 0;
  let enrollments = 0;
  const options = {
    baseUrl: "https://app.example.test",
    name: "工作电脑 💻",
    existingDeviceId,
    now: () => clock,
    signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    openBrowser: async () => {
      if (openFails) throw new Error("no browser");
    },
    print: (message) => messages.push(message),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/device/code"))
        return Response.json({
          device_code: "private-device-code",
          user_code: "PUBLIC",
          verification_uri_complete:
            "https://app.example.test/device?user_code=PUBLIC",
          expires_in: expiresIn,
          interval: 1,
        });
      if (url.endsWith("/oauth2/token")) {
        assert.equal(
          new URLSearchParams(init.body).get("client_id"),
          "anyremote-cli",
        );
        const error = errors.shift();
        return error
          ? Response.json({ error }, { status: 400 })
          : Response.json({
              access_token: "private-enrollment-token",
              token_type: "Bearer",
            });
      }
      assert.equal(
        init.headers.authorization,
        "Bearer private-enrollment-token",
      );
      enrollments++;
      if (enrollmentFails && enrollments === 1)
        throw new TypeError("network lost after write");
      const response = enrollmentResponses.shift();
      if (response) return Response.json(response.body, response.options);
      return Response.json({
        data: {
          device: { id: "device-1", name: "Local" },
          deviceToken: "private-device-token",
        },
      });
    },
  };
  return { options, calls, messages, sleeps };
}

test("remote uses scoped native device flow, browser fallback and stable enrollment retry", async () => {
  const f = fixture({
    errors: ["authorization_pending", "slow_down"],
    openFails: true,
    enrollmentFails: true,
  });
  const config = await enrollRemoteDevice(f.options);
  assert.deepEqual(Object.keys(config).sort(), [
    "baseUrl",
    "device",
    "deviceToken",
  ]);
  assert.equal(config.device.id, "device-1");
  assert.deepEqual(f.sleeps, [1000, 1000, 6000, 1000]);
  const enrollments = f.calls.filter((call) => call.url.endsWith("/enroll"));
  assert.equal(enrollments[0].init.body, enrollments[1].init.body);
  assert.deepEqual(
    {
      name: JSON.parse(enrollments[0].init.body).name,
      agentVersion: JSON.parse(enrollments[0].init.body).agentVersion,
    },
    { name: "工作电脑 💻", agentVersion: "0.2.1" },
  );
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    client_id: "anyremote-cli",
    scope: "devices:enroll",
    resource: "https://app.example.test/api/devices/enroll",
  });
  assert.match(f.messages.join("\n"), /Could not open/);
  assert.doesNotMatch(f.messages.join("\n"), /private-/);
  assert.equal(
    f.calls.some((call) => call.url.endsWith("/device/token")),
    false,
  );
});

test("remote rejects invalid names before requesting authorization", async () => {
  const f = fixture();
  f.options.name = " ";
  await assert.rejects(enrollRemoteDevice(f.options), /--name/);
  assert.equal(f.calls.length, 0);
});

test("remote preserves an explicitly supplied agent version", async () => {
  const f = fixture();
  f.options.agentVersion = "9.8.7-custom";
  await enrollRemoteDevice(f.options);
  const enrollment = f.calls.find((call) => call.url.endsWith("/enroll"));
  assert.equal(JSON.parse(enrollment.init.body).agentVersion, "9.8.7-custom");
});

for (const code of ["access_denied", "expired_token", "invalid_grant"]) {
  test(`remote stops on ${code} without enrollment`, async () => {
    const f = fixture({ errors: [code] });
    await assert.rejects(
      enrollRemoteDevice(f.options),
      /denied|expired|failed/,
    );
    assert.equal(
      f.calls.some((call) => call.url.endsWith("/enroll")),
      false,
    );
  });
}

test("remote respects expiry and abort without an account session fallback", async () => {
  const expired = fixture({ expiresIn: 1 });
  await assert.rejects(enrollRemoteDevice(expired.options), /expired/);
  assert.equal(expired.calls.length, 1);
  const controller = new AbortController();
  const aborted = fixture({ signal: controller.signal });
  aborted.options.sleep = async () => controller.abort();
  await assert.rejects(enrollRemoteDevice(aborted.options), {
    name: "AbortError",
  });
  assert.equal(aborted.calls.length, 1);
});

test("remote no-browser never invokes opener and rejects foreign verification URLs", async () => {
  const f = fixture();
  f.options.noBrowser = true;
  f.options.openBrowser = async () => assert.fail("must not open browser");
  await enrollRemoteDevice(f.options);
  f.options.fetchImpl = async () =>
    Response.json({
      device_code: "private",
      user_code: "PUBLIC",
      expires_in: 60,
      verification_uri: "https://other.example.test/device",
    });
  await assert.rejects(
    enrollRemoteDevice(f.options),
    /Invalid device verification URL/,
  );
});

test("remote sends a saved device id for same-device reauthorization", async () => {
  const f = fixture({ existingDeviceId: "saved-device" });
  await enrollRemoteDevice(f.options);
  const enrollment = f.calls.find((call) => call.url.endsWith("/enroll"));
  assert.equal(
    JSON.parse(enrollment.init.body).existingDeviceId,
    "saved-device",
  );
});

test("remote retries a revoked saved device as a replacement enrollment", async () => {
  const f = fixture({
    existingDeviceId: "revoked-device",
    enrollmentResponses: [
      { body: { error: "revoked" }, options: { status: 404 } },
    ],
  });
  const enrolled = await enrollRemoteDevice(f.options);
  const enrollments = f.calls.filter((call) => call.url.endsWith("/enroll"));
  assert.equal(enrollments.length, 2);
  assert.equal(
    JSON.parse(enrollments[0].init.body).existingDeviceId,
    "revoked-device",
  );
  assert.equal(
    Object.hasOwn(JSON.parse(enrollments[1].init.body), "existingDeviceId"),
    false,
  );
  assert.notEqual(
    JSON.parse(enrollments[1].init.body).enrollmentId,
    JSON.parse(enrollments[0].init.body).enrollmentId,
  );
  assert.equal(enrolled.device.id, "device-1");
});
