import fs from "node:fs";
import path from "node:path";

export interface TimerFns {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: TimerFns = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Collapse a burst of rapid triggers into a single delayed call. */
export class Debouncer {
  private handle: unknown = null;
  constructor(
    private ms: number,
    private fn: () => void,
    private timers: TimerFns = DEFAULT_TIMERS
  ) {}

  trigger(): void {
    if (this.handle != null) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.fn();
    }, this.ms);
  }

  get pending(): boolean {
    return this.handle != null;
  }

  cancel(): void {
    if (this.handle != null) {
      this.timers.clear(this.handle);
      this.handle = null;
    }
  }
}

export type Unsubscribe = () => void;
/** A source of "something changed" notifications. */
export type ChangeSource = (onChange: () => void) => Unsubscribe;

export interface WatchHandle {
  stop: () => void;
}

/**
 * Wire a change source to a runner: debounce bursts of changes, never overlap
 * runs (a change during a run queues exactly one re-run), and optionally run
 * once on start. Pure orchestration — the source and timers are injectable.
 */
export function watchAndRun(opts: {
  source: ChangeSource;
  run: () => Promise<void>;
  debounceMs?: number;
  runOnStart?: boolean;
  timers?: TimerFns;
  onError?: (err: unknown) => void;
}): WatchHandle {
  const { source, run, debounceMs = 300, runOnStart = true } = opts;
  let running = false;
  let queued = false;

  const fire = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void fire();
      }
    }
  };

  const debouncer = new Debouncer(debounceMs, () => void fire(), opts.timers);
  const unsub = source(() => debouncer.trigger());
  if (runOnStart) void fire();

  return {
    stop: () => {
      debouncer.cancel();
      unsub();
    },
  };
}

/**
 * Watch a set of files for changes. We watch each parent directory (robust to
 * editor save-via-rename) and filter events down to the target basenames.
 */
export function fileChangeSource(files: string[]): ChangeSource {
  return (onChange) => {
    const targets = new Set(files.map((f) => path.resolve(f)));
    const dirs = new Set(files.map((f) => path.dirname(path.resolve(f))));
    const watchers: fs.FSWatcher[] = [];
    for (const dir of dirs) {
      try {
        const w = fs.watch(dir, (_event, filename) => {
          if (!filename) {
            onChange();
            return;
          }
          if (targets.has(path.resolve(dir, filename.toString()))) onChange();
        });
        watchers.push(w);
      } catch {
        // Directory not watchable — skip it.
      }
    }
    return () => watchers.forEach((w) => w.close());
  };
}
