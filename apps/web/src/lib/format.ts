export const pad = (n: number): string => String(Math.max(0, Math.trunc(n))).padStart(2, "0");

/** 3725 -> "1:02:05", 125 -> "02:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const thousands = (n: number): string => n.toLocaleString("en-GB");

export function readinessWord(score: number, stale: boolean): string {
  if (stale) return "no fresh check-in";
  if (score >= 0.85) return "fresh";
  if (score >= 0.65) return "ok";
  if (score >= 0.45) return "worn";
  return "spent";
}
