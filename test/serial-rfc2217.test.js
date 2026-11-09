import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { test } from "node:test";
import {
  CP,
  createRfc2217Connection,
  createTelnetParser,
  DO,
  escapeIac,
  IAC,
  MODEM_STATE,
  OPT_BINARY,
  OPT_COM_PORT,
  SB,
  SE,
  subnegotiation,
  WILL,
} from "../src/serial/rfc2217.js";

const SETTINGS = {
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
};

/** 脚本化 Telnet 客户端：收集服务端发来的子协商与数据。 */
async function harness(options = {}) {
  const events = { tx: [], baud: [], control: [], purge: [] };
  let connection;
  const accepted = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    connection = createRfc2217Connection(socket, {
      settings: { ...SETTINGS },
      onTx: (data) => {
        events.tx.push(Buffer.from(data));
        return options.txResult;
      },
      onBaudRate: (patch) => events.baud.push(patch),
      onControl: (control) => events.control.push(control),
      onPurge: (which) => events.purge.push(which),
      modemState: options.modemState ?? MODEM_STATE.CTS | MODEM_STATE.DSR,
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = net.connect(server.address().port, "127.0.0.1");
  await once(client, "connect");
  const received = { data: [], commands: [], sub: [] };
  const parser = createTelnetParser({
    onData: (chunk) => received.data.push(Buffer.from(chunk)),
    onCommand: (verb, option) => received.commands.push([verb, option]),
    onSubnegotiation: (option, payload) =>
      received.sub.push({
        option,
        code: payload[0],
        value: payload.subarray(1),
      }),
  });
  client.on("data", (chunk) => parser.push(chunk));
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out: ${label}`);
  };
  const sendSub = (code, payload) =>
    client.write(subnegotiation(code, payload));
  const answer = async (code, payload) => {
    const before = received.sub.length;
    sendSub(code, payload);
    await waitFor(
      () => received.sub.slice(before).some((sub) => sub.code === code + 100),
      `answer ${code}`,
    );
    return received.sub.slice(before).find((sub) => sub.code === code + 100);
  };
  await waitFor(() => received.commands.length >= 5, "initial negotiation");
  return {
    events,
    received,
    client,
    waitFor,
    sendSub,
    answer,
    get connection() {
      return connection;
    },
    async close() {
      client.destroy();
      for (const socket of accepted) socket.destroy();
      server.close();
    },
  };
}

test("the server opens with binary, SGA and COM-PORT negotiation and does not loop", async () => {
  const h = await harness();
  const offered = h.received.commands.map(
    ([verb, option]) => `${verb}:${option}`,
  );
  assert.ok(offered.includes(`${WILL}:${OPT_COM_PORT}`));
  assert.ok(offered.includes(`${DO}:${OPT_COM_PORT}`));
  assert.ok(offered.includes(`${WILL}:${OPT_BINARY}`));
  // A client that acknowledges (DO / WILL) and then asks for an unknown option.
  h.client.write(
    Buffer.from([IAC, DO, OPT_COM_PORT, IAC, WILL, OPT_COM_PORT, IAC, DO, 77]),
  );
  await h.waitFor(
    () => h.received.commands.some(([, option]) => option === 77),
    "refusal",
  );
  const count = h.received.commands.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.received.commands.length, count, "no negotiation loop");
  assert.deepEqual(
    h.received.commands.at(-1),
    [252, 77],
    "unknown options get WONT",
  );
  await h.close();
});

test("data is IAC-escaped both ways, even when split across TCP segments", async () => {
  const h = await harness();
  const rx = Buffer.from([0x01, 0xff, 0x02, 0xff, 0xff, 0x03]);
  h.connection.writeRx(rx);
  await h.waitFor(
    () => Buffer.concat(h.received.data).length >= rx.length,
    "rx",
  );
  assert.deepEqual(Buffer.concat(h.received.data), rx);
  assert.deepEqual(
    escapeIac(Buffer.from([0xff, 0x41])),
    Buffer.from([0xff, 0xff, 0x41]),
  );

  const wire = Buffer.from([
    0x41,
    IAC,
    IAC,
    0x42,
    IAC,
    SB,
    OPT_COM_PORT,
    CP.SET_BAUDRATE,
    0,
    3,
    0x84,
    0,
    IAC,
    SE,
    0x43,
  ]);
  for (const byte of wire) {
    h.client.write(Buffer.from([byte]));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await h.waitFor(() => Buffer.concat(h.events.tx).length >= 4, "tx");
  assert.deepEqual(
    Buffer.concat(h.events.tx),
    Buffer.from([0x41, 0xff, 0x42, 0x43]),
  );
  assert.deepEqual(h.events.baud, [{ baudRate: 230400 }]);
  await h.close();
});

test("SET-BAUDRATE applies once and echoes the value; zero asks for the current one", async () => {
  const h = await harness();
  const request = Buffer.alloc(4);
  request.writeUInt32BE(921600);
  const reply = await h.answer(CP.SET_BAUDRATE, request);
  assert.equal(reply.option, OPT_COM_PORT);
  assert.equal(reply.code, CP.SET_BAUDRATE + 100);
  assert.equal(reply.value.readUInt32BE(0), 921600);
  assert.deepEqual(h.events.baud, [{ baudRate: 921600 }]);
  const query = await h.answer(CP.SET_BAUDRATE, Buffer.alloc(4));
  assert.equal(query.value.readUInt32BE(0), 921600);
  assert.equal(h.events.baud.length, 1);
  await h.close();
});

test("data size, parity, stop size and flow control report the fixed session values", async () => {
  const h = await harness();
  assert.deepEqual([...(await h.answer(CP.SET_DATASIZE, [8])).value], [8]);
  // The device cannot change the frame format mid-session: the real value is returned.
  assert.deepEqual([...(await h.answer(CP.SET_DATASIZE, [7])).value], [8]);
  assert.deepEqual([...(await h.answer(CP.SET_PARITY, [3])).value], [1]);
  assert.deepEqual([...(await h.answer(CP.SET_STOPSIZE, [2])).value], [1]);
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [3])).value], [1]);
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [0])).value], [1]);
  assert.deepEqual(h.events.control, []);
  await h.close();
});

test("SET-CONTROL toggles DTR and RTS, answers with the applied code and supports queries", async () => {
  const h = await harness();
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [8])).value], [8]);
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [12])).value], [12]);
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [9])).value], [9]);
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [11])).value], [11]);
  assert.deepEqual(h.events.control, [
    { dtr: true },
    { rts: false },
    { dtr: false },
    { rts: true },
  ]);
  assert.deepEqual(
    [...(await h.answer(CP.SET_CONTROL, [7])).value],
    [9],
    "DTR query",
  );
  assert.deepEqual(
    [...(await h.answer(CP.SET_CONTROL, [10])).value],
    [11],
    "RTS query",
  );
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [5])).value], [5]);
  assert.deepEqual(h.events.control.at(-1), { breakMs: 250 });
  assert.deepEqual(
    [...(await h.answer(CP.SET_CONTROL, [4])).value],
    [5],
    "break state query",
  );
  assert.deepEqual([...(await h.answer(CP.SET_CONTROL, [6])).value], [6]);
  await h.close();
});

test("modem state notifications follow the mask and carry the delta bits", async () => {
  const h = await harness();
  // Nothing is sent before a mask is installed.
  h.connection.notifyModemState(MODEM_STATE.CTS);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.received.sub.length, 0);
  const mask = await h.answer(CP.SET_MODEMSTATE_MASK, [0xff]);
  assert.equal(mask.code, CP.SET_MODEMSTATE_MASK + 100);
  await h.waitFor(
    () => h.received.sub.some((s) => s.code === CP.NOTIFY_MODEMSTATE + 100),
    "initial notify",
  );
  h.connection.notifyModemState(
    MODEM_STATE.CTS | MODEM_STATE.DSR | MODEM_STATE.DCD,
  );
  await h.waitFor(
    () => h.received.sub.filter((s) => s.code === 107).length >= 2,
    "change notify",
  );
  const last = h.received.sub.filter((s) => s.code === 107).at(-1);
  assert.equal(last.value[0] & MODEM_STATE.DELTA_DCD, MODEM_STATE.DELTA_DCD);
  assert.equal(last.value[0] & MODEM_STATE.DCD, MODEM_STATE.DCD);
  assert.equal(last.value[0] & MODEM_STATE.DELTA_CTS, 0);
  const lineMask = await h.answer(CP.SET_LINESTATE_MASK, [0]);
  assert.equal(lineMask.code, 110);
  await h.close();
});

test("PURGE-DATA maps to rx, tx and both and is acknowledged", async () => {
  const h = await harness();
  for (const [value, which] of [
    [1, "rx"],
    [2, "tx"],
    [3, "both"],
  ]) {
    const reply = await h.answer(CP.PURGE_DATA, [value]);
    assert.equal(reply.code, 112);
    assert.deepEqual([...reply.value], [value]);
    assert.equal(h.events.purge.at(-1), which);
  }
  await h.close();
});

test("the signature request is answered and flow-control suspend holds device data", async () => {
  const h = await harness();
  const signature = await h.answer(CP.SIGNATURE, []);
  assert.equal(signature.code, 100);
  assert.match(signature.value.toString(), /AnyRemote/);
  h.sendSub(CP.FLOWCONTROL_SUSPEND, []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.connection.writeRx(Buffer.from("held"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(Buffer.concat(h.received.data).length, 0);
  h.sendSub(CP.FLOWCONTROL_RESUME, []);
  await h.waitFor(
    () => Buffer.concat(h.received.data).toString() === "held",
    "resume",
  );
  await h.close();
});

test("onTx returning false pauses the socket until resume() is called", async () => {
  const h = await harness({ txResult: false });
  h.client.write(Buffer.from("one"));
  await h.waitFor(() => h.events.tx.length === 1, "first chunk");
  h.client.write(Buffer.from("two"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(h.events.tx.length, 1, "socket is paused");
  h.connection.resume();
  await h.waitFor(() => h.events.tx.length === 2, "second chunk after resume");
  await h.close();
});

test("oversized or malformed subnegotiations are ignored without crashing", async () => {
  const h = await harness();
  h.client.write(
    Buffer.concat([
      Buffer.from([IAC, SB, OPT_COM_PORT, CP.SET_BAUDRATE]),
      Buffer.alloc(1000, 1),
      Buffer.from([IAC, SE]),
    ]),
  );
  h.client.write(Buffer.from([IAC, SB, OPT_COM_PORT, IAC, 99, 1, 2]));
  h.client.write(
    Buffer.from([IAC, SB, OPT_COM_PORT, CP.SET_BAUDRATE, 0, 0, IAC, SE]),
  );
  h.client.write(Buffer.from("alive"));
  await h.waitFor(
    () => Buffer.concat(h.events.tx).toString().includes("alive"),
    "still serving",
  );
  await h.close();
});
