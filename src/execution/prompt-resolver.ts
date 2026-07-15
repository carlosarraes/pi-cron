import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExtensionAPI,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { CronJob } from "../domain/types.js";

const MAX_PROMPT_BYTES = 25_000;

export const BUILTIN_MAINTENANCE_PROMPT = `Perform one bounded maintenance pass on the current project. Inspect existing context and choose one useful, low-risk task such as checking status, reviewing recent changes, or identifying the next concrete action. Do not create recurring work, modify credentials, publish changes, or perform destructive actions. Summarize what you checked and any recommended follow-up.`;

export interface PromptResolverOptions {
  pi: Pick<ExtensionAPI, "getCommands">;
  cwd: string;
  agentDir: string;
  isProjectTrusted: () => boolean;
}

export class PromptResolver {
  private readonly pi: Pick<ExtensionAPI, "getCommands">;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly isProjectTrusted: () => boolean;

  constructor(options: PromptResolverOptions) {
    this.pi = options.pi;
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.isProjectTrusted = options.isProjectTrusted;
  }

  async resolve(job: CronJob): Promise<string> {
    switch (job.prompt.kind) {
      case "text":
        return job.prompt.text;
      case "maintenance":
        return this.readMaintenancePrompt();
      case "command":
        return this.resolveCommand(job.prompt);
    }
  }

  private async resolveCommand(
    prompt: Extract<CronJob["prompt"], { kind: "command" }>,
  ): Promise<string> {
    const command = this.pi
      .getCommands()
      .find(
        (candidate) =>
          candidate.name === prompt.name && candidate.source === prompt.source,
      );
    if (!command) {
      throw new Error(`Scheduled command unavailable: /${prompt.name}`);
    }

    if (command.source === "skill") {
      const suffix = prompt.args.trim()
        ? ` with these arguments:\n${prompt.args}`
        : "";
      return `Invoke the loaded skill '${prompt.name}'${suffix}`;
    }
    if (command.source !== "prompt") {
      throw new Error(
        `Scheduled command /${prompt.name} is not a prompt template or skill`,
      );
    }

    const raw = await readBoundedFile(command.sourceInfo.path);
    const { body } = parseFrontmatter(raw);
    return substituteTemplateArguments(
      body,
      parseCommandArguments(prompt.args),
    );
  }

  private async readMaintenancePrompt(): Promise<string> {
    if (this.isProjectTrusted()) {
      const project = await readOptionalBoundedFile(
        join(this.cwd, ".pi", "cron.md"),
      );
      if (project !== undefined) return project;
    }
    const global = await readOptionalBoundedFile(
      join(this.agentDir, "cron.md"),
    );
    return global ?? BUILTIN_MAINTENANCE_PROMPT;
  }
}

async function readOptionalBoundedFile(
  path: string,
): Promise<string | undefined> {
  try {
    return await readBoundedFile(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readBoundedFile(path: string): Promise<string> {
  const content = await readFile(path);
  if (content.byteLength > MAX_PROMPT_BYTES) {
    throw new Error(
      `Scheduled prompt file exceeds ${MAX_PROMPT_BYTES} bytes: ${path}`,
    );
  }
  return content.toString("utf8");
}

export function parseCommandArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

export function substituteTemplateArguments(
  template: string,
  args: string[],
): string {
  const all = args.join(" ");
  return template.replace(
    /\$\{(\d+):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      defaultNumber: string | undefined,
      defaultValue: string | undefined,
      sliceStart: string | undefined,
      sliceLength: string | undefined,
      simple: string | undefined,
    ) => {
      if (defaultNumber) {
        return args[Number(defaultNumber) - 1] || defaultValue || "";
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        const selected = sliceLength
          ? args.slice(start, start + Number(sliceLength))
          : args.slice(start);
        return selected.join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return all;
      return args[Number(simple) - 1] ?? "";
    },
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
