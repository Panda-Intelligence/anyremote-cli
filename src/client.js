import { randomUUID } from "node:crypto";
import { ToolError } from "./errors.js";
import { detectPlatform } from "./platform.js";
import { CLI_VERSION } from "./version.js";

function websocketUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

export class ApiClient {
  constructor({ baseUrl, token, cookie, origin, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.cookie = cookie;
    this.origin = origin || new URL(this.baseUrl).origin;
    this.fetch = fetchImpl;
  }

  async request(path, { method = "GET", body, headers = {}, signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = payload?.error || {
        code: "INTERNAL_ERROR",
        message: `${response.status} ${response.statusText}`,
      };
      throw new ToolError(
        error.code || "INTERNAL_ERROR",
        error.message || "request failed",
        { status: response.status, ...error.details },
      );
    }
    return payload?.data ?? payload;
  }

  async login({ email, password }) {
    const response = await this.fetch(
      `${this.baseUrl}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: this.origin,
        },
        body: JSON.stringify({ email, password }),
      },
    );
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = payload?.error || {
        code: "INVALID_CREDENTIALS",
        message: `${response.status} ${response.statusText}`,
      };
      throw new ToolError(
        error.code || "INVALID_CREDENTIALS",
        error.message || "login failed",
        { status: response.status },
      );
    }
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(",")[0].split(";")[0];
    const authToken = response.headers.get("set-auth-token");
    if (authToken) this.token = authToken;
    else if (payload?.token) this.token = payload.token;
    return payload?.data ?? payload;
  }

  signOut() {
    return this.request("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: this.origin },
    });
  }

  createPairing({
    name,
    platform = detectPlatform(),
    agentVersion = CLI_VERSION,
  }) {
    return this.request("/api/pairings", {
      method: "POST",
      body: { name, platform, agentVersion },
    });
  }

  pollPairing({ pairingId, code, pollToken }) {
    return this.request("/api/pairings/poll", {
      method: "POST",
      body: { pairingId, code, pollToken },
    });
  }

  listDevices() {
    return this.request("/api/devices");
  }

  getDevice(deviceId) {
    return this.request(`/api/devices/${encodeURIComponent(deviceId)}`);
  }

  revokeDevice(deviceId) {
    return this.request(`/api/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    });
  }

  connectUrl(deviceId) {
    return websocketUrl(
      this.baseUrl,
      `/api/devices/${encodeURIComponent(deviceId)}/connect`,
    );
  }

  newRequestId() {
    return randomUUID();
  }
}

export { websocketUrl };
