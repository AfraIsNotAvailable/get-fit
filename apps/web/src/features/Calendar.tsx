import { useEffect, useRef } from "react";
import type { Dashboard } from "../api.js";

const CELL = 11;
const GAP = 2;
const DAYS = 7;

function hue(reps: number, max: number): string {
  if (reps <= 0) return "var(--cal-empty)";
  const t = Math.min(1, reps / Math.max(1, max));
  const alpha = 0.18 + 0.72 * t;
  return `color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, var(--cal-empty))`;
}

function paint(canvas: HTMLCanvasElement, fill: string, strong: boolean) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CELL * dpr;
  canvas.height = CELL * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, CELL, CELL);
  if (strong) {
    ctx.strokeStyle = "rgba(127,127,127,.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, CELL - 1, CELL - 1);
  }
}

/** A year of day cells, one canvas each, weeks as columns. */
export function YearCalendar({ calendar }: { calendar: Dashboard["calendar"] }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.innerHTML = "";
    const start = new Date(`${calendar.start}T00:00:00Z`);
    const today = new Date(`${calendar.today}T00:00:00Z`);
    const days = Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;

    let week: HTMLDivElement | null = null;
    for (let i = 0; i < days; i += 1) {
      const date = new Date(start.getTime() + i * 86_400_000);
      if (i % DAYS === 0) {
        const next = document.createElement("div");
        next.className = "week";
        root.appendChild(next);
        week = next;
      }
      const iso = date.toISOString().slice(0, 10);
      const info = calendar.days[iso];
      const canvas = document.createElement("canvas");
      canvas.title = info
        ? `${iso}: ${info.done}/${info.rounds} rounds, ${info.reps} reps`
        : `${iso}: nothing`;
      paint(canvas, hue(info?.reps ?? 0, calendar.maxReps), Boolean(info && info.done < info.rounds));
      week?.appendChild(canvas);
    }
  }, [calendar]);

  return <div className="cal" ref={host} />;
}
