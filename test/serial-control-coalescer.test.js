import assert from "node:assert/strict";
import { test } from "node:test";
import { serialControlSchema } from "@anyremote/contracts";
import { createControlCoalescer } from "../src/serial/control-coalescer.js";

/** 假时钟：推进时间并触发到期的计时器。 */
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return { id, unref() {} };
    },
    clearTimer(handle) {
      timers.delete(handle.id);
    },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = target;
    },
  };
}

function setup(options = {}) {
  const clock = fakeClock();
  const sent = [];
  const coalescer = createControlCoalescer({
    send: (control) => {
      serialControlSchema.parse(control);
      sent.push({ at: clock.now(), control });
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  return { clock, sent, coalescer };
}

test("an isolated change is sent once when the 250 ms window ends", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ dtr: true });
  clock.advance(249);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.deepEqual(sent, [{ at: 250, control: { dtr: true } }]);
  clock.advance(1000);
  assert.equal(sent.length, 1);
});

test("DTR and RTS set in the same tick stay one step", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ dtr: false });
  coalescer.change({ rts: true });
  clock.advance(250);
  assert.deepEqual(
    sent.map((s) => s.control),
    [{ dtr: false, rts: true }],
  );
});

test("an esptool-like burst at 0/100/150/200 ms becomes one sequence with the recorded gaps", () => {
  const { clock, sent, coalescer } = setup();
  const toggles = [
    [0, { dtr: false, rts: true }],
    [100, { dtr: true }],
    [150, { rts: false }],
    [200, { dtr: false }],
  ];
  let elapsed = 0;
  for (const [at, change] of toggles) {
    clock.advance(at - elapsed);
    elapsed = at;
    coalescer.change(change);
  }
  clock.advance(300);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].at, 250, "sent when the window closes");
  const { sequence } = sent[0].control;
  assert.equal(sequence.length, 4);
  const expected = [100, 50, 50, 0];
  sequence.forEach((step, index) => {
    assert.ok(Math.abs(step.delayMs - expected[index]) <= 15);
  });
  assert.equal(sequence[3].delayMs, 0);
  assert.deepEqual(sequence[0], { dtr: false, rts: true, delayMs: 100 });
});

test("changes spaced apart inside one window are batched, not sent separately", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ rts: true });
  clock.advance(100);
  coalescer.change({ rts: false });
  clock.advance(200);
  assert.deepEqual(
    sent.map((s) => [s.at, s.control]),
    [
      [
        250,
        {
          sequence: [
            { rts: true, delayMs: 100 },
            { rts: false, delayMs: 0 },
          ],
        },
      ],
    ],
  );
});

test("the same line changed within one millisecond collapses to the last value", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ dtr: true });
  coalescer.change({ dtr: false });
  clock.advance(250);
  assert.deepEqual(
    sent.map((s) => s.control),
    [{ dtr: false }],
  );
});

test("changes after the window closes start a new window", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ dtr: true });
  clock.advance(10);
  coalescer.change({ dtr: false });
  clock.advance(240);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].control.sequence);
  coalescer.change({ dtr: true });
  clock.advance(250);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].control, { dtr: true });
});

test("flush emits the pending window before another control so order is kept", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ dtr: true });
  clock.advance(5);
  coalescer.change({ dtr: false });
  assert.equal(coalescer.pending(), 2);
  coalescer.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].control.sequence.map((s) => s.dtr),
    [true, false],
  );
  assert.equal(coalescer.pending(), 0);
  clock.advance(1000);
  assert.equal(sent.length, 1, "the window timer was cancelled");
});

test("windowMs 0 sends every change immediately", () => {
  const { sent, coalescer } = setup({ windowMs: 0 });
  coalescer.change({ dtr: true });
  coalescer.change({ rts: false });
  assert.deepEqual(
    sent.map((s) => s.control),
    [{ dtr: true }, { rts: false }],
  );
});

test("a full sequence is sent early and always satisfies the control schema", () => {
  const { clock, sent, coalescer } = setup();
  for (let index = 0; index < 20; index += 1) {
    coalescer.change({ dtr: index % 2 === 0 });
    clock.advance(5);
  }
  clock.advance(500);
  assert.ok(sent.length >= 2);
  for (const { control } of sent) {
    const steps = control.sequence ?? [control];
    assert.ok(steps.length <= 16);
  }
});

test("close discards pending changes", () => {
  const { clock, sent, coalescer } = setup();
  coalescer.change({ dtr: true });
  coalescer.close();
  clock.advance(1000);
  assert.equal(sent.length, 0);
});
