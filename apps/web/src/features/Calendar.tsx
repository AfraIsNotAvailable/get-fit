import { useEffect, useRef } from "react";
import type { Dashboard } from "../api.js";

/** Port of renderCalendar() from the Python dashboard.
 *
 * Weeks start Monday, future days are spacers, the fill is done/rounds
 * (dithered, so a partial day reads as partial), and the hue runs from teal
 * (a light day) to brick (a day at the ceiling). The scale is the theoretical
 * full day — rounds per day × the base stack — not the best day ever logged.
 */
const CELL = 11;
const GAP = 2;

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function hueFor(reps: number, scale: number): number {
  const t = scale > 0 ? Math.min(1, reps / scale) : 0;
  return 168 - 150 * t;
}

function paint(canvas: HTMLCanvasElement, fill: number, hue: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(CELL * dpr)) {
    canvas.width = Math.round(CELL * dpr);
    canvas.height = Math.round(CELL * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CELL, CELL);
  const empty = getComputedStyle(document.body).getPropertyValue("--cal-empty").trim() || "#e7e4dc";
  ctx.fillStyle = empty;
  ctx.fillRect(0, 0, CELL, CELL);
  if (fill <= 0) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.fillStyle = `hsl(${hue.toFixed(0)} ${dark ? 52 : 42}% ${dark ? 62 : 45}%)`;
  const sub = CELL / 4;
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      if (((BAYER[y]?.[x] ?? 0) + 0.5) / 16 <= fill) ctx.fillRect(x * sub, y * sub, sub, sub);
    }
  }
}

const isoDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function YearCalendar({ calendar, dayScale }: {
  calendar: Dashboard["calendar"];
  dayScale: number;
}) {
  const calRef = useRef<HTMLDivElement>(null);
  const monthsRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const calEl = calRef.current;
    const monthsEl = monthsRef.current;
    const keyEl = keyRef.current;
    if (!calEl || !monthsEl || !keyEl) return;

    const days = calendar.days ?? {};
    const max = Math.max(1, dayScale);
    const today = new Date(`${calendar.today}T00:00:00`);
    const start = new Date(`${calendar.start}T00:00:00`);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday

    calEl.innerHTML = "";
    monthsEl.innerHTML = "";
    keyEl.innerHTML = "";

    const cursor = new Date(start);
    let weekIndex = 0;
    let lastMonth = -1;
    const frag = document.createDocumentFragment();

    while (cursor <= today) {
      const week = document.createElement("div");
      week.className = "week";
      for (let i = 0; i < 7; i += 1) {
        if (cursor > today) {
          const spacer = document.createElement("div");
          spacer.className = "spacer";
          week.appendChild(spacer);
        } else {
          const key = isoDay(cursor);
          const info = days[key];
          const canvas = document.createElement("canvas");
          canvas.title = !info || !info.rounds
            ? `${cursor.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} — no rounds`
            : `${cursor.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} — ${info.reps} reps · ${info.done}/${info.rounds} rounds`;
          const fill = info && info.rounds ? info.done / info.rounds : 0;
          paint(canvas, fill, hueFor(info ? info.reps : 0, max));
          week.appendChild(canvas);
        }
        if (i === 0) {
          const month = cursor.getMonth();
          if (month !== lastMonth) {
            lastMonth = month;
            const label = document.createElement("span");
            label.textContent = cursor.toLocaleDateString(undefined, { month: "short" });
            label.style.left = `${weekIndex * (CELL + GAP)}px`;
            monthsEl.appendChild(label);
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      frag.appendChild(week);
      weekIndex += 1;
    }
    calEl.appendChild(frag);
    calEl.scrollLeft = calEl.scrollWidth;

    for (const fraction of [0.2, 0.45, 0.7, 1]) {
      const canvas = document.createElement("canvas");
      paint(canvas, fraction, hueFor(fraction * max, max));
      keyEl.appendChild(canvas);
    }
  }, [calendar, dayScale]);

  return (
    <>
      <div className="cal-months" ref={monthsRef} />
      <div className="cal" ref={calRef} />
      <div className="cal-legend">
        <span>less</span>
        <span ref={keyRef} style={{ display: "flex", gap: 2 }} />
        <span>more</span>
      </div>
    </>
  );
}
