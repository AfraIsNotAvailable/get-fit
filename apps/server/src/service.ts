/** Application layer: load a snapshot, let the engine decide, persist the deltas.
 *
 * Every mutation runs inside `BEGIN IMMEDIATE`, so a tick and an HTTP confirm
 * can never interleave. The engine is pure; this file owns the transactions.
 */
import { createHash } from "node:crypto";
import {
  CheckinRefused, MUSCLES, LIBRARY, MUSCLE_NAME, ROLE_BASE, impliedWear, iso,
  confirm as engineConfirm, recordCheckin as engineRecordCheckin, refit as engineRefit,
  tick as engineTick, view as engineView,
  type Assignment, type CheckinKind, type Dashboard, type Readiness, type Round, type Snapshot,
  type Stropper,
} from "@getfit/engine";
import {
  insertCheckin, insertRound, insertWearEvents, loadOpeningBalance, loadSnapshot,
  markObserved, resolveRound, saveAttribution, saveClock, saveMuscles, saveProfile,
  saveSettings as dbSaveSettings, setCheckinReadiness, withImmediate,
  type Db, type SettingsInput,
} from "@getfit/db";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface CheckinBody {
  kind: CheckinKind;
  roundKey?: string | null;
  sleep?: number | null;
  stress?: number | null;
  fatigue?: number | null;
  soreness?: number | null;
  prs?: number | null;
  pain?: boolean;
  painWhere?: string | null;
  srpe?: number | null;
  rir?: number | null;
  stopper?: Stropper | null;
  muscleSoreness?: Record<string, number> | null;
  note?: string | null;
}

export interface TickOutcome {
  opened: Round | null;
  expired: Round | null;
  message: string | null;
}

export interface ConfirmOutcome {
  round: Round;
  receipt: string;
  clock: Snapshot["clock"];
}

const etagOf = (body: unknown): string => `"${createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;

export class Services {
  constructor(
    readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
    readonly readOnly = false,
  ) {}

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  private guard(): void {
    if (this.readOnly) {
      throw new HttpError(503, "read_only", "this instance is a read-only shadow of the live database");
    }
  }

  now(): Date {
    return this.clock();
  }

  snapshot(now = this.now()): Snapshot {
    return loadSnapshot(this.db, now);
  }

  // ---------------------------------------------------------------- reads

  dashboard(sections?: string[]): { body: Dashboard; etag: string } {
    const now = this.now();
    const body = engineView(this.snapshot(now), now, loadOpeningBalance(this.db));
    if (sections && sections.length) {
      const wanted = new Set(["serverTime", ...sections]);
      const filtered = Object.fromEntries(
        Object.entries(body).filter(([key]) => wanted.has(key)),
      ) as unknown as Dashboard;
      return { body: filtered, etag: etagOf(filtered) };
    }
    return { body, etag: etagOf(body) };
  }

  rounds(limit = 50): Round[] {
    return [...this.snapshot().rounds].reverse().slice(0, Math.max(1, Math.min(200, limit)));
  }

  round(key: string): Round {
    const found = this.snapshot().rounds.find((r) => r.key === key);
    if (!found) throw new HttpError(404, "round_not_found", `no round ${key}`);
    return found;
  }

  checkinTodo(): unknown {
    return this.dashboard().body.checkinTodo;
  }

  /** The vocabulary a client needs to render without hard-coded strings. */
  meta(): unknown {
    return {
      version: "0.1.0",
      serverTime: this.dashboard(["serverTime"]).body.serverTime,
      muscles: MUSCLES.map(([slug, name, region, sort]) => ({ slug, name, region, sort })),
      library: Object.entries(LIBRARY).map(([slug, [name, pairs]]) => ({
        slug,
        name,
        muscles: pairs.map(([muscleSlug, role, weight]) => ({ muscleSlug, role, weight })),
      })),
      enums: {
        roundStatus: ["pending", "done", "late", "missed"],
        checkinKind: ["gate", "post"],
        stopper: ["muscle", "breathing", "joints", "boredom"],
        storageRole: Object.keys(ROLE_BASE),
        muscles: Object.keys(MUSCLE_NAME),
      },
    };
  }

  // ---------------------------------------------------------------- writes

  tick(force = false): TickOutcome {
    this.guard();
    return withImmediate(this.db, () => {
      const now = this.now();
      const before = this.snapshot(now);
      const result = engineTick(before, now, { force });
      if (result.expired) {
        resolveRound(this.db, result.expired.key, "missed", String(result.expired.resolvedAt), null);
      }
      if (result.opened) insertRound(this.db, result.opened);
      saveClock(this.db, result.snapshot.clock);
      return { opened: result.opened, expired: result.expired, message: result.message };
    });
  }

  confirm(key: string, source: string): ConfirmOutcome {
    this.guard();
    return withImmediate(this.db, () => {
      const now = this.now();
      const snap = this.snapshot(now);
      const last = snap.rounds[snap.rounds.length - 1];
      if (!last || last.key !== key) {
        throw new HttpError(409, "round_not_open", "that round is not the open one", {
          open: last?.key ?? null, status: last?.status ?? null,
        });
      }
      if (last.status !== "pending" && last.status !== "missed") {
        throw new HttpError(409, "round_already_resolved", `round ${key} is ${last.status}`, {
          status: last.status, resolvedAt: last.resolvedAt,
        });
      }
      const result = engineConfirm(snap, now, source);
      if (result.rc !== 0 || !result.round) {
        throw new HttpError(409, "round_already_resolved", "nothing pending", { status: last.status });
      }
      resolveRound(this.db, key, result.round.status, String(result.round.resolvedAt), source || null);
      insertWearEvents(this.db, result.snapshot.wearEvents.slice(snap.wearEvents.length));
      saveMuscles(this.db, result.snapshot.muscles);
      saveAttribution(this.db, result.snapshot.attribution, now);
      saveClock(this.db, result.snapshot.clock);
      return { round: result.round, receipt: result.receipt, clock: result.snapshot.clock };
    });
  }

  checkin(body: CheckinBody): unknown {
    this.guard();
    return withImmediate(this.db, () => {
      const now = this.now();
      const snap = this.snapshot(now);
      let outcome;
      try {
        outcome = engineRecordCheckin(snap, body, now, snap.settings.responseMinutes);
      } catch (error) {
        if (error instanceof CheckinRefused) {
          throw new HttpError(error.code, codeForCheckin(error.code, error.message), error.message);
        }
        throw error;
      }
      const { snapshot: after, result } = outcome;
      const draft = after.checkins[after.checkins.length - 1]!;
      const id = insertCheckin(this.db, draft);
      if (draft.kind === "gate" && draft.readiness !== null) {
        setCheckinReadiness(this.db, id, draft.readiness);
      }
      saveMuscles(this.db, after.muscles);
      saveAttribution(this.db, after.attribution, now);

      if (draft.kind === "post" && draft.roundKey) {
        const implied = impliedWear(draft.perMuscle);
        for (const [slug, value] of Object.entries(implied)) {
          markObserved(this.db, draft.roundKey, slug, value);
        }
        // recordCheckin already refit the snapshot; recompute to get the audit trail
        const fitted = engineRefit(after, now);
        saveProfile(this.db, fitted.profile, fitted.history, now, {
          wear_half_life: fitted.summary.wear_half_life.n,
          readiness_influence: fitted.summary.readiness_influence.n,
        });
      }
      return { ...result, id };
    });
  }

  saveSettings(input: SettingsInput): unknown {
    this.guard();
    return withImmediate(this.db, () => dbSaveSettings(this.db, input, this.now()));
  }
}

function codeForCheckin(code: number, message: string): string {
  if (code === 404) return "unknown_round";
  if (message.includes("already been answered")) return "checkin_already_answered";
  if (message.includes("window")) return "checkin_window_closed";
  return "checkin_refused";
}

export type { Assignment, Dashboard, Readiness };
