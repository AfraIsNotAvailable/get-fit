import { useState } from "react";
import type { Dashboard } from "../api.js";
import { ApiError, api } from "../api.js";

interface Row {
  id: string | null;
  name: string;
  min: number;
  max: number | null;
  formUrl: string;
}

function rowsFrom(settings: Dashboard["settings"]): Row[] {
  return settings.exercises.map((exercise) => ({
    id: exercise.id,
    name: exercise.name,
    min: exercise.min,
    max: exercise.max,
    formUrl: exercise.formUrl ?? "",
  }));
}

export function SettingsPage({ dash, onSaved }: { dash: Dashboard; onSaved: () => void }) {
  const [interval, setInterval] = useState(String(dash.settings.intervalMinutes));
  const [response, setResponse] = useState(String(dash.settings.responseMinutes));
  const [quietStart, setQuietStart] = useState(dash.settings.quietStart);
  const [quietEnd, setQuietEnd] = useState(dash.settings.quietEnd);
  const [timezone, setTimezone] = useState(dash.settings.timezone);
  const [rows, setRows] = useState<Row[]>(rowsFrom(dash.settings));
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const move = (index: number, delta: number) =>
    setRows((prev) => {
      const next = [...prev];
      const target = index + delta;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });

  const enableAlerts = async () => {
    if (!("Notification" in window)) {
      setMsg({ text: "This browser has no notifications.", kind: "err" });
      return;
    }
    if (!window.isSecureContext) {
      setMsg({
        text: `Needs https — open https://${window.location.hostname}:8443/settings and allow it there`,
        kind: "err",
      });
      return;
    }
    const permission = await Notification.requestPermission();
    setMsg(
      permission === "granted"
        ? { text: "Laptop alerts on", kind: "ok" }
        : permission === "denied"
          ? { text: "Blocked — allow notifications for this site in the browser", kind: "err" }
          : { text: "Not granted", kind: "err" },
    );
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.saveSettings({
        timezone,
        intervalMinutes: Number(interval),
        responseMinutes: Number(response),
        quietStart,
        quietEnd,
        exercises: rows.map((row) => ({
          id: row.id,
          name: row.name,
          min: Number(row.min),
          max: row.max === null ? null : Number(row.max),
          formUrl: row.formUrl || null,
        })),
      });
      setMsg({ text: "saved", kind: "ok" });
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.problem.errors?.length) {
        setMsg({ text: error.problem.errors.map((e) => `${e.path}: ${e.message}`).join(" · "), kind: "err" });
      } else {
        setMsg({ text: error instanceof Error ? error.message : "could not save", kind: "err" });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">
        Saved to the local database the scheduler reads on every tick. Changing minimums affects the next
        set, not the one already on the clock.
      </p>

      <section className="block">
        <div className="block-head">
          <span className="label">Schedule</span>
          <span className="label">local time</span>
        </div>
        <div className="fields">
          <div className="f"><label>Interval, min</label>
            <input type="number" min={1} max={1440} value={interval}
              onChange={(event) => setInterval(event.target.value)} /></div>
          <div className="f"><label>Answer within, min</label>
            <input type="number" min={1} max={240} value={response}
              onChange={(event) => setResponse(event.target.value)} /></div>
          <div className="f"><label>Quiet from</label>
            <input type="text" inputMode="numeric" value={quietStart}
              onChange={(event) => setQuietStart(event.target.value)} /></div>
          <div className="f"><label>Quiet until</label>
            <input type="text" inputMode="numeric" value={quietEnd}
              onChange={(event) => setQuietEnd(event.target.value)} /></div>
          <div className="f wide"><label>Timezone</label>
            <input type="text" value={timezone} onChange={(event) => setTimezone(event.target.value)} /></div>
        </div>
      </section>

      <section className="block">
        <div className="block-head">
          <span className="label">Exercises</span>
          <span className="label">overflow runs top to bottom</span>
        </div>
        <div className="exrow-head">
          <span>#</span><span>Exercise</span><span>Minimum</span><span>Max</span><span>Order</span>
        </div>
        {rows.map((row, index) => {
          const last = index === rows.length - 1;
          return (
            <div className="exrow" key={row.id ?? `new-${index}`}>
              <span className="idx">{index + 1}</span>
              <span className="cellname">
                <span className="clab">Exercise</span>
                <input type="text" maxLength={40} value={row.name} aria-label="Name"
                  onChange={(event) => update(index, { name: event.target.value })} />
                <input type="url" className="furl" placeholder="form article URL" value={row.formUrl}
                  aria-label="Form article URL"
                  onChange={(event) => update(index, { formUrl: event.target.value })} />
              </span>
              <span className="fmin">
                <span className="clab">Minimum</span>
                <input type="number" min={0} value={row.min} aria-label="Minimum"
                  onChange={(event) => update(index, { min: Number(event.target.value) })} />
              </span>
              <span className="fmax">
                <span className="clab">Max</span>
                <input type="number" min={0} value={last ? "" : row.max ?? ""} disabled={last}
                  placeholder="none" aria-label="Maximum"
                  onChange={(event) => update(index, { max: event.target.value === "" ? null : Number(event.target.value) })} />
              </span>
              <span className="tools">
                <button className="icon" type="button" title="Move up" disabled={index === 0}
                  onClick={() => move(index, -1)}>↑</button>
                <button className="icon" type="button" title="Move down" disabled={last}
                  onClick={() => move(index, 1)}>↓</button>
                <button className="icon" type="button" title="Remove" disabled={rows.length <= 1}
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}>×</button>
              </span>
            </div>
          );
        })}
        <div className="addrow">
          <button className="link" type="button"
            onClick={() => setRows((prev) => [...prev, { id: null, name: "", min: 0, max: null, formUrl: "" }])}>
            Add exercise
          </button>
        </div>
        <div className="actions">
          <button className="btn ghost" type="button" onClick={() => void enableAlerts()}>
            Enable laptop alerts
          </button>
          <button className="btn" type="button" onClick={save} disabled={busy}>Save settings</button>
          <span className={`msg ${msg?.kind ?? ""}`}>{msg?.text ?? ""}</span>
        </div>
        <p className="note">
          Reps past an exercise&apos;s max land on the next one, which joins at its own minimum. The last
          exercise has no max. Removing one retires it: its reps stay in the lifetime tally.
        </p>
      </section>
    </>
  );
}
