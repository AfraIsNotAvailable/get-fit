/** The wire contract: every mutating body is parsed here before it reaches the
 *  database. Zod is the single source; the OpenAPI emitter in phase 3 reads
 *  these same schemas, so documented and enforced cannot drift apart.
 */
import { z } from "zod";
import { MUSCLE_NAME } from "@getfit/engine";

export const MUSCLE_SLUGS = Object.keys(MUSCLE_NAME);
const muscleSlug = z.string().refine((v) => v in MUSCLE_NAME, "unknown muscle");

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must look like HH:MM");

const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "unknown timezone");

const httpUrl = z.string().max(500).refine((value) => /^https?:\/\/\S+$/.test(value),
  "the form article must be an http(s) link");

export const ExerciseInput = z.object({
  id: z.string().max(64).nullish(),
  name: z.string().trim().min(1, "every exercise needs a name").max(40),
  min: z.number().int().min(0).max(500),
  max: z.number().int().min(0).max(500).nullish(),
  formUrl: z.union([httpUrl, z.literal(""), z.null()]).optional(),
});

export const SettingsInput = z.object({
  timezone,
  intervalMinutes: z.number().int().min(1).max(1440),
  responseMinutes: z.number().int().min(1).max(240),
  quietStart: hhmm,
  quietEnd: hhmm,
  exercises: z.array(ExerciseInput).min(1, "keep at least one exercise").max(40),
}).superRefine((value, ctx) => {
  value.exercises.forEach((exercise, index) => {
    if (exercise.max !== null && exercise.max !== undefined && exercise.max < exercise.min) {
      ctx.addIssue({
        code: "custom",
        path: ["exercises", index, "max"],
        message: `${exercise.name}: maximum must be >= minimum`,
      });
    }
  });
});

const gateCheckin = z.object({
  kind: z.literal("gate"),
  sleep: z.number().min(0).max(14).nullish(),
  stress: z.number().int().min(1).max(5).nullish(),
  fatigue: z.number().int().min(1).max(5).nullish(),
  soreness: z.number().int().min(1).max(5).nullish(),
  prs: z.number().int().min(0).max(10).nullish(),
  pain: z.boolean().optional(),
  painWhere: muscleSlug.nullish(),
  muscleSoreness: z.record(muscleSlug, z.number().int().min(1).max(5)).nullish(),
  note: z.string().max(500).nullish(),
});

const postCheckin = z.object({
  kind: z.literal("post"),
  roundKey: z.string().min(1, "a post-set check-in needs the round key"),
  srpe: z.number().int().min(0).max(10).nullish(),
  rir: z.number().int().min(0).max(3).nullish(),
  stopper: z.enum(["muscle", "breathing", "joints", "boredom"]).nullish(),
  reps: z.number().int().min(0).max(500).nullish(),
  muscleSoreness: z.record(muscleSlug, z.number().int().min(1).max(5)).nullish(),
  note: z.string().max(500).nullish(),
});

export const CheckinInput = z.discriminatedUnion("kind", [gateCheckin, postCheckin]);

export const ConfirmationInput = z.object({
  source: z.enum(["web", "android", "telegram", "cli"]).default("web"),
  note: z.string().max(500).optional(),
});

export const PairInput = z.object({
  code: z.string().regex(/^\d{8}$/, "the pairing code is 8 digits"),
  deviceName: z.string().trim().min(1).max(60),
  platform: z.enum(["android", "ios", "cli"]).default("android"),
  model: z.string().max(60).nullish(),
});

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super("the request body did not validate");
    this.name = "ValidationError";
  }
}

/** Parse with a ValidationError that the HTTP layer maps to 422. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })));
  }
  return result.data;
}

export type SettingsBody = z.infer<typeof SettingsInput>;
export type CheckinBody = z.infer<typeof CheckinInput>;
export type PairBody = z.infer<typeof PairInput>;
export type ConfirmationBody = z.infer<typeof ConfirmationInput>;
export { z };
