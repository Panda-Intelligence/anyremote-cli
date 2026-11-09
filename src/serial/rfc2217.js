/**
 * RFC 2217（Telnet COM-PORT-OPTION）服务端，2026-11-08。
 * 只实现 esptool / pySerial / PlatformIO 需要的子集；设备端数据位、校验位、停止位与流控在会话内固定，
 * 对这些参数的变更请求如实回复当前值（pySerial 会报告“远端不接受”，而不是被悄悄忽略）。
 */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;

export const OPT_BINARY = 0;
export const OPT_ECHO = 1;
export const OPT_SGA = 3;
export const OPT_COM_PORT = 44;

export const CP = Object.freeze({
  SIGNATURE: 0,
  SET_BAUDRATE: 1,
  SET_DATASIZE: 2,
  SET_PARITY: 3,
  SET_STOPSIZE: 4,
  SET_CONTROL: 5,
  NOTIFY_LINESTATE: 6,
  NOTIFY_MODEMSTATE: 7,
  FLOWCONTROL_SUSPEND: 8,
  FLOWCONTROL_RESUME: 9,
  SET_LINESTATE_MASK: 10,
  SET_MODEMSTATE_MASK: 11,
  PURGE_DATA: 12,
});
/** 服务端应答码 = 客户端命令码 + 100。 */
export const SERVER_OFFSET = 100;

export const MODEM_STATE = Object.freeze({
  DELTA_CTS: 0x01,
  DELTA_DSR: 0x02,
  TRAILING_RI: 0x04,
  DELTA_DCD: 0x08,
  CTS: 0x10,
  DSR: 0x20,
  RI: 0x40,
  DCD: 0x80,
});

const PARITY_TO_CODE = { none: 1, odd: 2, even: 3, mark: 4, space: 5 };
const CODE_TO_PARITY = Object.fromEntries(
  Object.entries(PARITY_TO_CODE).map(([name, code]) => [code, name]),
);
const STOP_TO_CODE = { 1: 1, 2: 2, 1.5: 3 };
const FLOW_TO_CODE = { none: 1, xonxoff: 2, rtscts: 3 };
const SIGNATURE = Buffer.from("AnyRemote serial bridge");
const SUPPORTED_OPTIONS = new Set([OPT_BINARY, OPT_SGA, OPT_COM_PORT]);
const MAX_SUBNEGOTIATION_BYTES = 256;

/** 数据流里的 0xFF 必须翻倍。 */
export function escapeIac(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === IAC) count += 1;
  if (count === 0) return buffer;
  const out = Buffer.allocUnsafe(buffer.length + count);
  let offset = 0;
  for (const byte of buffer) {
    out[offset++] = byte;
    if (byte === IAC) out[offset++] = IAC;
  }
  return out;
}

export function subnegotiation(code, payload = []) {
  return Buffer.concat([
    Buffer.from([IAC, SB, OPT_COM_PORT, code]),
    escapeIac(Buffer.from(payload)),
    Buffer.from([IAC, SE]),
  ]);
}

/**
 * 流式 Telnet 解析器：数据字节、IAC 命令与子协商都可能被 TCP 切在任意位置。
 */
export function createTelnetParser({ onData, onCommand, onSubnegotiation }) {
  let state = "data";
  let command = 0;
  let sb = [];
  return {
    push(chunk) {
      let runStart = -1;
      const flush = (end) => {
        if (runStart >= 0 && end > runStart)
          onData(chunk.subarray(runStart, end));
        runStart = -1;
      };
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        switch (state) {
          case "data":
            if (byte === IAC) {
              flush(index);
              state = "iac";
            } else if (runStart < 0) runStart = index;
            break;
          case "iac":
            if (byte === IAC) {
              onData(Buffer.from([IAC]));
              state = "data";
            } else if (
              byte === DO ||
              byte === DONT ||
              byte === WILL ||
              byte === WONT
            ) {
              command = byte;
              state = "option";
            } else if (byte === SB) {
              sb = [];
              state = "sb";
            } else {
              // NOP、GA 等无参数命令直接忽略。
              state = "data";
            }
            break;
          case "option":
            onCommand(command, byte);
            state = "data";
            break;
          case "sb":
            if (byte === IAC) state = "sb-iac";
            else if (sb.length < MAX_SUBNEGOTIATION_BYTES) sb.push(byte);
            break;
          case "sb-iac":
            if (byte === SE) {
              if (sb.length > 0)
                onSubnegotiation(sb[0], Buffer.from(sb.slice(1)));
              state = "data";
            } else if (byte === IAC) {
              if (sb.length < MAX_SUBNEGOTIATION_BYTES) sb.push(IAC);
              state = "sb";
            } else {
              // 非法序列：放弃这次子协商。
              state = "data";
            }
            break;
          default:
            state = "data";
        }
      }
      if (state === "data") flush(chunk.length);
    },
  };
}

/**
 * 把一个 TCP 连接变成 RFC 2217 服务端会话。
 *
 * @param {import("node:net").Socket} socket
 * @param {object} options
 * @param {{ baudRate: number, dataBits: number, parity: string, stopBits: number, flowControl: string }} options.settings
 * @param {(data: Buffer) => boolean | void} options.onTx 来自客户端的数据；返回 false 时暂停读取
 * @param {(patch: { baudRate: number }) => void} options.onBaudRate
 * @param {(control: { dtr?: boolean, rts?: boolean, breakMs?: number }) => void} options.onControl
 * @param {(which: "rx" | "tx" | "both") => void} options.onPurge
 * @param {number} [options.modemState] 初始调制解调器线状态（合成值：设备不流式上报线状态）
 */
export function createRfc2217Connection(
  socket,
  { settings, onTx, onBaudRate, onControl, onPurge, modemState = 0 },
) {
  const current = { ...settings };
  const line = { dtr: undefined, rts: undefined, brk: false };
  let modemMask = 0;
  let lineMask = 0;
  let modem = modemState;
  let suspended = false;
  const heldRx = [];
  const us = new Set();
  const them = new Set();

  const write = (buffer) => {
    if (socket.destroyed) return false;
    return socket.write(buffer);
  };
  const negotiate = (verb, option) => write(Buffer.from([IAC, verb, option]));

  const reply = (code, payload) =>
    write(subnegotiation(code + SERVER_OFFSET, payload));

  function onCommand(verb, option) {
    const supported = SUPPORTED_OPTIONS.has(option);
    if (verb === DO) {
      if (supported && !us.has(option)) {
        us.add(option);
        negotiate(WILL, option);
      } else if (!supported) negotiate(WONT, option);
    } else if (verb === WILL) {
      if (supported && !them.has(option)) {
        them.add(option);
        negotiate(DO, option);
      } else if (!supported) negotiate(DONT, option);
    } else if (verb === DONT) {
      if (us.delete(option)) negotiate(WONT, option);
    } else if (verb === WONT) {
      if (them.delete(option)) negotiate(DONT, option);
    }
  }

  function onSubnegotiation(option, data) {
    if (option !== OPT_COM_PORT || data.length === 0) return;
    const code = data[0];
    const value = data.subarray(1);
    switch (code) {
      case CP.SIGNATURE:
        reply(CP.SIGNATURE, SIGNATURE);
        break;
      case CP.SET_BAUDRATE: {
        if (value.length < 4) break;
        const requested = value.readUInt32BE(0);
        if (requested !== 0 && requested !== current.baudRate) {
          current.baudRate = requested;
          onBaudRate({ baudRate: requested });
        }
        const out = Buffer.alloc(4);
        out.writeUInt32BE(current.baudRate);
        reply(CP.SET_BAUDRATE, out);
        break;
      }
      case CP.SET_DATASIZE:
        reply(CP.SET_DATASIZE, [current.dataBits]);
        break;
      case CP.SET_PARITY:
        reply(CP.SET_PARITY, [PARITY_TO_CODE[current.parity] ?? 1]);
        break;
      case CP.SET_STOPSIZE:
        reply(CP.SET_STOPSIZE, [STOP_TO_CODE[current.stopBits] ?? 1]);
        break;
      case CP.SET_CONTROL:
        handleControl(value[0]);
        break;
      case CP.FLOWCONTROL_SUSPEND:
        suspended = true;
        break;
      case CP.FLOWCONTROL_RESUME:
        suspended = false;
        for (const chunk of heldRx.splice(0)) write(chunk);
        break;
      case CP.SET_LINESTATE_MASK:
        lineMask = value[0] ?? 0;
        reply(CP.SET_LINESTATE_MASK, [lineMask]);
        break;
      case CP.SET_MODEMSTATE_MASK:
        modemMask = value[0] ?? 0;
        reply(CP.SET_MODEMSTATE_MASK, [modemMask]);
        // 掩码生效后立即给出当前状态，客户端据此初始化 CTS/DSR/RI/CD。
        notifyModemState(modem, true);
        break;
      case CP.PURGE_DATA: {
        const which = { 1: "rx", 2: "tx", 3: "both" }[value[0]];
        if (which) onPurge(which);
        reply(CP.PURGE_DATA, [value[0] ?? 0]);
        break;
      }
      default:
        break;
    }
  }

  function handleControl(value) {
    switch (value) {
      case 0:
        reply(CP.SET_CONTROL, [FLOW_TO_CODE[current.flowControl] ?? 1]);
        break;
      // 1/2/3：设置流控。会话内固定，所以回复当前值。
      case 1:
      case 2:
      case 3:
        reply(CP.SET_CONTROL, [FLOW_TO_CODE[current.flowControl] ?? 1]);
        break;
      case 4:
        reply(CP.SET_CONTROL, [line.brk ? 5 : 6]);
        break;
      case 5:
        line.brk = true;
        onControl({ breakMs: 250 });
        reply(CP.SET_CONTROL, [5]);
        break;
      case 6:
        line.brk = false;
        reply(CP.SET_CONTROL, [6]);
        break;
      case 7:
        reply(CP.SET_CONTROL, [line.dtr === false ? 9 : 8]);
        break;
      case 8:
      case 9:
        line.dtr = value === 8;
        onControl({ dtr: line.dtr });
        reply(CP.SET_CONTROL, [value]);
        break;
      case 10:
        reply(CP.SET_CONTROL, [line.rts === false ? 12 : 11]);
        break;
      case 11:
      case 12:
        line.rts = value === 11;
        onControl({ rts: line.rts });
        reply(CP.SET_CONTROL, [value]);
        break;
      default:
        // 13-19 是入站流控：设备端不支持，保持现状并回复当前流控值。
        reply(CP.SET_CONTROL, [FLOW_TO_CODE[current.flowControl] ?? 1]);
    }
  }

  function notifyModemState(state, force = false) {
    const changed = (state ^ modem) & 0xf0;
    let delta = 0;
    if (changed & MODEM_STATE.CTS) delta |= MODEM_STATE.DELTA_CTS;
    if (changed & MODEM_STATE.DSR) delta |= MODEM_STATE.DELTA_DSR;
    if (modem & MODEM_STATE.RI && !(state & MODEM_STATE.RI))
      delta |= MODEM_STATE.TRAILING_RI;
    if (changed & MODEM_STATE.DCD) delta |= MODEM_STATE.DELTA_DCD;
    modem = state;
    const value = (state & 0xf0) | delta;
    if (!force && (value & modemMask) === 0) return;
    if (modemMask === 0 && !force) return;
    write(subnegotiation(CP.NOTIFY_MODEMSTATE + SERVER_OFFSET, [value]));
  }

  const parser = createTelnetParser({
    onData(chunk) {
      if (onTx(chunk) === false) socket.pause();
    },
    onCommand,
    onSubnegotiation,
  });

  // 服务端先发起：我们发送与接收二进制，并启用 COM-PORT 选项。
  for (const [verb, option] of [
    [WILL, OPT_SGA],
    [WILL, OPT_BINARY],
    [DO, OPT_BINARY],
    [WILL, OPT_COM_PORT],
    [DO, OPT_COM_PORT],
  ]) {
    if (verb === WILL) us.add(option);
    else them.add(option);
    negotiate(verb, option);
  }

  socket.on("data", (chunk) => parser.push(chunk));

  return {
    settings: current,
    /** 设备数据 → 客户端；返回 false 表示 TCP 写缓冲已满。 */
    writeRx(buffer) {
      const escaped = escapeIac(buffer);
      if (suspended) {
        heldRx.push(escaped);
        return true;
      }
      return write(escaped);
    },
    notifyModemState,
    notifyLineState(state) {
      if ((state & lineMask) === 0) return;
      write(subnegotiation(CP.NOTIFY_LINESTATE + SERVER_OFFSET, [state]));
    },
    resume() {
      if (!socket.destroyed) socket.resume();
    },
  };
}

export const COM_PORT_PARITY_NAMES = CODE_TO_PARITY;
