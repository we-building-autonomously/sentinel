import { describe, it, expect } from "vitest";
import { Debouncer, watchAndRun, type TimerFns, type ChangeSource } from "./watch.js";

/** A manually-advanced timer so debounce behavior is deterministic. */
function fakeClock() {
  let id = 0;
  const pending = new Map<number, () => void>();
  const timers: TimerFns = {
    set: (cb) => {
      const h = ++id;
      pending.set(h, cb);
      return h;
    },
    clear: (h) => {
      pending.delete(h as number);
    },
  };
  return {
    timers,
    flush() {
      const cbs = [...pending.values()];
      pending.clear();
      cbs.forEach((cb) => cb());
    },
    get count() {
      return pending.size;
    },
  };
}

describe("Debouncer", () => {
  it("collapses rapid triggers into a single call", () => {
    const clock = fakeClock();
    let calls = 0;
    const d = new Debouncer(100, () => calls++, clock.timers);
    d.trigger();
    d.trigger();
    d.trigger();
    expect(calls).toBe(0);
    expect(clock.count).toBe(1); // only the latest timer is live
    clock.flush();
    expect(calls).toBe(1);
  });

  it("cancel prevents a pending call", () => {
    const clock = fakeClock();
    let calls = 0;
    const d = new Debouncer(100, () => calls++, clock.timers);
    d.trigger();
    d.cancel();
    expect(d.pending).toBe(false);
    clock.flush();
    expect(calls).toBe(0);
  });
});

describe("watchAndRun", () => {
  const delay = () => new Promise((r) => setTimeout(r, 0));

  it("runs once on start when runOnStart is set", async () => {
    const clock = fakeClock();
    let runs = 0;
    watchAndRun({ source: () => () => {}, run: async () => void runs++, timers: clock.timers });
    await delay();
    expect(runs).toBe(1);
  });

  it("debounces a burst of changes into one extra run", async () => {
    const clock = fakeClock();
    let runs = 0;
    let emit: () => void = () => {};
    const source: ChangeSource = (onChange) => {
      emit = onChange;
      return () => {};
    };
    watchAndRun({ source, run: async () => void runs++, runOnStart: false, timers: clock.timers });
    emit();
    emit();
    emit();
    clock.flush();
    await delay();
    expect(runs).toBe(1);
  });

  it("queues exactly one re-run when a change lands mid-run", async () => {
    const clock = fakeClock();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let emit: () => void = () => {};
    const source: ChangeSource = (onChange) => {
      emit = onChange;
      return () => {};
    };
    watchAndRun({
      source,
      run: async () => {
        runs++;
        if (runs === 1) await gate; // hold the first run open
      },
      timers: clock.timers,
    });
    await delay(); // first run starts (runOnStart) and blocks on the gate
    emit();
    emit();
    clock.flush(); // debounced trigger fires while run #1 is in flight -> queued
    release(); // let run #1 finish; queued run #2 should fire
    await delay();
    await delay();
    expect(runs).toBe(2);
  });

  it("stop() unsubscribes and cancels pending runs", async () => {
    const clock = fakeClock();
    let unsubbed = false;
    const source: ChangeSource = () => () => {
      unsubbed = true;
    };
    const h = watchAndRun({ source, run: async () => {}, runOnStart: false, timers: clock.timers });
    h.stop();
    expect(unsubbed).toBe(true);
  });
});
