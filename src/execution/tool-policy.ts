export const FORBIDDEN_ISOLATED_CRON_TOOLS = [
  "cron_saved_create",
  "cron_saved_copy",
  "cron_saved_update",
  "cron_saved_delete",
  "cron_saved_start",
] as const;

const FORBIDDEN_TOOL_NAMES = new Set<string>(FORBIDDEN_ISOLATED_CRON_TOOLS);

export function assertIsolatedCronToolsAllowed(tools: readonly string[]): void {
  const forbidden = tools.filter((tool) => FORBIDDEN_TOOL_NAMES.has(tool));
  if (forbidden.length > 0) {
    throw new Error(
      `Isolated cron jobs cannot mutate saved definitions: ${forbidden.join(", ")}`,
    );
  }
}
