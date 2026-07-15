import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CronEvent, EventStore } from "../domain/types.js";

const CRON_EVENT_ENTRY = "pi-cron/event";

type EventAppender = Pick<ExtensionAPI, "appendEntry">;
type BranchReader = Pick<ExtensionContext["sessionManager"], "getBranch">;

export class PiEventStore implements EventStore {
  constructor(
    private readonly pi: EventAppender,
    private readonly sessionManager: BranchReader,
  ) {}

  load(): CronEvent[] {
    const events: CronEvent[] = [];

    for (const entry of this.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CRON_EVENT_ENTRY) {
        events.push(entry.data as CronEvent);
      }
    }

    return events;
  }

  append(event: CronEvent): void {
    this.pi.appendEntry(CRON_EVENT_ENTRY, event);
  }
}
