import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  nextOccurrence,
  parseDuration,
  resolveSchedule,
  ScheduleError,
} from "../../src/domain/schedule.js";

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
  ])("parses %s", (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  it.each([
    "",
    "0m",
    "1.5h",
    "1 hour",
    "-2m",
    "1w",
  ])("rejects invalid duration %j", (value) => {
    expect(() => parseDuration(value)).toThrowError(
      new ScheduleError(`Invalid duration '${value}'. Use 30m, 2h, or 1d.`),
    );
  });

  it.each([
    `${"9".repeat(400)}s`,
    "9007199254741d",
  ])("rejects overflowing duration %j", (value) => {
    expect(() => parseDuration(value)).toThrowError(ScheduleError);
  });
});

describe("resolveSchedule", () => {
  const now = new Date("2026-07-14T12:00:00.000Z");

  it("anchors intervals to creation time", () => {
    expect(resolveSchedule({ kind: "interval", value: "2h" }, now)).toEqual({
      kind: "interval",
      intervalMs: 7_200_000,
      anchorAt: now.toISOString(),
    });
  });

  it("enforces the recurring one-minute floor", () => {
    expect(() =>
      resolveSchedule({ kind: "interval", value: "30s" }, now),
    ).toThrowError(/at least 1m/);
  });

  it("allows an explicitly unsafe bounded interval", () => {
    expect(
      resolveSchedule({ kind: "interval", value: "30s" }, now, true),
    ).toEqual({
      kind: "interval",
      intervalMs: 30_000,
      anchorAt: now.toISOString(),
    });
  });

  it("resolves relative and absolute one-shots", () => {
    expect(resolveSchedule({ kind: "in", value: "20m" }, now)).toEqual({
      kind: "once",
      at: "2026-07-14T12:20:00.000Z",
      original: "20m",
    });
    expect(
      resolveSchedule({ kind: "at", value: "2026-07-15T09:00:00.000Z" }, now),
    ).toEqual({
      kind: "once",
      at: "2026-07-15T09:00:00.000Z",
      original: "2026-07-15T09:00:00.000Z",
    });
  });

  it("rejects invalid and expired absolute one-shots", () => {
    expect(() =>
      resolveSchedule({ kind: "at", value: "tomorrowish" }, now),
    ).toThrowError(/Invalid date/);
    expect(() =>
      resolveSchedule({ kind: "at", value: now.toISOString() }, now),
    ).toThrowError(/future/);
  });

  it("gives adaptive schedules a bounded first wake", () => {
    expect(resolveSchedule({ kind: "adaptive" }, now)).toEqual({
      kind: "adaptive",
      nextWakeAt: "2026-07-14T12:01:00.000Z",
      fallbackUsed: false,
    });
  });

  it("stores strict cron with the selected timezone", () => {
    expect(
      resolveSchedule(
        { kind: "cron", value: "0 9 * * 1-5" },
        now,
        false,
        "America/Sao_Paulo",
      ),
    ).toEqual({
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "America/Sao_Paulo",
    });
  });

  it("rejects non-IANA timezones", () => {
    expect(() =>
      resolveSchedule(
        { kind: "cron", value: "0 9 * * *" },
        now,
        false,
        "Mars/Olympus_Mons",
      ),
    ).toThrowError(/timezone/);
  });

  it.each([
    "0 9 * *",
    "0 0 9 * * *",
    "0 9 L * *",
    "0 9 * JAN *",
    "0 9 ? * *",
    "0 9 * * 1#2",
  ])("rejects nonstandard cron expression %j", (expression) => {
    expect(() =>
      resolveSchedule({ kind: "cron", value: expression }, now, false, "UTC"),
    ).toThrowError(/standard five-field cron/);
  });
});

describe("nextOccurrence", () => {
  it("keeps a two-hour interval anchored after a delayed dispatch", () => {
    const schedule = {
      kind: "interval",
      intervalMs: 7_200_000,
      anchorAt: "2026-07-14T12:00:00.000Z",
    } as const;
    expect(
      nextOccurrence(
        schedule,
        new Date("2026-07-14T16:31:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-07-14T18:00:00.000Z");
  });

  it("uses five-part cron in the stored IANA timezone", () => {
    const schedule = {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "America/Sao_Paulo",
    } as const;
    expect(
      nextOccurrence(
        schedule,
        new Date("2026-07-14T12:01:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-07-15T12:00:00.000Z");
  });

  it("finds leap-day occurrences", () => {
    const schedule = {
      kind: "cron",
      expression: "0 0 29 2 *",
      timezone: "UTC",
    } as const;
    expect(
      nextOccurrence(
        schedule,
        new Date("2025-03-01T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });

  it("handles DST spring-forward and fall-back in local wall time", () => {
    expect(
      nextOccurrence(
        {
          kind: "cron",
          expression: "30 2 * * *",
          timezone: "America/New_York",
        },
        new Date("2026-03-07T08:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-03-08T07:30:00.000Z");
    expect(
      nextOccurrence(
        {
          kind: "cron",
          expression: "30 1 * * *",
          timezone: "America/New_York",
        },
        new Date("2026-11-01T04:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  it("uses Vixie OR semantics for day-of-month and day-of-week", () => {
    const schedule = {
      kind: "cron",
      expression: "0 9 15 * 1",
      timezone: "UTC",
    } as const;
    expect(
      nextOccurrence(
        schedule,
        new Date("2026-07-14T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-07-15T09:00:00.000Z");
  });

  it("returns only unexpired one-shot and adaptive wakes", () => {
    const after = new Date("2026-07-14T12:00:00.000Z");
    expect(
      nextOccurrence(
        { kind: "once", at: "2026-07-14T12:01:00.000Z", original: "1m" },
        after,
      )?.toISOString(),
    ).toBe("2026-07-14T12:01:00.000Z");
    expect(
      nextOccurrence(
        { kind: "once", at: "2026-07-14T11:59:00.000Z", original: "1m" },
        after,
      ),
    ).toBeNull();
    expect(
      nextOccurrence(
        {
          kind: "adaptive",
          nextWakeAt: "2026-07-14T12:01:00.000Z",
          fallbackUsed: false,
        },
        after,
      )?.toISOString(),
    ).toBe("2026-07-14T12:01:00.000Z");
    expect(
      nextOccurrence(
        {
          kind: "adaptive",
          nextWakeAt: "2026-07-14T11:59:00.000Z",
          fallbackUsed: true,
        },
        after,
      ),
    ).toBeNull();
  });

  it("calculates fixed maintenance cadence and leaves adaptive cadence unscheduled", () => {
    const after = new Date("2026-07-14T12:04:00.000Z");
    expect(
      nextOccurrence(
        {
          kind: "maintenance",
          cadence: {
            intervalMs: 300_000,
            anchorAt: "2026-07-14T12:00:00.000Z",
          },
        },
        after,
      )?.toISOString(),
    ).toBe("2026-07-14T12:05:00.000Z");
    expect(
      nextOccurrence({ kind: "maintenance", cadence: "adaptive" }, after),
    ).toBeNull();
  });
});

describe("describeSchedule", () => {
  it.each([
    [
      {
        kind: "interval",
        intervalMs: 7_200_000,
        anchorAt: "2026-07-14T12:00:00.000Z",
      },
      "every 2h",
    ],
    [
      { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      "0 9 * * * (UTC)",
    ],
    [
      { kind: "once", at: "2026-07-15T09:00:00.000Z", original: "tomorrow" },
      "once at 2026-07-15T09:00:00.000Z",
    ],
    [
      {
        kind: "adaptive",
        nextWakeAt: "2026-07-14T12:01:00.000Z",
        fallbackUsed: false,
      },
      "adaptive (next 2026-07-14T12:01:00.000Z)",
    ],
    [{ kind: "maintenance", cadence: "adaptive" }, "maintenance (adaptive)"],
    [
      {
        kind: "maintenance",
        cadence: { intervalMs: 900_000, anchorAt: "2026-07-14T12:00:00.000Z" },
      },
      "maintenance every 15m",
    ],
  ] as const)("describes a schedule deterministically", (schedule, expected) => {
    expect(describeSchedule(schedule)).toBe(expected);
  });
});
