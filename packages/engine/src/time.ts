/** Time helpers. Everything is UTC internally; the local view comes from a tz name. */

export function parseIso(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
}

/** RFC 3339, seconds precision, always Z — the format the Python app wrote. */
export function iso(date: Date): string {
  return new Date(Math.round(date.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateISO: string; // YYYY-MM-DD
  secondsOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const minute = get("minute");
  const second = get("second");
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateISO: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    secondsOfDay: hour * 3600 + minute * 60 + second,
  };
}

export function localDate(date: Date, tz: string): string {
  return localParts(date, tz).dateISO;
}

export function localHM(date: Date, tz: string, withSeconds = false): string {
  const p = localParts(date, tz);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return withSeconds ? `${hh}:${mm}:${String(p.second).padStart(2, "0")}` : `${hh}:${mm}`;
}

function offsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** A wall-clock time in `tz` (a local date + seconds of day) as a UTC instant. */
export function utcFromLocal(dateISO: string, secondsOfDay: number, tz: string): Date {
  const [y, m, d] = dateISO.split("-").map(Number) as [number, number, number];
  const h = Math.floor(secondsOfDay / 3600);
  const mi = Math.floor((secondsOfDay % 3600) / 60);
  const s = secondsOfDay % 60;
  const guess = new Date(Date.UTC(y, m - 1, d, h, mi, s));
  let ts = guess.getTime() - offsetMs(guess, tz);
  // one correction pass covers DST transitions
  ts = guess.getTime() - offsetMs(new Date(ts), tz);
  return new Date(ts);
}

export function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

export function monthOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Python's round(): half-to-even, because the model's numbers were produced with it. */
export function pyRound(value: number, digits = 0): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (Math.abs(diff - 0.5) < 1e-9) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  return rounded / factor;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : 0.5 * ((sorted[mid - 1] as number) + (sorted[mid] as number));
}
