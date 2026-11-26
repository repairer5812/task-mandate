import { type LeasePlan, nextRenewal } from "@task-mandate/core";

/** Result of one renewal tick. */
export type TickResult = "issued" | "not-started" | "waiting" | "finished" | "stopped";

/** Callbacks and schedule for `Renewer`. */
export interface RenewerOptions {
  plan: LeasePlan;
  issue: (window: { nbf: Date; exp: Date }) => Promise<string>;
  write: (mandate: string) => Promise<void>;
  now?: () => Date;
  /** Chunk already issued. The first tick issues one when this is absent. */
  initial?: { mandate: string; nbf: Date; exp: Date };
}

/** Issues the next mandate chunk and writes it. `stop` during issue drops the new token. */
export class Renewer {
  private readonly plan: LeasePlan;
  private readonly issue: (window: { nbf: Date; exp: Date }) => Promise<string>;
  private readonly write: (mandate: string) => Promise<void>;
  private readonly now: () => Date;
  private stopped = false;
  private mandate: string | undefined;
  private window: { nbf: Date; exp: Date } | undefined;
  private queued: Promise<void> | undefined;

  constructor(opts: RenewerOptions) {
    this.plan = opts.plan;
    this.issue = opts.issue;
    this.write = opts.write;
    this.now = opts.now ?? (() => new Date());
    if (opts.initial) {
      this.mandate = opts.initial.mandate;
      this.window = { nbf: new Date(opts.initial.nbf.getTime()), exp: new Date(opts.initial.exp.getTime()) };
    }
  }

  async tick(): Promise<TickResult> {
    const waitFor = this.queued;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queued = done;
    // Skip the await when idle, so a stop() called before this tick is seen by apply() in the same turn.
    if (waitFor) await waitFor;
    try {
      return await this.apply();
    } finally {
      if (this.queued === done) this.queued = undefined;
      release();
    }
  }

  private async apply(): Promise<TickResult> {
    const step = nextRenewal(this.plan, this.now(), this.window, this.stopped);
    if (!step.issue) return step.reason;
    const mandate = await this.issue({ nbf: step.nbf, exp: step.exp });
    // If stop() ran while issue() was in flight, do not store the new mandate.
    if (this.stopped) return "stopped";
    await this.write(mandate);
    this.mandate = mandate;
    this.window = { nbf: new Date(step.nbf.getTime()), exp: new Date(step.exp.getTime()) };
    return "issued";
  }

  stop(): void {
    this.stopped = true;
  }

  current(): string | undefined {
    return this.mandate;
  }
}
