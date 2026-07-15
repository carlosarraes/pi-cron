import { describe, expect, it } from "vitest";
import {
  CommandParseError,
  parseCronCommand,
} from "../../src/commands/parse.js";

describe("parseCronCommand", () => {
  it("opens the manager for an empty invocation", () => {
    expect(parseCronCommand(" \n\t")).toEqual({ kind: "manager" });
  });

  it("opens guided add when add has no arguments", () => {
    expect(parseCronCommand("add")).toEqual({ kind: "guided_add" });
  });

  it("preserves every byte after a shorthand duration", () => {
    const raw = "2h follow these steps:\n1. Check CI.\n2. Report.";
    expect(parseCronCommand(raw)).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "interval", value: "2h" },
        prompt: "follow these steps:\n1. Check CI.\n2. Report.",
      },
    });
  });

  it("treats prompt-only shorthand as adaptive", () => {
    expect(parseCronCommand("check CI and review comments")).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "adaptive" },
        prompt: "check CI and review comments",
      },
    });
  });

  it("parses maintenance forms", () => {
    expect(parseCronCommand("loop")).toEqual({
      kind: "maintenance",
      interval: undefined,
    });
    expect(parseCronCommand("loop 15m")).toEqual({
      kind: "maintenance",
      interval: "15m",
    });
  });

  it("rejects malformed maintenance intervals", () => {
    expect(() => parseCronCommand("loop tomorrow")).toThrowError(
      new CommandParseError("Usage: /cron loop [15m]"),
    );
  });

  it("parses every strict create field", () => {
    expect(
      parseCronCommand(
        'add --every 5m --prompt "check CI" --name nightly --isolated sonnet --effort high --notify --expires 2d --max-runs 5 --budget 2000 --timeout 10m --tools read,bash --skills "review, test" --extensions github,slack',
      ),
    ).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "interval", value: "5m" },
        prompt: "check CI",
        name: "nightly",
        execution: {
          kind: "isolated",
          model: "sonnet",
          effort: "high",
          notify: true,
          timeout: "10m",
          tools: ["read", "bash"],
          skills: ["review", "test"],
          extensions: ["github", "slack"],
        },
        expires: "2d",
        maxRuns: 5,
        tokenBudget: 2000,
      },
    });
  });

  it.each([
    ["--cron '0 9 * * *'", { kind: "cron", value: "0 9 * * *" }],
    ["--in 20m", { kind: "in", value: "20m" }],
    ["--at '2026-07-15 09:00'", { kind: "at", value: "2026-07-15 09:00" }],
    ["--adaptive", { kind: "adaptive" }],
  ])("parses the %s schedule", (flag, schedule) => {
    expect(parseCronCommand(`add ${flag} --prompt work`)).toEqual({
      kind: "create",
      input: { schedule, prompt: "work" },
    });
  });

  it("supports main and isolated execution without a model", () => {
    expect(parseCronCommand("add --adaptive --prompt work --main")).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "adaptive" },
        prompt: "work",
        execution: { kind: "main" },
      },
    });
    expect(
      parseCronCommand("add --adaptive --prompt work --isolated --notify"),
    ).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "adaptive" },
        prompt: "work",
        execution: { kind: "isolated", notify: true },
      },
    });
  });

  it("supports escaped quotes and backslashes in strict values", () => {
    expect(
      parseCronCommand(
        'add --adaptive --prompt "say \\"hello\\" at C:\\\\tmp"',
      ),
    ).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "adaptive" },
        prompt: 'say "hello" at C:\\tmp',
      },
    });
  });

  it("allows bounded unsafe sub-minute intervals", () => {
    expect(
      parseCronCommand(
        'add --every 30s --unsafe-seconds --max-runs 5 --prompt "smoke test"',
      ),
    ).toEqual({
      kind: "create",
      input: {
        schedule: { kind: "interval", value: "30s" },
        prompt: "smoke test",
        maxRuns: 5,
        unsafeSeconds: true,
      },
    });
  });

  it("rejects unsafe fixed shorthand", () => {
    expect(() => parseCronCommand("30s smoke test")).toThrowError(
      /at least 1m/,
    );
  });

  it("parses management commands", () => {
    expect(parseCronCommand("list")).toEqual({ kind: "list" });
    for (const kind of ["show", "pause", "resume", "run", "delete"] as const) {
      expect(parseCronCommand(`${kind} job-1`)).toEqual({
        kind,
        selector: "job-1",
      });
    }
    expect(parseCronCommand("stop --all")).toEqual({ kind: "stop_all" });
  });

  it("parses edit into a selector and partial draft", () => {
    expect(
      parseCronCommand(
        'edit nightly --cron "0 10 * * *" --prompt "new prompt" --isolated --effort low --budget 500',
      ),
    ).toEqual({
      kind: "edit",
      selector: "nightly",
      patch: {
        schedule: { kind: "cron", value: "0 10 * * *" },
        prompt: "new prompt",
        execution: { kind: "isolated", effort: "low" },
        tokenBudget: 500,
      },
    });
  });

  it.each([
    ["add --prompt work", /exactly one schedule/],
    ["add --every 5m --adaptive --prompt work", /exactly one schedule/],
    ["add --adaptive", /--prompt/],
    [
      "add --adaptive --prompt work --main --isolated",
      /either --main or --isolated/,
    ],
    ["add --adaptive --prompt work --effort high", /requires --isolated/],
    ["add --adaptive --prompt work --notify", /requires --isolated/],
    ["add --adaptive --prompt work --tools read", /requires --isolated/],
    ["add --every 30s --unsafe-seconds --prompt work", /requires --max-runs/],
    ["add --every 30s --max-runs 5 --prompt work", /at least 1m/],
    [
      `add --every 30s --unsafe-seconds --max-runs ${"9".repeat(400)} --prompt work`,
      /positive integer/,
    ],
    ["add --adaptive --prompt work --unknown value", /Unknown flag/],
    ["add --adaptive --prompt one --prompt two", /Duplicate flag/],
    ["add --adaptive --prompt", /requires a value/],
    ["add --adaptive --prompt 'unfinished", /Unclosed quote/],
    ["list extra", /Usage/],
    ["show", /Usage/],
    ["show one two", /Usage/],
    ['show ""', /Usage/],
    ["stop", /Usage/],
    ["stop job-1", /Usage/],
    ["edit job-1", /at least one field/],
    ['edit "" --prompt work', /Usage/],
  ])("rejects malformed input: %s", (raw, message) => {
    expect(() => parseCronCommand(raw)).toThrowError(message);
  });
});
