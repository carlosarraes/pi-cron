import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const Effort = StringEnum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);
const Mode = StringEnum(["main", "isolated"] as const);
const Overlap = StringEnum(["queue", "skip"] as const);

const CreationFields = {
  name: Type.Optional(Type.String({ minLength: 1 })),
  prompt: Type.String({ minLength: 1 }),
  every: Type.Optional(Type.String()),
  cron: Type.Optional(Type.String()),
  in: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  adaptive: Type.Optional(Type.Boolean()),
  timezone: Type.Optional(Type.String()),
  mode: Type.Optional(Mode),
  overlap: Type.Optional(Overlap),
  model: Type.Optional(Type.String()),
  effort: Type.Optional(Effort),
  notify: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  extensions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  expires: Type.Optional(Type.String()),
  maxRuns: Type.Optional(Type.Integer({ minimum: 1 })),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
  unsafeSeconds: Type.Optional(Type.Boolean()),
};

export const CronCreateParams = Type.Object(CreationFields, {
  additionalProperties: false,
});

export const CronListParams = Type.Object({}, { additionalProperties: false });

const { prompt: _createPrompt, ...UpdateFields } = CreationFields;

export const CronUpdateParams = Type.Object(
  {
    selector: Type.String({ minLength: 1 }),
    ...UpdateFields,
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    state: Type.Optional(StringEnum(["active", "paused"] as const)),
  },
  { additionalProperties: false },
);

export const CronDeleteParams = Type.Object(
  { selector: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const CronRunParams = Type.Object(
  { selector: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const CronWakeupParams = Type.Object(
  {
    delay: Type.Optional(
      Type.String({ description: "Next delay from 1m through 1h" }),
    ),
    reason: Type.String({ minLength: 1 }),
    stop: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type CronCreateInput = Static<typeof CronCreateParams>;
export type CronListInput = Static<typeof CronListParams>;
export type CronUpdateInput = Static<typeof CronUpdateParams>;
export type CronDeleteInput = Static<typeof CronDeleteParams>;
export type CronRunInput = Static<typeof CronRunParams>;
export type CronWakeupInput = Static<typeof CronWakeupParams>;
