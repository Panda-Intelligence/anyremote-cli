import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceAgent } from "../src/agent.js";

const MockWebSocket = { OPEN: 1 };

function createAgent(executor) {
  const sent = [];
  const agent = new DeviceAgent({
    apiClient: {},
    deviceId: "device-1",
    deviceToken: "device-token",
    executor,
    WebSocketImpl: MockWebSocket,
  });
  agent.socket = {
    readyState: MockWebSocket.OPEN,
    send(raw) {
      const envelope = JSON.parse(raw);
      sent.push({
        requestId: envelope.requestId,
        status: envelope.payload.status,
        code: envelope.payload.error?.code,
        dataLength: envelope.payload.output?.data?.length,
      });
    },
  };
  return { agent, sent };
}

function screenCaptureRequest(requestId) {
  return {
    requestId,
    payload: {
      tool: "screen.capture",
      arguments: {},
      deadline: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function clearCleanupTimer(agent) {
  clearTimeout(agent.completedCleanupTimer);
  agent.completedCleanupTimer = null;
  agent.socket = null;
}

test("screen capture cache enforces a byte budget and expires to a replay tombstone", async () => {
  let executions = 0;
  const { agent, sent } = createAgent({
    execute: async () => {
      executions += 1;
      return { data: "x".repeat(1_398_104) };
    },
  });
  try {
    for (let index = 0; index < 6; index += 1)
      await agent.handleRequest(screenCaptureRequest(`capture-${index}`));

    assert.equal(executions, 5);
    assert.equal(sent[5].status, "error");
    assert.equal(sent[5].code, "RATE_LIMITED");
    assert.equal(agent.completedResultBytes <= 8 * 1024 * 1024, true);

    await agent.handleRequest(screenCaptureRequest("capture-0"));
    assert.equal(sent.at(-1).status, "success");
    assert.equal(sent.at(-1).dataLength, 1_398_104);
    assert.equal(executions, 5);

    agent.pruneCompletedResults(Date.now() + 60_001);
    await agent.handleRequest(screenCaptureRequest("capture-0"));
    assert.equal(sent.at(-1).status, "unknown");
    assert.equal(sent.at(-1).code, "OUTCOME_UNKNOWN");
    assert.equal(executions, 5);
  } finally {
    clearCleanupTimer(agent);
  }
});

test("screen capture allows only one active capture per device agent", async () => {
  let executions = 0;
  let releaseCapture;
  let announceStarted;
  const started = new Promise((resolve) => {
    announceStarted = resolve;
  });
  const captureGate = new Promise((resolve) => {
    releaseCapture = resolve;
  });
  const { agent, sent } = createAgent({
    execute: async () => {
      executions += 1;
      announceStarted();
      await captureGate;
      return { data: "captured" };
    },
  });
  try {
    const firstRequest = screenCaptureRequest("capture-1");
    firstRequest.payload.deadline = new Date(Date.now() + 30).toISOString();
    const firstCapture = agent.handleRequest(firstRequest);
    await started;
    await firstCapture;
    assert.equal(sent.at(-1).code, "OUTCOME_UNKNOWN");

    await agent.handleRequest(screenCaptureRequest("capture-2"));

    assert.equal(executions, 1);
    assert.equal(sent.at(-1).requestId, "capture-2");
    assert.equal(sent.at(-1).code, "RATE_LIMITED");

    releaseCapture();
    await new Promise((resolve) => setImmediate(resolve));
    await agent.handleRequest(screenCaptureRequest("capture-3"));
    assert.equal(executions, 2);
    assert.equal(sent.at(-1).requestId, "capture-3");
    assert.equal(sent.at(-1).status, "success");
  } finally {
    releaseCapture();
    clearCleanupTimer(agent);
  }
});
