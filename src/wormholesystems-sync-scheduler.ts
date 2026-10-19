import { performance } from "node:perf_hooks";

export const WORMHOLESYSTEMS_SYNC_PERIOD_MS = 5 * 60_000;
// Allow normal event-loop timer jitter, but never replay a genuinely missed slot.
export const WORMHOLESYSTEMS_SYNC_LATE_GRACE_MS = 1_000;

export type SyncSchedulerClock = {
  monotonicNow(): number;
  wallNow(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

export type SyncSchedulerEligibility = { enabled: boolean; mapId?: string; reason?: string };

const systemClock: SyncSchedulerClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
};

export class WormholeSystemsSyncScheduler {
  private running = false;
  private startedAt = 0;
  private startedWallAt = 0;
  private nextSlotAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private lastAttemptedSlotAt: string | null = null;
  private lastCompletedSlotAt: string | null = null;
  private lastOutcome: string | null = null;
  private lastSkipReason: string | null = null;

  constructor(private readonly options: {
    eligibility: () => SyncSchedulerEligibility;
    occupied: () => boolean;
    run: (mapId: string, slotAt: string) => Promise<string>;
    clock?: SyncSchedulerClock;
    log?: (event: Record<string, unknown>) => void;
  }) {}

  private get clock(): SyncSchedulerClock { return this.options.clock ?? systemClock; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.clock.monotonicNow();
    this.startedWallAt = this.clock.wallNow();
    this.nextSlotAt = this.startedAt + WORMHOLESYSTEMS_SYNC_PERIOD_MS;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  status(): Record<string, unknown> {
    let eligibility: SyncSchedulerEligibility;
    try { eligibility = this.options.eligibility(); }
    catch { eligibility = { enabled: false, reason: "configuration_unavailable" }; }
    const nextOpportunityAt = this.running ? this.slotWallTime(this.nextSlotAt) : null;
    return {
      running: this.running,
      enabled: this.running && eligibility.enabled,
      blocked_reason: this.running ? eligibility.enabled ? null : eligibility.reason ?? "not_eligible" : "scheduler_stopped",
      map_id: eligibility.mapId ?? null,
      cadence_ms: WORMHOLESYSTEMS_SYNC_PERIOD_MS,
      next_opportunity_at: nextOpportunityAt,
      in_progress: this.active,
      last_attempted_slot_at: this.lastAttemptedSlotAt,
      last_completed_slot_at: this.lastCompletedSlotAt,
      last_outcome: this.lastOutcome,
      last_skip_reason: this.lastSkipReason,
      coordination: { mode: "single_process", scale_out_supported: false },
    };
  }

  private slotWallTime(monotonicAt: number): string {
    return new Date(this.startedWallAt + (monotonicAt - this.startedAt)).toISOString();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = Math.max(0, this.nextSlotAt - this.clock.monotonicNow());
    this.timer = this.clock.setTimeout(() => this.onSlot(), delay);
    this.timer.unref?.();
  }

  private onSlot(): void {
    this.timer = undefined;
    if (!this.running) return;
    const now = this.clock.monotonicNow();
    if (now < this.nextSlotAt) {
      this.scheduleNext();
      return;
    }
    const slotAt = this.slotWallTime(this.nextSlotAt);
    const missed = now - this.nextSlotAt > WORMHOLESYSTEMS_SYNC_LATE_GRACE_MS;
    this.nextSlotAt += WORMHOLESYSTEMS_SYNC_PERIOD_MS;
    // Skip any boundaries missed while the event loop was blocked. Never queue catch-up work.
    while (this.nextSlotAt <= now) {
      this.nextSlotAt += WORMHOLESYSTEMS_SYNC_PERIOD_MS;
    }
    this.scheduleNext();

    if (missed) {
      this.lastOutcome = "skipped";
      this.lastSkipReason = "missed_slot";
      this.emit({ event: "wormholesystems_auto_sync_slot_skipped", slot_at: slotAt, reason: "missed_slot" });
      return;
    }

    if (this.active || this.options.occupied()) {
      this.lastOutcome = "skipped";
      this.lastSkipReason = "busy";
      this.emit({ event: "wormholesystems_auto_sync_slot_skipped", slot_at: slotAt, reason: "busy" });
      return;
    }
    let eligible: SyncSchedulerEligibility;
    try { eligible = this.options.eligibility(); }
    catch { eligible = { enabled: false, reason: "configuration_unavailable" }; }
    if (!eligible.enabled || !eligible.mapId) {
      const reason = eligible.reason ?? "not_eligible";
      this.lastOutcome = "blocked";
      this.lastSkipReason = reason;
      this.emit({ event: "wormholesystems_auto_sync_slot_skipped", slot_at: slotAt, reason });
      return;
    }

    this.active = true;
    this.lastAttemptedSlotAt = slotAt;
    this.lastSkipReason = null;
    const startedAt = this.clock.monotonicNow();
    this.emit({ event: "wormholesystems_auto_sync_started", slot_at: slotAt, map_id: eligible.mapId });
    let task: Promise<string>;
    try { task = this.options.run(eligible.mapId, slotAt); }
    catch { task = Promise.reject(new Error("automatic sync failed")); }
    void Promise.resolve(task).then(outcome => {
      this.lastOutcome = outcome;
      if (outcome === "complete") this.lastCompletedSlotAt = slotAt;
      this.emit({ event: "wormholesystems_auto_sync_finished", slot_at: slotAt, map_id: eligible.mapId,
        outcome, duration_ms: Math.max(0, this.clock.monotonicNow() - startedAt) });
    }).catch(() => {
      this.lastOutcome = "failed";
      this.emit({ event: "wormholesystems_auto_sync_finished", slot_at: slotAt, map_id: eligible.mapId,
        outcome: "failed", duration_ms: Math.max(0, this.clock.monotonicNow() - startedAt) });
    }).finally(() => { this.active = false; });
  }

  private emit(event: Record<string, unknown>): void {
    try { (this.options.log ?? (value => console.log(JSON.stringify(value))))({ ...event, timestamp: new Date(this.clock.wallNow()).toISOString() }); }
    catch { /* Logging must not affect scheduler progress. */ }
  }
}
