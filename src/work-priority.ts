import { AsyncLocalStorage } from "node:async_hooks";

const background = new AsyncLocalStorage<{ remaining: number; enabled:()=>boolean }>();
let foreground = 0;
let lastActivity = Date.now();
export class WarmDeferred extends Error {}
export function beginForeground(): () => void {
  foreground++;
  let finished = false;
  return () => { if (!finished) { finished = true; foreground--; lastActivity = Date.now(); } };
}
export function isIdle(graceMs = 5000): boolean { return foreground === 0 && Date.now() - lastActivity >= graceMs; }
export function isBackground(): boolean { return background.getStore() !== undefined; }
export function runBackground<T>(work: () => Promise<T>, enabled:()=>boolean = ()=>true): Promise<T> { return background.run({ remaining: 1, enabled }, work); }
/** Called immediately before each upstream attempt, including existing retries. */
export function claimUpstreamAttempt(): void {
  const budget = background.getStore();
  if (!budget) return;
  if (!budget.enabled()) throw new WarmDeferred("Subscription removed/disabled or scheduler stopped");
  if (!isIdle()) throw new WarmDeferred("Foreground work takes priority");
  if (budget.remaining <= 0) throw new WarmDeferred("Idle-pass upstream budget exhausted; remaining pages wait for another pass");
  budget.remaining--;
}
