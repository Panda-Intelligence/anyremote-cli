#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DeviceAgent } from "./agent.js";
import { ApiClient } from "./client.js";
import { loadConfig, saveConfig } from "./config.js";
import { resolveDeviceName } from "./device-name.js";
import { createLocalToolExecutor } from "./local-tools.js";
import { detectPlatform } from "./platform.js";
import { enrollRemoteDevice } from "./remote.js";
import { createRequestLogger } from "./request-log.js";

function parseFlags(values) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replaceAll("-", "_");
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else flags[key] = true;
  }
  return { flags, positional };
}

function print(value) {
  process.stdout.write(
    `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`,
  );
}

function publicConfig(config) {
  return {
    baseUrl: config.baseUrl,
    device: config.device,
    hasAccessToken: Boolean(config.accessToken),
    hasSession: Boolean(config.sessionCookie),
  };
}

function hasHttpStatus(error, status) {
  return error?.details?.status === status;
}

function clearConfigFields(config, fields) {
  const next = { ...config };
  for (const field of fields) next[field] = undefined;
  return next;
}

function help() {
  print(
    "Quick connect: anyremote remote --base-url <application-origin> [--name <computer>] [--no-browser]",
  );
  print(
    `AnyRemote CLI\n\nUsage: anyremote <command> [options]\n\nCommands:\n  remote               Authorize and connect this computer\n  pair                 Create a pairing request\n  login                Save an AnyRemote login session\n  logout               End the saved account session\n  connect              Keep this computer connected\n  status               Show saved connection status\n  devices              List connected devices\n  revoke               Revoke the saved device\n  disconnect           Revoke a saved device (alias)\n  doctor               Check local runtime\n\nEnvironment:\n  ANYREMOTE_URL, ANYREMOTE_TOKEN, ANYREMOTE_EMAIL, ANYREMOTE_PASSWORD\n`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const parsed = parseFlags(argv.slice(1));
  if (!command || command === "help" || command === "--help") return help();
  const config = await loadConfig();
  const baseUrl =
    parsed.flags.base_url || config.baseUrl || process.env.ANYREMOTE_URL;
  const token =
    parsed.flags.token || config.accessToken || process.env.ANYREMOTE_TOKEN;
  const cookie = config.sessionCookie;
  if (command === "doctor") {
    return print({
      node: process.version,
      platform: detectPlatform(),
      cwd: process.cwd(),
      config: publicConfig(config),
    });
  }
  if (
    !baseUrl &&
    !["status", "logout", "revoke", "disconnect"].includes(command)
  )
    throw new Error("Set ANYREMOTE_URL or pass --base-url");
  const api = baseUrl ? new ApiClient({ baseUrl, token, cookie }) : null;
  if (command === "login") {
    if (!baseUrl) throw new Error("Set ANYREMOTE_URL or pass --base-url");
    const email = parsed.flags.email || process.env.ANYREMOTE_EMAIL;
    const password = parsed.flags.password || process.env.ANYREMOTE_PASSWORD;
    if (!email || !password)
      throw new Error("--email and --password are required");
    await api.login({ email, password });
    await saveConfig({
      ...config,
      baseUrl,
      accessToken: api.token,
      sessionCookie: api.cookie,
    });
    return print({ loggedIn: true, baseUrl });
  }
  if (command === "logout") {
    const hasCredentials = Boolean(token || cookie);
    if (hasCredentials && !baseUrl)
      throw new Error("Set ANYREMOTE_URL or pass --base-url");
    let alreadyLoggedOut = !hasCredentials;
    if (hasCredentials) {
      try {
        await api.signOut();
      } catch (error) {
        if (!hasHttpStatus(error, 401) && !hasHttpStatus(error, 404))
          throw error;
        alreadyLoggedOut = true;
      }
    }
    await saveConfig(
      clearConfigFields(config, ["accessToken", "sessionCookie"]),
      { env: process.env },
    );
    return print({
      loggedOut: true,
      ...(alreadyLoggedOut ? { alreadyLoggedOut: true } : {}),
      baseUrl: config.baseUrl || baseUrl,
    });
  }
  if (command === "pair") {
    const pairing = await api.createPairing({
      name: await resolveDeviceName(parsed.flags.name),
      agentVersion: parsed.flags.version || "0.2.1",
    });
    print(pairing);
    if (parsed.flags.wait || parsed.flags.code) {
      const code = parsed.flags.code || pairing.code;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const state = await api.pollPairing({
          pairingId: pairing.id,
          code,
          pollToken: pairing.pollToken,
        });
        if (state.status === "approved") {
          await saveConfig({
            ...config,
            baseUrl,
            accessToken: api.token,
            sessionCookie: api.cookie,
            device: state.device,
            deviceToken: state.deviceToken,
          });
          return print({ status: state.status, device: state.device });
        }
        if (["expired", "revoked"].includes(state.status))
          throw new Error(`pairing ${state.status}`);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            (state.pollIntervalSeconds || pairing.pollIntervalSeconds || 3) *
              1000,
          ),
        );
      }
      throw new Error("pairing timed out");
    }
    return;
  }
  if (command === "status") return print(publicConfig(config));
  if (command === "devices") return print(await api.listDevices());
  if (command === "revoke" || command === "disconnect") {
    const deviceId = parsed.flags.device_id || config.device?.id;
    if (!deviceId) {
      if (config.device || config.deviceToken)
        await saveConfig(clearConfigFields(config, ["device", "deviceToken"]), {
          env: process.env,
        });
      return print({ revoked: false, alreadyRevoked: true, deviceId: null });
    }
    if (!api) throw new Error("Set ANYREMOTE_URL or pass --base-url");
    const result = await api.revokeDevice(deviceId);
    if (config.device?.id === deviceId)
      await saveConfig(clearConfigFields(config, ["device", "deviceToken"]), {
        env: process.env,
      });
    return print({ ...(result || {}), revoked: true, deviceId });
  }
  if (command === "remote" || command === "connect") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let agent;
    try {
      let paired = config;
      if (
        command === "remote" &&
        config.device?.id &&
        config.baseUrl &&
        new URL(config.baseUrl).origin !== new URL(baseUrl).origin
      )
        throw new Error(
          "Saved device belongs to a different application. Use a separate ANYREMOTE_CONFIG_DIR.",
        );
      if (command === "remote") {
        const enrolled = await enrollRemoteDevice({
          baseUrl,
          name: parsed.flags.name,
          agentVersion: parsed.flags.version,
          noBrowser: Boolean(parsed.flags.no_browser),
          existingDeviceId: config.device?.id,
          signal: controller.signal,
        });
        paired = { ...config, ...enrolled };
        await saveConfig(paired);
        print({ status: "approved", device: paired.device });
      }
      if (!paired.device?.id || !paired.deviceToken)
        throw new Error("Pair a device first");
      agent = new DeviceAgent({
        apiClient: api,
        deviceId: paired.device.id,
        deviceToken: paired.deviceToken,
        deviceName: paired.device.name,
        agentVersion: parsed.flags.version || "0.2.1",
        executor: createLocalToolExecutor(),
      });
      agent.on("connected", (event) => print(event));
      agent.on("disconnected", (event) => print(event));
      agent.on("error", (error) => process.stderr.write(`${error.message}\n`));
      agent.on("request", createRequestLogger());
      agent.on("revoked", () => {
        void (async () => {
          try {
            await saveConfig({
              ...paired,
              baseUrl,
              device: undefined,
              deviceToken: undefined,
            });
            process.stderr.write(
              "Device authorization was revoked. Saved device credentials were cleared. Run remote again to register this computer.\n",
            );
          } catch (error) {
            process.stderr.write(
              `Device authorization was revoked, but saved credentials could not be cleared: ${error.message}\n`,
            );
          } finally {
            stop();
          }
        })();
      });
      controller.signal.throwIfAborted();
      agent.start();
      await new Promise((resolve) => {
        controller.signal.addEventListener("abort", resolve, { once: true });
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      try {
        await agent?.shutdown();
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { main };
