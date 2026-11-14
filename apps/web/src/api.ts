/** Thin typed client. Generated from OpenAPI later; hand-written for now. */

export interface Exercise {
  id: string; name: string; min: number; max: number | null;
  formUrl: string | null; active: boolean; position: number;
}

export interface Assignment { id: string; name: string; reps: number; formUrl: string | null }

export interface RoundItem { exerciseSlug: string; exerciseName: string; reps: number }

export interface Round {
  key: string; sentAt: string; deadlineAt: string; resolvedAt: string | null;
  status: "pending" | "done" | "late" | "missed"; bonusApplied: number;
  targetReps: number; source: string | null; items: RoundItem[];
}

export interface Muscle {
  slug: string; name: string; region: string; sort: number;
  wear: number; soreness: number; load: number; stopAt: number; stopEffective: number;
  resumeAt: number; lastLoadedAt: string | null; resting: boolean; restUntil: string | null;
}

export interface CalendarDay { rounds: number; done: number; reps: number; ratio: number; byEx: Record<string, number> }

export interface CalendarMonth {
  month: string; label: string; year: number; days: number;
  target: number; reps: number; ratio: number; current: boolean;
}

export interface Readiness {
  score: number; prs: number | null; at: string | null; stale: boolean;
  pain: boolean; painWhere: string | null; hooper: number | null; answers: string[];
}

export interface CheckinTodo {
  due: "gate" | "post";
  round: {
    roundKey: string; at: string | null; expiresAt: string; secondsLeft: number;
    exercises: { name: string; reps: number }[];
    muscles: { slug: string; name: string; role: string }[];
  } | null;
  expiresAt: string | null; secondsLeft: number | null;
  windowMinutes: number; readiness: Readiness;
  gateAnswered: Record<string, number>;
  askMuscles: { slug: string; name: string; load: number; lastLoadedAt: string; hoursAgo: number }[];
  lastGate: Record<string, unknown> | null;
}

export interface Dashboard {
  serverTime: {
    utc: string; local: string; dateLocal: string; timezone: string;
    quietNow: boolean; quietWindow: { start: string; end: string };
    secondsToNextEvent: number | null;
  };
  settings: {
    timezone: string; intervalMinutes: number; responseMinutes: number;
    quietStart: string; quietEnd: string; exercises: Exercise[];
  };
  clock: { bonus: number; nextSetAt: string | null };
  currentRound: (Round & { secondsLeft: number; localSent: string }) | null;
  roundOpen: boolean;
  nextSet: { at: string; local: string; deferred: boolean; scheduled: string; secondsLeft: number } | null;
  nextAssignment: Assignment[];
  lifetime: {
    totalReps: number; setsDone: number; setsMissed: number; startedAt: string | null;
    exercises: { id: string; name: string; reps: number; retired: boolean }[];
  };
  recentRounds: {
    roundKey: string; status: string; at: string; local: string; day: string;
    exercises: { name: string; reps: number }[];
  }[];
  calendar: { days: Record<string, CalendarDay>; today: string; start: string; maxReps: number };
  months: { roundsPerDay: number; baseReps: number; current: CalendarMonth; history: CalendarMonth[] };
  muscles: Muscle[];
  readiness: Readiness;
  profile: {
    params: { key: string; value: number; prior: number; n: number; fitted: boolean; updatedAt: string }[];
    calibration: { mae: number | null; n: number; series: { checkin: number; error: number }[] };
  };
  checkinTodo: CheckinTodo;
  selection: { deload: boolean; blocked: { name: string; why: string }[]; ranked: { id: string; name: string; load: number; why: string; joined: boolean }[] };
  unattributed: { slug: string; name: string }[];
}

export interface Problem {
  type: string; title: string; status: number; code: string; detail?: string;
  errors?: { path: string; message: string }[]; current?: unknown;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly problem: Problem) {
    super(problem.detail ?? problem.title ?? "request failed");
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 304) return undefined as T;
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(response.status, body as Problem);
  return body as T;
}

export const api = {
  dashboard: () => request<Dashboard>("/api/v1/dashboard", { cache: "no-store" }),
  confirm: (roundKey: string) =>
    request<{ roundKey: string; status: string; receipt: string }>(
      `/api/v1/rounds/${roundKey}/confirm`,
      { method: "POST", body: JSON.stringify({ source: "web" }) },
    ),
  checkin: (body: unknown) =>
    request<{ ok: boolean; readiness: number | null; changes: unknown[] }>(
      "/api/v1/checkins",
      { method: "POST", body: JSON.stringify(body) },
    ),
  settings: () => request<Dashboard["settings"]>("/api/v1/settings"),
  saveSettings: (body: unknown) =>
    request<Dashboard["settings"]>("/api/v1/settings", { method: "PUT", body: JSON.stringify(body) }),
};
