export const DEFAULT_CONTROL_COALESCE_MS = 250;
export const MAX_CONTROL_COALESCE_MS = 1000;
// 两次变化间隔不足 1 ms 视为同一步（pySerial 连续设置 DTR 与 RTS）。
const SAME_STEP_MS = 1;
const MAX_STEPS = 16;
const MAX_STEP_DELAY_MS = 2000;

/**
 * 把 RFC2217 客户端的 DTR/RTS 变化合并成一个 `control{sequence}`（2026-11-09）。
 * - 首个变化开始 windowMs 窗口；窗口内的每个变化都带相对时间记录。
 * - 窗口结束时一次发出：只有一步 → 单个 control；否则 `sequence`，delayMs 是该步之后的等待，末步为 0。
 * - 序列满 16 步时提前发送；windowMs 为 0 时不合并，立即发送。
 *
 * @param {object} options
 * @param {(control: object) => void} options.send
 */
export function createControlCoalescer({
  send,
  windowMs = DEFAULT_CONTROL_COALESCE_MS,
  now = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** @type {Array<{ at: number, dtr?: boolean, rts?: boolean }>} */
  let steps = [];
  let windowTimer = null;

  function emit() {
    if (windowTimer) clearTimer(windowTimer);
    windowTimer = null;
    const batch = steps;
    steps = [];
    if (batch.length === 0) return;
    if (batch.length === 1) {
      const { at: _at, ...single } = batch[0];
      send(single);
      return;
    }
    const sequence = batch.map(({ at, ...line }, index) => ({
      ...line,
      delayMs:
        index === batch.length - 1
          ? 0
          : Math.min(
              MAX_STEP_DELAY_MS,
              Math.max(0, Math.round(batch[index + 1].at - at)),
            ),
    }));
    send({ sequence });
  }

  return {
    /** @param {{ dtr?: boolean, rts?: boolean }} change */
    change(change) {
      if (change.dtr === undefined && change.rts === undefined) return;
      if (windowMs <= 0) {
        send({
          ...(change.dtr !== undefined ? { dtr: change.dtr } : {}),
          ...(change.rts !== undefined ? { rts: change.rts } : {}),
        });
        return;
      }
      const at = now();
      const last = steps[steps.length - 1];
      if (last && at - last.at < SAME_STEP_MS) {
        if (change.dtr !== undefined) last.dtr = change.dtr;
        if (change.rts !== undefined) last.rts = change.rts;
        return;
      }
      if (!last) {
        windowTimer = setTimer(emit, windowMs);
        windowTimer.unref?.();
      }
      steps.push({
        at,
        ...(change.dtr !== undefined ? { dtr: change.dtr } : {}),
        ...(change.rts !== undefined ? { rts: change.rts } : {}),
      });
      if (steps.length >= MAX_STEPS) emit();
    },
    /** 在发送其它控制（波特率、break、purge）之前调用，保持顺序。 */
    flush: emit,
    close() {
      if (windowTimer) clearTimer(windowTimer);
      windowTimer = null;
      steps = [];
    },
    pending: () => steps.length,
  };
}
