import { describe, expect, it } from "vitest";
import { CheckinInput, SettingsInput, ValidationError, parseOrThrow } from "../src/index.js";

const validSettings = {
  timezone: "Europe/Bucharest",
  intervalMinutes: 90,
  responseMinutes: 10,
  quietStart: "23:00",
  quietEnd: "07:00",
  exercises: [{ id: "pushups", name: "Push-ups", min: 10, max: 20 }],
};

describe("settings validation", () => {
  it("accepts the shape the app writes", () => {
    expect(parseOrThrow(SettingsInput, validSettings).exercises).toHaveLength(1);
  });

  it("rejects nonsense that would corrupt the stack", () => {
    for (const patch of [
      { intervalMinutes: 0 },
      { intervalMinutes: 1441 },
      { quietStart: "7:00" },
      { timezone: "Mars/Olympus" },
      { exercises: [] },
      { exercises: [{ name: "", min: 1 }] },
      { exercises: [{ name: "Row", min: 10, max: 5 }] },
      { exercises: [{ name: "Row", min: -1 }] },
      { exercises: [{ name: "Row", min: 1, formUrl: "javascript:alert(1)" }] },
    ]) {
      const result = SettingsInput.safeParse({ ...validSettings, ...patch });
      expect(result.success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("reports the field path, not just a sentence", () => {
    try {
      parseOrThrow(SettingsInput, {
        ...validSettings,
        exercises: [{ name: "Push-ups", min: 10, max: 20 }, { name: "Squats", min: 10, max: 2 }],
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0]?.path).toBe("exercises.1.max");
    }
  });
});

describe("check-in validation", () => {
  it("accepts a partial gate", () => {
    expect(parseOrThrow(CheckinInput, { kind: "gate", sleep: 7.5 }).kind).toBe("gate");
  });

  it("needs a round key for a post answer", () => {
    expect(CheckinInput.safeParse({ kind: "post", rir: 2 }).success).toBe(false);
    expect(CheckinInput.safeParse({ kind: "post", roundKey: "abc", rir: 2 }).success).toBe(true);
  });

  it("refuses a muscle that does not exist", () => {
    expect(CheckinInput.safeParse({
      kind: "post", roundKey: "abc", muscleSoreness: { "left-spleen": 3 },
    }).success).toBe(false);
  });

  it("bounds the scales", () => {
    expect(CheckinInput.safeParse({ kind: "gate", stress: 6 }).success).toBe(false);
    expect(CheckinInput.safeParse({ kind: "gate", sleep: 20 }).success).toBe(false);
    expect(CheckinInput.safeParse({ kind: "post", roundKey: "k", rir: 4 }).success).toBe(false);
  });
});
