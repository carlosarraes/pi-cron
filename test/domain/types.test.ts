import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, makeJobId } from "../../src/domain/types.js";
import { FakeClock } from "../helpers/fakes.js";

describe("domain defaults", () => {
  it("uses the approved balanced limits", () => {
    expect(DEFAULT_LIMITS).toEqual({
      expiresAfterMs: 7 * 24 * 60 * 60 * 1000,
      maxConsecutiveFailures: 3,
      isolatedTimeoutMs: 30 * 60 * 1000,
      minRecurringMs: 60 * 1000,
      maxJobs: 50,
    });
  });

  it("creates stable eight-character lowercase hex IDs", () => {
    expect(makeJobId(() => "A1B2C3D4E5F6")).toBe("a1b2c3d4");
  });
});

describe("FakeClock", () => {
  it("runs due timers deterministically and allows timers to be cleared", () => {
    const clock = new FakeClock(new Date("2026-07-14T12:00:00.000Z"));
    const due = vi.fn();
    const cleared = vi.fn();

    clock.setTimeout(due, 100);
    const clearedHandle = clock.setTimeout(cleared, 50);
    clock.clearTimeout(clearedHandle);

    clock.advanceBy(99);
    expect(clock.now().toISOString()).toBe("2026-07-14T12:00:00.099Z");
    expect(due).not.toHaveBeenCalled();
    expect(clock.pendingTimerCount()).toBe(1);

    clock.advanceBy(1);
    expect(due).toHaveBeenCalledOnce();
    expect(cleared).not.toHaveBeenCalled();
    expect(clock.pendingTimerCount()).toBe(0);
  });
});
