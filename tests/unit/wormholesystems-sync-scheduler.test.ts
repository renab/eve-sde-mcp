import { describe, expect, it } from "vitest";
import { WORMHOLESYSTEMS_SYNC_LATE_GRACE_MS, WORMHOLESYSTEMS_SYNC_PERIOD_MS, WormholeSystemsSyncScheduler, type SyncSchedulerClock } from "../../src/wormholesystems-sync-scheduler.js";
import { automaticSyncOutcome } from "../../src/wormholesystems.js";

class FakeClock implements SyncSchedulerClock {
  private current = 0;
  private readonly epoch = Date.parse("2026-10-18T12:00:00.000Z");
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void; unref(): void }>();
  monotonicNow(): number { return this.current; }
  wallNow(): number { return this.epoch + this.current; }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = ++this.nextId;
    const timer = { at: this.current + delayMs, callback, unref() {} };
    this.timers.set(id, timer);
    return Object.assign(timer, { id }) as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.timers.delete((timer as any).id); }
  async fireNextEarly(ms: number): Promise<void> {
    const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
    this.current = next[1].at - ms;
    this.timers.delete(next[0]);
    next[1].callback();
    await this.flushMicrotasks();
  }
  async elapseWithoutProcessing(ms: number): Promise<void> { this.current += ms; await this.flushMicrotasks(); }
  async processDueTimers(): Promise<void> {
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > this.current) break;
      this.timers.delete(next[0]);
      next[1].callback();
      await this.flushMicrotasks();
    }
  }
  async advanceBy(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.current = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await this.flushMicrotasks();
    }
    this.current = target;
    await this.flushMicrotasks();
  }
  async flushMicrotasks(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
}

describe("WormholeSystems automatic sync scheduler", () => {
  it("waits five minutes, follows fixed-rate boundaries and resets its clock after stop/restart", async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({
      clock, eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => false,
      run: async (_map, slot) => { runs.push(slot); return "complete"; }, log: () => {},
    });
    scheduler.start();
    expect(runs).toEqual([]);
    expect(scheduler.status()).toMatchObject({ enabled: true, cadence_ms: WORMHOLESYSTEMS_SYNC_PERIOD_MS,
      next_opportunity_at: "2026-10-18T12:05:00.000Z", last_attempted_slot_at: null });
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS - 1);
    expect(runs).toEqual([]);
    await clock.advanceBy(1);
    expect(runs).toEqual(["2026-10-18T12:05:00.000Z"]);
    expect(scheduler.status()).toMatchObject({ last_completed_slot_at: "2026-10-18T12:05:00.000Z", last_outcome: "complete" });

    scheduler.stop();
    await clock.advanceBy(60 * WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    scheduler.start();
    expect(scheduler.status().next_opportunity_at).toBe("2026-10-18T17:10:00.000Z");
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS - 1);
    expect(runs).toHaveLength(1);
    await clock.advanceBy(1);
    expect(runs).toHaveLength(2);
    scheduler.stop();
  });

  it("skips occupied and missed slots without overlap or catch-up work", async () => {
    const clock = new FakeClock();
    let occupied = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({
      clock, eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => occupied,
      run: async (_map, slot) => { runs.push(slot); if (runs.length === 1) await held; return "complete"; }, log: () => {},
    });
    scheduler.start();
    occupied = true;
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(scheduler.status()).toMatchObject({ last_outcome: "skipped", last_skip_reason: "busy" });
    occupied = false;
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(runs).toEqual(["2026-10-18T12:10:00.000Z"]);
    await clock.advanceBy(2 * WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(runs).toHaveLength(1);
    expect(scheduler.status()).toMatchObject({ in_progress: true, last_outcome: "skipped", last_skip_reason: "busy" });
    release();
    await clock.flushMicrotasks();
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(runs).toEqual(["2026-10-18T12:10:00.000Z", "2026-10-18T12:25:00.000Z"]);
    scheduler.stop();
  });

  it("re-reads eligibility and selected-map identity on each opportunity", async () => {
    const clock = new FakeClock();
    let selectedMap: string | undefined;
    let enabled = false;
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({
      clock, eligibility: () => enabled ? { enabled: true, mapId: selectedMap } : { enabled: false, mapId: selectedMap, reason: "source_sync_disabled" },
      occupied: () => false, run: async map => { runs.push(map); return "complete"; }, log: () => {},
    });
    scheduler.start();
    selectedMap = "new-map";
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(runs).toEqual([]);
    expect(scheduler.status()).toMatchObject({ enabled: false, blocked_reason: "source_sync_disabled" });
    enabled = true;
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(runs).toEqual(["new-map"]);
    scheduler.stop();
  });

  it("skips overdue timer boundaries instead of dispatching a stale opportunity", async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({
      clock, eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => false,
      run: async (_map, slot) => { runs.push(slot); return "complete"; }, log: () => {},
    });
    scheduler.start();
    await clock.elapseWithoutProcessing(3 * WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    await clock.processDueTimers();
    expect(runs).toEqual([]);
    expect(scheduler.status()).toMatchObject({ last_outcome: "skipped", last_skip_reason: "missed_slot",
      next_opportunity_at: "2026-10-18T12:20:00.000Z" });
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(runs).toEqual(["2026-10-18T12:20:00.000Z"]);
    scheduler.stop();
  });

  it("waits when a timer fires early rather than dispatching ahead of its slot", async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({ clock,
      eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => false,
      run: async (_map, slot) => { runs.push(slot); return "complete"; }, log: () => {},
    });
    scheduler.start();
    await clock.fireNextEarly(1);
    expect(runs).toEqual([]);
    expect(scheduler.status()).toMatchObject({ next_opportunity_at: "2026-10-18T12:05:00.000Z", last_outcome: null });
    await clock.advanceBy(1);
    expect(runs).toEqual(["2026-10-18T12:05:00.000Z"]);
    scheduler.stop();
  });

  it("dispatches a callback late by a millisecond on its original slot without shifting cadence", async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({ clock,
      eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => false,
      run: async (_map, slot) => { runs.push(slot); return "complete"; }, log: () => {},
    });
    scheduler.start();
    await clock.elapseWithoutProcessing(WORMHOLESYSTEMS_SYNC_PERIOD_MS + 1);
    await clock.processDueTimers();
    expect(runs).toEqual(["2026-10-18T12:05:00.000Z"]);
    expect(scheduler.status()).toMatchObject({ last_outcome: "complete", last_skip_reason: null,
      next_opportunity_at: "2026-10-18T12:10:00.000Z" });
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS - 1);
    expect(runs).toEqual(["2026-10-18T12:05:00.000Z", "2026-10-18T12:10:00.000Z"]);
    scheduler.stop();
  });

  it("skips a genuinely missed slot even before the next five-minute boundary", async () => {
    const clock = new FakeClock();
    const runs: string[] = [];
    const scheduler = new WormholeSystemsSyncScheduler({ clock,
      eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => false,
      run: async (_map, slot) => { runs.push(slot); return "complete"; }, log: () => {},
    });
    scheduler.start();
    await clock.elapseWithoutProcessing(WORMHOLESYSTEMS_SYNC_PERIOD_MS + WORMHOLESYSTEMS_SYNC_LATE_GRACE_MS + 1);
    await clock.processDueTimers();
    expect(runs).toEqual([]);
    expect(scheduler.status()).toMatchObject({ last_skip_reason: "missed_slot",
      next_opportunity_at: "2026-10-18T12:10:00.000Z" });
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS - WORMHOLESYSTEMS_SYNC_LATE_GRACE_MS - 1);
    expect(runs).toEqual(["2026-10-18T12:10:00.000Z"]);
    scheduler.stop();
  });

  it("classifies validated snapshots by actual topology write outcome", () => {
    const outcome = (topology_sync?: Record<string, unknown>) => automaticSyncOutcome({ status: "snapshot_validated", topology_sync });
    expect(outcome({ status: "succeeded", accepted: true })).toBe("complete");
    expect(outcome({ status: "blocked", attempted: false })).toBe("blocked");
    expect(outcome({ status: "not_accepted", accepted: false })).toBe("rejected");
    expect(outcome({ status: "applied_with_conflicts", partial: true })).toBe("partial");
    expect(outcome({ status: "indeterminate", indeterminate: true })).toBe("indeterminate");
    expect(outcome({ status: "failed" })).toBe("failed");
    expect(outcome({ status: "acknowledged_result_incomplete" })).toBe("incomplete");
    expect(outcome()).toBe("incomplete");
  });

  it("does not mark blocked or partial attempts as completed writes", async () => {
    const clock = new FakeClock();
    const logs: Array<Record<string, unknown>> = [];
    let outcome = "blocked";
    const scheduler = new WormholeSystemsSyncScheduler({ clock,
      eligibility: () => ({ enabled: true, mapId: "selected-map" }), occupied: () => false,
      run: async () => outcome, log: event => logs.push(event),
    });
    scheduler.start();
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(scheduler.status()).toMatchObject({ last_outcome: "blocked", last_completed_slot_at: null });
    expect(logs.at(-1)).toMatchObject({ event: "wormholesystems_auto_sync_finished", outcome: "blocked" });
    outcome = "partial";
    await clock.advanceBy(WORMHOLESYSTEMS_SYNC_PERIOD_MS);
    expect(scheduler.status()).toMatchObject({ last_outcome: "partial", last_completed_slot_at: null });
    scheduler.stop();
  });
});
