import { describe, expect, it } from "vitest";
import {
  assertSavedCatalog,
  MAX_SAVED_NAME_LENGTH,
  requiresSavedReapproval,
  type SavedCronDefinition,
  selectSavedDefinition,
  validateSavedCandidate,
} from "../../src/domain/saved.js";
import { DEFAULT_LIMITS } from "../../src/domain/types.js";

const NOW = "2026-07-14T12:00:00.000Z";

function definition(
  overrides: Partial<SavedCronDefinition> = {},
): SavedCronDefinition {
  return {
    version: 1,
    id: "abcd1234",
    name: "Daily report",
    prompt: { kind: "text", text: "Summarize progress" },
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    execution: { kind: "main" },
    overlap: "queue",
    unsafeSeconds: false,
    expiresAfterMs: DEFAULT_LIMITS.expiresAfterMs,
    createdAt: NOW,
    updatedAt: NOW,
    approval: { approvedAt: NOW, fingerprint: "approved" },
    ...overrides,
  };
}

describe("saved cron catalog validation", () => {
  it("accepts every strict schedule variant", () => {
    const schedules: SavedCronDefinition["schedule"][] = [
      { kind: "interval", intervalMs: 3_600_000 },
      { kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
      { kind: "once", timing: { kind: "relative", delayMs: 60_000 } },
      {
        kind: "once",
        timing: { kind: "absolute", at: "2026-07-15T12:00:00.000Z" },
      },
      { kind: "adaptive" },
      { kind: "maintenance", cadence: "adaptive" },
      { kind: "maintenance", cadence: { intervalMs: 3_600_000 } },
    ];
    const definitions = schedules.map((schedule, index) =>
      definition({
        id: `abcd123${index}`,
        name: `Job ${index}`,
        schedule,
      }),
    );

    expect(assertSavedCatalog({ version: 1, definitions })).toEqual({
      version: 1,
      definitions,
    });
  });

  it("rejects unknown fields and unsupported versions", () => {
    expect(() =>
      assertSavedCatalog({
        version: 1,
        definitions: [{ ...definition(), extra: true }],
      }),
    ).toThrow("Malformed saved cron catalog");
    expect(() => assertSavedCatalog({ version: 2, definitions: [] })).toThrow(
      "Unsupported saved cron catalog version: 2",
    );
    expect(() =>
      assertSavedCatalog({ version: 1, definitions: [], extra: true }),
    ).toThrow("Malformed saved cron catalog");
  });

  it("rejects duplicate IDs and case-insensitive names", () => {
    expect(() =>
      assertSavedCatalog({
        version: 1,
        definitions: [definition(), definition({ name: "Other" })],
      }),
    ).toThrow("Duplicate saved cron definition ID");
    expect(() =>
      assertSavedCatalog({
        version: 1,
        definitions: [
          definition(),
          definition({ id: "dcba4321", name: "DAILY REPORT" }),
        ],
      }),
    ).toThrow("Duplicate saved cron definition name");
  });

  it("accepts the maximum saved name length", () => {
    expect(() =>
      assertSavedCatalog({
        version: 1,
        definitions: [definition({ name: "x".repeat(MAX_SAVED_NAME_LENGTH) })],
      }),
    ).not.toThrow();
  });

  it("rejects invalid IDs, names, timestamps, counters, and excessive catalogs", () => {
    for (const invalid of [
      definition({ id: "ABC12345" }),
      definition({ name: "   " }),
      definition({ name: " leading" }),
      definition({ name: "trailing " }),
      definition({ name: "x".repeat(MAX_SAVED_NAME_LENGTH + 1) }),
      definition({ createdAt: "yesterday" }),
      definition({ expiresAfterMs: 1.5 }),
      definition({ maxRuns: 0 }),
      definition({ approval: { approvedAt: NOW, fingerprint: "" } }),
    ]) {
      expect(() =>
        assertSavedCatalog({ version: 1, definitions: [invalid] }),
      ).toThrow("Malformed saved cron catalog");
    }

    const definitions = Array.from(
      { length: DEFAULT_LIMITS.maxJobs + 1 },
      (_, index) =>
        definition({
          id: index.toString(36).padStart(8, "0"),
          name: `Job ${index}`,
        }),
    );
    expect(() => assertSavedCatalog({ version: 1, definitions })).toThrow(
      `Saved cron definitions are limited to ${DEFAULT_LIMITS.maxJobs}`,
    );
  });

  it("rejects semantically invalid stored schedules", () => {
    expect(() =>
      assertSavedCatalog({
        version: 1,
        definitions: [
          definition({
            schedule: { kind: "interval", intervalMs: 30_000 },
            unsafeSeconds: false,
            maxRuns: 2,
          }),
        ],
      }),
    ).toThrow("Sub-minute intervals require unsafeSeconds");
    expect(() =>
      assertSavedCatalog({
        version: 1,
        definitions: [
          definition({
            schedule: {
              kind: "cron",
              expression: "not a cron",
              timezone: "UTC",
            },
          }),
        ],
      }),
    ).toThrow("Invalid standard five-field cron expression");
  });

  it("enforces bounded sub-minute schedules", () => {
    expect(() =>
      validateSavedCandidate(
        definition({
          schedule: { kind: "interval", intervalMs: 30_000 },
          unsafeSeconds: false,
          maxRuns: 2,
        }),
        [],
      ),
    ).toThrow("Sub-minute intervals require unsafeSeconds");
    expect(() =>
      validateSavedCandidate(
        definition({
          schedule: { kind: "interval", intervalMs: 30_000 },
          unsafeSeconds: true,
        }),
        [],
      ),
    ).toThrow("Sub-minute intervals require maxRuns");
    expect(() =>
      validateSavedCandidate(
        definition({
          schedule: { kind: "interval", intervalMs: 30_000 },
          unsafeSeconds: true,
          maxRuns: 2,
        }),
        [],
      ),
    ).not.toThrow();
  });
});

describe("saved cron selection", () => {
  const definitions = [
    definition(),
    definition({ id: "abce5678", name: "Weekly report" }),
  ];

  it("selects exact IDs, exact names, and unambiguous prefixes", () => {
    expect(selectSavedDefinition(definitions, "abcd1234").id).toBe("abcd1234");
    expect(selectSavedDefinition(definitions, "DAILY REPORT").id).toBe(
      "abcd1234",
    );
    expect(selectSavedDefinition(definitions, "week").id).toBe("abce5678");
  });

  it("rejects empty, ambiguous, and missing selectors", () => {
    expect(() => selectSavedDefinition(definitions, " ")).toThrow(
      "Saved cron definition selector cannot be empty",
    );
    expect(() => selectSavedDefinition(definitions, "abc")).toThrow(
      "Ambiguous saved cron definition selector: abc",
    );
    expect(() => selectSavedDefinition(definitions, "missing")).toThrow(
      "Saved cron definition not found: missing",
    );
  });
});

describe("saved cron privilege comparison", () => {
  const before = definition({
    overlap: "skip",
    execution: {
      kind: "isolated",
      model: "provider/model",
      effort: "low",
      tools: ["read"],
      skills: [],
      extensions: [],
      notify: false,
      timeoutMs: 60_000,
    },
    maxRuns: 2,
    tokenBudget: 100,
  });

  it.each([
    [
      "prompt",
      definition({ ...before, prompt: { kind: "text", text: "Other" } }),
    ],
    [
      "faster schedule",
      definition({
        ...before,
        schedule: { kind: "interval", intervalMs: 60_000 },
      }),
    ],
    [
      "different cron schedule",
      definition({
        ...before,
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      }),
    ],
    [
      "longer expiry",
      definition({ ...before, expiresAfterMs: before.expiresAfterMs + 1 }),
    ],
    ["raised run limit", definition({ ...before, maxRuns: 3 })],
    ["removed token limit", definition({ ...before, tokenBudget: undefined })],
    [
      "added tool",
      definition({
        ...before,
        execution: {
          ...(before.execution as Extract<
            SavedCronDefinition["execution"],
            { kind: "isolated" }
          >),
          tools: ["read", "write"],
        },
      }),
    ],
    [
      "higher effort",
      definition({
        ...before,
        execution: {
          ...(before.execution as Extract<
            SavedCronDefinition["execution"],
            { kind: "isolated" }
          >),
          effort: "high",
        },
      }),
    ],
    [
      "longer timeout",
      definition({
        ...before,
        execution: {
          ...(before.execution as Extract<
            SavedCronDefinition["execution"],
            { kind: "isolated" }
          >),
          timeoutMs: 120_000,
        },
      }),
    ],
    [
      "notification",
      definition({
        ...before,
        execution: {
          ...(before.execution as Extract<
            SavedCronDefinition["execution"],
            { kind: "isolated" }
          >),
          notify: true,
        },
      }),
    ],
    ["main escalation", definition({ ...before, execution: { kind: "main" } })],
    ["queue overlap", definition({ ...before, overlap: "queue" })],
    ["unsafe seconds", definition({ ...before, unsafeSeconds: true })],
  ])("requires reapproval for %s", (_label, after) => {
    expect(requiresSavedReapproval(before, after)).toBe(true);
  });

  it("allows safe reductions without reapproval", () => {
    expect(
      requiresSavedReapproval(
        before,
        definition({
          ...before,
          expiresAfterMs: before.expiresAfterMs - 1,
          maxRuns: 1,
          tokenBudget: 50,
          execution: {
            ...(before.execution as Extract<
              SavedCronDefinition["execution"],
              { kind: "isolated" }
            >),
            effort: "off",
            timeoutMs: 30_000,
          },
        }),
      ),
    ).toBe(false);
  });
});
