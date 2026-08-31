import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  DefaultResourceLoader,
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { CronJob, ExecutionMode, Schedule } from "../domain/types.js";
import { buildResourceLoader, resolveModel } from "./isolated-executor.js";

type IsolatedExecution = Extract<ExecutionMode, { kind: "isolated" }>;
type LoaderPort = Pick<
  DefaultResourceLoader,
  "reload" | "getSkills" | "getExtensions"
>;

export async function validateActivationResources(options: {
  pi: Pick<ExtensionAPI, "getCommands" | "getAllTools">;
  cwd: string;
  agentDir: string;
  modelRegistry: Pick<ModelRegistry, "getAvailable">;
  prompt: CronJob["prompt"];
  schedule: Schedule;
  execution: ExecutionMode;
  resourceLoaderFactory?: (options: {
    cwd: string;
    agentDir: string;
    approved: IsolatedExecution;
  }) => LoaderPort;
}): Promise<void> {
  if (options.prompt.kind === "command") {
    const prompt = options.prompt;
    const available = options.pi
      .getCommands()
      .some(
        (command) =>
          command.name === prompt.name && command.source === prompt.source,
      );
    if (!available) {
      throw new Error(`Scheduled command unavailable: /${prompt.name}`);
    }
  }

  if (options.execution.kind === "main") return;
  const execution = options.execution;
  const model = resolveModel(options.modelRegistry, execution.model);
  if (!getSupportedThinkingLevels(model).includes(execution.effort)) {
    throw new Error(
      `Thinking effort '${execution.effort}' is unavailable for ${model.provider}/${model.id}`,
    );
  }

  const availableTools = new Set(
    options.pi.getAllTools().map((tool) => tool.name),
  );
  const missingTools = execution.tools.filter(
    (tool) => !availableTools.has(tool),
  );
  if (missingTools.length > 0) {
    throw new Error(`Isolated tools unavailable: ${missingTools.join(", ")}`);
  }

  const loader = options.resourceLoaderFactory
    ? options.resourceLoaderFactory({
        cwd: options.cwd,
        agentDir: options.agentDir,
        approved: execution,
      })
    : buildResourceLoader({
        cwd: options.cwd,
        agentDir: options.agentDir,
        approved: execution,
      });
  await loader.reload();

  const skillsResult = loader.getSkills();
  const availableSkills = new Set(
    skillsResult.skills.map((skill) => skill.name),
  );
  const missingSkills = execution.skills.filter(
    (skill) => !availableSkills.has(skill),
  );
  if (missingSkills.length > 0) {
    throw new Error(`Isolated skills unavailable: ${missingSkills.join(", ")}`);
  }

  const extensionsResult = loader.getExtensions();
  if (extensionsResult.errors.length > 0) {
    const detail = extensionsResult.errors
      .map(({ path, error }) => `${path}: ${String(error)}`)
      .join("; ");
    throw new Error(`Isolated extension loading failed: ${detail}`);
  }
  const paths = extensionsResult.extensions.map((extension) => extension.path);
  const missingExtensions = execution.extensions.filter(
    (selector) => !paths.some((path) => path.includes(selector)),
  );
  if (missingExtensions.length > 0) {
    throw new Error(
      `Isolated extensions unavailable: ${missingExtensions.join(", ")}`,
    );
  }

  void options.schedule;
}
