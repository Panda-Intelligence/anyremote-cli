import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import open from "open";
import { resolveDeviceName } from "./device-name.js";
import { detectPlatform } from "./platform.js";
import { CLI_VERSION } from "./version.js";

const CLIENT_ID = "anyremote-cli";

/** 只领取设备范围的身份；账号会话和 enrollment token 不写入配置。 */
export async function enrollRemoteDevice({
  baseUrl,
  name,
  agentVersion = CLI_VERSION,
  existingDeviceId,
  signal,
  noBrowser = false,
  fetchImpl = fetch,
  openBrowser = open,
  print = (message) => process.stdout.write(`${message}\n`),
  sleep = (ms) => delay(ms, undefined, { signal }),
  now = Date.now,
  enrollmentId = randomUUID(),
} = {}) {
  const origin = new URL(baseUrl).origin;
  if (baseUrl.replace(/\/$/, "") !== origin)
    throw new Error("Use the application origin as --base-url.");
  const deviceName = await resolveDeviceName(name);
  async function request(path, body, token, form = false) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        "The authorization service returned an invalid response.",
      );
    }
    return { response, payload };
  }
  const { response, payload: grant } = await request("/api/auth/device/code", {
    client_id: CLIENT_ID,
    scope: "devices:enroll",
    resource: `${origin}/api/devices/enroll`,
  });
  if (!response.ok)
    throw new Error(
      "Could not start device authorization. Check the application URL and try again.",
    );
  if (
    !grant.device_code ||
    !grant.user_code ||
    !Number.isFinite(grant.expires_in) ||
    grant.expires_in <= 0
  )
    throw new Error("Invalid device authorization response.");
  const deadline = now() + grant.expires_in * 1000;
  const verification = new URL(
    grant.verification_uri_complete || grant.verification_uri,
  );
  if (
    verification.origin !== origin ||
    verification.searchParams.has("device_code")
  )
    throw new Error("Invalid device verification URL.");
  print(`Open ${verification.href}\nApproval code: ${grant.user_code}`);
  if (!noBrowser) {
    try {
      await openBrowser(verification.href, { wait: false });
    } catch {
      print(
        "Could not open the browser. Open the URL above to approve this computer.",
      );
    }
  }
  let interval = Math.max(1, Number(grant.interval) || 5) * 1000;
  let accessToken;
  while (now() < deadline) {
    await sleep(Math.min(interval, deadline - now()));
    signal?.throwIfAborted();
    if (now() >= deadline) break;
    let result;
    try {
      result = await request(
        "/api/auth/oauth2/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: CLIENT_ID,
          device_code: grant.device_code,
        },
        undefined,
        true,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TypeError) && error.name !== "TimeoutError")
        throw error;
      interval = Math.min(interval * 2, 30_000);
      continue;
    }
    if (result.response.ok) {
      if (
        typeof result.payload.access_token !== "string" ||
        result.payload.token_type?.toLowerCase() !== "bearer"
      )
        throw new Error("Invalid device token response.");
      accessToken = result.payload.access_token;
      break;
    }
    const code = result.payload.error;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 5000;
      continue;
    }
    if (code === "access_denied")
      throw new Error("Device authorization was denied.");
    if (code === "expired_token")
      throw new Error("Device authorization expired. Run remote again.");
    if (result.response.status >= 500) {
      interval = Math.min(interval * 2, 30_000);
      continue;
    }
    throw new Error("Device authorization failed. Run remote again.");
  }
  if (!accessToken)
    throw new Error("Device authorization expired. Run remote again.");
  const input = {
    name: deviceName,
    platform: detectPlatform(),
    agentVersion,
    enrollmentId,
  };
  if (typeof existingDeviceId === "string" && existingDeviceId)
    input.existingDeviceId = existingDeviceId;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await request("/api/devices/enroll", input, accessToken);
      if (result.response.status >= 500 && attempt < 2) {
        await sleep(1000);
        continue;
      }
      if (!result.response.ok) {
        // 旧设备可能已被控制台撤销或删除。授权已经完成时，安全地丢弃
        // existingDeviceId 并用同一轮授权登记一台替代设备；其他错误必须
        // 保留给调用方，避免把额度、授权或服务端错误误判成设备缺失。
        if (
          input.existingDeviceId &&
          [403, 404].includes(result.response.status)
        ) {
          delete input.existingDeviceId;
          // 如果撤销发生在服务端已经保存登记之后，复用同一个 enrollmentId
          // 会命中旧的撤销记录；替代设备必须使用新的幂等边界。
          input.enrollmentId = randomUUID();
          continue;
        }
        throw new Error(
          `Device enrollment failed (${result.response.status}). Check your device limit or try again.`,
        );
      }
      const paired = result.payload.data;
      if (!paired?.device?.id || typeof paired.deviceToken !== "string")
        throw new Error("Invalid enrollment response.");
      return {
        baseUrl: origin,
        device: paired.device,
        deviceToken: paired.deviceToken,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (
        attempt === 2 ||
        (!(error instanceof TypeError) && error.name !== "TimeoutError")
      )
        throw error;
      await sleep(1000);
    }
  }
}
