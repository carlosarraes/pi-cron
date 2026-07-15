import type { Clock } from "../../src/domain/types.js";

interface FakeTimer {
  id: number;
  dueAt: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private currentMs: number;
  private nextTimerId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(now = new Date(0)) {
    this.currentMs = now.getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = {
      id: this.nextTimerId++,
      dueAt: this.currentMs + ms,
      fn,
    };
    this.timers.set(timer.id, timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  }

  advanceBy(ms: number): void {
    const targetMs = this.currentMs + ms;
    let timer = this.nextDueTimer(targetMs);

    while (timer) {
      this.currentMs = timer.dueAt;
      this.timers.delete(timer.id);
      timer.fn();
      timer = this.nextDueTimer(targetMs);
    }

    this.currentMs = targetMs;
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  private nextDueTimer(targetMs: number): FakeTimer | undefined {
    return [...this.timers.values()]
      .filter((timer) => timer.dueAt <= targetMs)
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
  }
}
