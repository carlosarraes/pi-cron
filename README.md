# pi-cron

Session-scoped scheduled prompts for Pi: fixed intervals, five-field cron, one-shots, adaptive loops, and isolated runs.

`pi-cron` runs only while the owning Pi session is open. Jobs are stored in the session branch, survive resume/reload, and follow forks safely; it is not an offline daemon.

## Install

```bash
pi install git:github.com/carlosarraes/pi-cron
```

Update or remove it with:

```bash
pi update --extensions
pi remove git:github.com/carlosarraes/pi-cron
```

## Quick start

The first duration token creates a fixed interval. Everything after it, including newlines, is preserved as the prompt:

```text
/cron 20m check the build
/cron 2h Write a release summary
using the current branch state.
```

Other non-empty free text creates an adaptive job:

```text
/cron tend this PR until it is ready
```

Strict creation forms are useful in scripts and precise workflows:

```text
/cron add --every 90m --prompt "check CI"
/cron add --cron "3 9 * * 1-5" --prompt "weekday brief"
/cron add --in 45m --prompt "check the build"
/cron add --at "2026-07-15 09:00" --prompt "prepare release"
/cron add --adaptive --prompt "tend this PR"
```

A loaded skill or prompt template can be scheduled by name:

```text
/cron 20m /review-pr 1234
/cron add --every 1h --prompt "/project-report concise"
```

Only currently loaded skills and prompt templates are schedulable. Built-in interactive commands and arbitrary extension commands are rejected.

## Guided creation

Run `/cron add` without flags for the five-step guided flow:

1. **Schedule** — presets, custom intervals, cron, one-shot, or adaptive.
2. **Prompt** — multiline text.
3. **Execution** — main session or isolated model/resources.
4. **Limits** — expiry, run cap, token budget, and isolated timeout.
5. **Review** — exact next occurrence before the approval preview.

Back navigation retains entered values. Cancelling mutates nothing. Guided creation requires TUI or RPC mode; JSON/print users should use strict `/cron add` flags.

## Schedule reference

### Fixed intervals

```text
/cron add --every 5m --prompt "check status"
/cron add --every 2h --prompt "summarize progress"
/cron add --every 1d --prompt "daily review"
```

Intervals stay anchored to their creation time. A delayed run does not shift future cadence.

### Cron

Cron schedules use exactly five standard fields:

```text
minute hour day-of-month month day-of-week
```

Example:

```text
/cron add --cron "0 9 * * 1-5" --prompt "weekday brief"
```

The system IANA timezone is captured at creation. Day-of-month and day-of-week use traditional Vixie OR behavior. There is no jitter, seconds field, or non-standard `L`, `W`, `?`, or `#` syntax.

### One-shots

```text
/cron add --in 2m --prompt "Reply with CRON_ONCE_OK"
/cron add --at "2026-07-15T16:00:00Z" --prompt "prepare release"
```

A one-shot fires at most once. If its time passes while Pi is not running, it is classified as **missed** on resume instead of firing late.

### Adaptive

```text
/cron add --adaptive --prompt "monitor this PR and decide when to check again"
```

During each adaptive run the agent must call `cron_wakeup` with either a delay from `1m` through `1h`, or `stop: true`, plus a reason. One omission gets a 20-minute fallback; a second consecutive omission pauses the job.

## Execution modes

### Main session

Main mode is the default:

```text
/cron add --every 30m --main --prompt "check current progress"
```

It inherits the session's model, effort, tools, skills, extensions, project context, and credentials at fire time. Exactly one follow-up user prompt is sent for each dispatch.

### Isolated

```text
/cron add --every 1h --prompt "audit the repository" \
  --isolated openai/gpt-5 --effort high \
  --tools read,grep --skills review --extensions safe-extension \
  --timeout 20m
```

Isolated mode uses a fresh in-memory `AgentSession`, pins the approved model and effort, and loads only approved tools, skills, and extensions. It does not wake the parent by default. Add `--notify` to send one parent follow-up when the run finishes.

Model names may be exact `provider/id` values or unique fuzzy matches. Unsupported effort levels and missing approved resources fail safely.

## Safety and limits

- Creation and privilege-increasing edits require interactive approval.
- Default expiry is seven days.
- Three consecutive technical failures pause a job.
- Normal recurring cadence is at least one minute.
- Development-only sub-minute intervals require both `--unsafe-seconds` and `--max-runs`.
- Optional `--max-runs` and `--budget` caps stop further dispatches.
- Scheduled runs cannot recursively create cron jobs. Adaptive wakeup/self-stop is the only scheduling mutation allowed during a scheduled execution.
- All jobs share global cron concurrency of one.
- If Pi is busy, repeated occurrences coalesce into one pending run. Pending jobs drain oldest-first without catch-up bursts.
- A per-session lease under Pi's agent directory prevents two Pi processes from scheduling the same session. The non-owner remains read-only.
- Shutdown clears timers, aborts isolated work, checkpoints metrics, releases the lease, and clears footer state.

Approval previews show the full prompt or maintenance source, schedule and exact next run, timezone, execution environment, resources, notification behavior, expiry/caps, timeout, failure limit, credentials warning, and configuration fingerprint.

## Maintenance prompt

Create an adaptive maintenance loop:

```text
/cron loop
```

Or a fixed maintenance cadence:

```text
/cron loop 15m
```

Maintenance content is resolved at fire time in this order:

1. trusted project file: `.pi/cron.md`
2. global file: `~/.pi/agent/cron.md`
3. built-in bounded maintenance prompt

Files are capped at 25,000 bytes. Project-local maintenance is ignored when the project is not trusted.

## Management

Bare `/cron` opens the dense manager in TUI mode. It supports selection, search, command mode, add, pause/resume, run now, edit, and confirmed deletion. The footer shows the active count and nearest due job.

Text commands work in every mode:

```text
/cron list
/cron show <id-or-name>
/cron pause <id-or-name>
/cron resume <id-or-name>
/cron edit <id-or-name> --every 2h
/cron run <id-or-name>
/cron delete <id-or-name>
/cron stop --all
```

Selectors accept an exact ID, exact case-insensitive name, or an unambiguous ID/name prefix.

The agent-facing tools are `cron_create`, `cron_list`, `cron_update`, `cron_delete`, `cron_run`, and `cron_wakeup`.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

Load the working tree directly in Pi:

```bash
pi -e ./src/index.ts
```

## License

MIT — see [LICENSE](LICENSE).
