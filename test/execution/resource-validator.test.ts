import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  DefaultResourceLoader,
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionMode, Schedule } from "../../src/domain/types.js";
import { validateActivationResources } from "../../src/execution/resource-validator.js";
import { FORBIDDEN_ISOLATED_CRON_TOOLS } from "../../src/execution/tool-policy.js";

const schedule: Schedule = {
  kind: "interval",
  intervalMs: 60_000,
  anchorAt: "2026-07-15T10:00:00.000Z",
};
const isolated: ExecutionMode = {
  kind: "isolated",
  model: "openai/model-a",
  effort: "medium",
  tools: ["read"],
  skills: ["review"],
  extensions: ["safe-ext"],
  notify: false,
  timeoutMs: 60_000,
};

function setup(
  overrides: {
    commands?: Array<{ name: string; source: "skill" | "prompt" }>;
    tools?: string[];
    models?: Model<Api>[];
    skills?: string[];
    skillErrors?: Array<{ path: string; error: string }>;
    extensions?: string[];
    errors?: Array<{ path: string; error: string }>;
  } = {},
) {
  const commands = overrides.commands ?? [{ name: "review", source: "skill" }];
  const tools = overrides.tools ?? ["read"];
  const models = overrides.models ?? [
    {
      provider: "openai",
      id: "model-a",
      name: "Model A",
      reasoning: true,
    } as Model<Api>,
  ];
  const loader = {
    reload: vi.fn(async () => undefined),
    getSkills: () => ({
      skills: (overrides.skills ?? ["review"]).map((name) => ({ name })),
      diagnostics: (overrides.skillErrors ?? []).map(({ path, error }) => ({
        type: "error" as const,
        path,
        message: error,
      })),
    }),
    getExtensions: () => ({
      extensions: (overrides.extensions ?? ["/tmp/safe-ext.ts"]).map(
        (path) => ({ path }),
      ),
      errors: overrides.errors ?? [],
    }),
  } as unknown as Pick<
    DefaultResourceLoader,
    "reload" | "getSkills" | "getExtensions"
  >;
  return {
    pi: {
      getCommands: () => commands,
      getAllTools: () => tools.map((name) => ({ name })),
    } as unknown as Pick<ExtensionAPI, "getCommands" | "getAllTools">,
    modelRegistry: { getAvailable: () => models } as Pick<
      ModelRegistry,
      "getAvailable"
    >,
    resourceLoaderFactory: () => loader,
    loader,
  };
}

describe("validateActivationResources", () => {
  it("accepts exact prompt and isolated resource matches", async () => {
    const configured = setup();
    await expect(
      validateActivationResources({
        ...configured,
        cwd: "/project",
        agentDir: "/agent",
        prompt: { kind: "command", name: "review", args: "", source: "skill" },
        schedule,
        execution: isolated,
      }),
    ).resolves.toBeUndefined();
    expect(configured.loader.reload).toHaveBeenCalledOnce();
  });

  it("rejects missing prompt, model, tools, skills, extensions, and loader errors", async () => {
    const base = {
      cwd: "/project",
      agentDir: "/agent",
      prompt: {
        kind: "command",
        name: "review",
        args: "",
        source: "skill",
      } as const,
      schedule,
      execution: isolated,
    };
    await expect(
      validateActivationResources({ ...base, ...setup({ commands: [] }) }),
    ).rejects.toThrow("Scheduled command unavailable");
    await expect(
      validateActivationResources({ ...base, ...setup({ models: [] }) }),
    ).rejects.toThrow("model unavailable");
    await expect(
      validateActivationResources({
        ...base,
        ...setup({
          models: [
            {
              provider: "openai",
              id: "model-a",
              name: "Model A",
              reasoning: false,
            } as Model<Api>,
          ],
        }),
      }),
    ).rejects.toThrow("Thinking effort");
    await expect(
      validateActivationResources({ ...base, ...setup({ tools: [] }) }),
    ).rejects.toThrow("tools unavailable");
    await expect(
      validateActivationResources({ ...base, ...setup({ skills: [] }) }),
    ).rejects.toThrow("skills unavailable");
    await expect(
      validateActivationResources({
        ...base,
        ...setup({
          skillErrors: [{ path: "/bad-skill", error: "skill boom" }],
        }),
      }),
    ).rejects.toThrow("Isolated skill loading failed: /bad-skill: skill boom");
    await expect(
      validateActivationResources({ ...base, ...setup({ extensions: [] }) }),
    ).rejects.toThrow("extensions unavailable");
    await expect(
      validateActivationResources({
        ...base,
        ...setup({ errors: [{ path: "/bad", error: "boom" }] }),
      }),
    ).rejects.toThrow("extension loading failed");
  });

  it("rejects every saved-definition mutation tool in isolated execution", async () => {
    for (const tool of FORBIDDEN_ISOLATED_CRON_TOOLS) {
      const configured = setup({ tools: [tool] });
      await expect(
        validateActivationResources({
          ...configured,
          cwd: "/project",
          agentDir: "/agent",
          prompt: { kind: "text", text: "hello" },
          schedule,
          execution: { ...isolated, tools: [tool], skills: [], extensions: [] },
        }),
      ).rejects.toThrow(`cannot mutate saved definitions: ${tool}`);
      expect(configured.loader.reload).not.toHaveBeenCalled();
    }
  });

  it("skips isolated resource loading for main execution", async () => {
    const configured = setup({ tools: [], models: [] });
    await expect(
      validateActivationResources({
        ...configured,
        cwd: "/project",
        agentDir: "/agent",
        prompt: { kind: "text", text: "hello" },
        schedule,
        execution: { kind: "main" },
      }),
    ).resolves.toBeUndefined();
    expect(configured.loader.reload).not.toHaveBeenCalled();
  });
});
