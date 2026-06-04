/**
 * Safety rails for the agent loop. Stops a run that has either spent its
 * wall-clock budget or got stuck repeating the same action with no effect.
 * Pure and deterministic (time is injected) so it is fully unit-testable.
 */

export interface GuardConfig {
  /** Absolute wall-clock budget for the whole run, in ms. 0/undefined = none. */
  maxDurationMs?: number;
  /** Stop after the same action repeats this many times in a row. Default 3. */
  maxRepeats?: number;
  /** Stop after this many consecutive ineffective actions (no page change). Default 5. */
  maxNoProgress?: number;
  /**
   * Stop after the SAME action is taken from the SAME page state this many
   * times total (not necessarily consecutively) — catches oscillation loops
   * (A→B→A→B) the consecutive-repeat guard misses. Default 4.
   */
  maxCycle?: number;
  /** Run start time (ms epoch), injected for determinism. */
  startedAt: number;
}

export type GuardStop =
  | { stop: false }
  | { stop: true; reason: "time" | "repeat" | "stuck" | "cycle"; message: string };

const OK: GuardStop = { stop: false };

export class LoopGuard {
  private lastAction?: string;
  private repeat = 0;
  private lastPage?: string;
  private noProgress = 0;
  /** Count of each (page-state, action) pair seen across the whole run. */
  private visits = new Map<string, number>();

  constructor(private cfg: GuardConfig) {}

  private get maxRepeats(): number {
    return this.cfg.maxRepeats ?? 3;
  }
  private get maxNoProgress(): number {
    return this.cfg.maxNoProgress ?? 5;
  }
  private get maxCycle(): number {
    return this.cfg.maxCycle ?? 4;
  }

  /** Cheap pre-LLM check so we don't pay for a call past the time budget. */
  timeExceeded(now: number): GuardStop {
    if (this.cfg.maxDurationMs && now - this.cfg.startedAt >= this.cfg.maxDurationMs) {
      return {
        stop: true,
        reason: "time",
        message: `Time budget of ${this.cfg.maxDurationMs}ms exhausted before completing the task.`,
      };
    }
    return OK;
  }

  /**
   * Register the action the model chose this step (and the page signature it
   * acted on). Returns a stop verdict if the run is looping or stuck.
   */
  register(now: number, actionSig: string, pageSig: string): GuardStop {
    const t = this.timeExceeded(now);
    if (t.stop) return t;

    // Same action chosen consecutively -> looping.
    if (actionSig === this.lastAction) {
      this.repeat++;
    } else {
      this.repeat = 0;
      this.lastAction = actionSig;
    }
    if (this.repeat + 1 >= this.maxRepeats) {
      return {
        stop: true,
        reason: "repeat",
        message: `Repeated the same action ${this.maxRepeats}x in a row without progress: ${actionSig}.`,
      };
    }

    // Page never changed across many steps -> stuck (actions having no effect).
    if (pageSig === this.lastPage) {
      this.noProgress++;
    } else {
      this.noProgress = 0;
      this.lastPage = pageSig;
    }
    if (this.noProgress + 1 >= this.maxNoProgress) {
      return {
        stop: true,
        reason: "stuck",
        message: `No observable page change across ${this.maxNoProgress} consecutive actions — likely stuck.`,
      };
    }

    // Oscillation: the same action taken from the same page state repeatedly
    // (e.g. A→B→A→B) — each step "progresses" vs the last so the counters above
    // never trip, yet the agent is going in circles re-doing prior work.
    const visitKey = `${pageSig}»${actionSig}`;
    const seen = (this.visits.get(visitKey) ?? 0) + 1;
    this.visits.set(visitKey, seen);
    if (seen >= this.maxCycle) {
      return {
        stop: true,
        reason: "cycle",
        message: `Stuck in a loop — took the same action from the same page state ${this.maxCycle}x (oscillating without net progress): ${actionSig}.`,
      };
    }

    return OK;
  }
}
