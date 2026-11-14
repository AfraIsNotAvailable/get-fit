import { useEffect, useState } from "react";
import type { CheckinTodo, Dashboard } from "../api.js";
import { ApiError, api } from "../api.js";
import { clock } from "../lib/format.js";

const SEG5 = [1, 2, 3, 4, 5];

function Seg({ value, options, onChange, labels }: {
  value: number | null; options: number[]; onChange: (v: number | null) => void;
  labels?: (n: number) => string;
}) {
  return (
    <div className="seg">
      {options.map((n) => (
        <button
          key={n}
          type="button"
          className={value === n ? "on" : ""}
          onClick={() => onChange(value === n ? null : n)}
        >
          {labels ? labels(n) : n}
        </button>
      ))}
    </div>
  );
}

function Question({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="q">
      <span className="qt" {...(help ? { "data-help": help } : {})}>{title}</span>
      <span className="qin">{children}</span>
    </div>
  );
}

export function GateForm({ dash, onDone }: { dash: Dashboard; onDone: () => void }) {
  const [sleep, setSleep] = useState("");
  const [stress, setStress] = useState<number | null>(null);
  const [fatigue, setFatigue] = useState<number | null>(null);
  const [soreness, setSoreness] = useState<number | null>(null);
  const [prs, setPrs] = useState<number | null>(null);
  const [pain, setPain] = useState(false);
  const [painWhere, setPainWhere] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const answered = dash.checkinTodo.gateAnswered;
  const ready = dash.readiness;

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { kind: "gate" };
      if (sleep.trim()) body.sleep = Number(sleep);
      if (stress !== null) body.stress = stress;
      if (fatigue !== null) body.fatigue = fatigue;
      if (soreness !== null) body.soreness = soreness;
      if (prs !== null) body.prs = prs;
      if (pain && painWhere) { body.pain = true; body.painWhere = painWhere; }
      await api.checkin(body);
      setMsg("saved");
      setSleep(""); setStress(null); setFatigue(null); setSoreness(null); setPrs(null);
      setPain(false); setPainWhere("");
      onDone();
    } catch (error) {
      setMsg(error instanceof ApiError ? (error.problem.errors?.[0]?.message ?? error.message) : "could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Question title="Sleep" help="Hours actually slept. Converted to the 1–5 scale when readiness is computed.">
        <input
          className="pick num" type="number" min={0} max={14} step={0.5} value={sleep}
          placeholder="hours" onChange={(event) => setSleep(event.target.value)}
        />
        {answered.sleep !== undefined ? <span className="label">answered {answered.sleep}</span> : null}
      </Question>
      <Question title="Stress" help="Hooper item: 1 = none, 5 = very high.">
        <Seg value={stress} options={SEG5} onChange={setStress} />
      </Question>
      <Question title="Fatigue" help="Hooper item: 1 = fresh, 5 = exhausted.">
        <Seg value={fatigue} options={SEG5} onChange={setFatigue} />
      </Question>
      <Question title="Soreness" help="Hooper item: 1 = nothing, 5 = everywhere.">
        <Seg value={soreness} options={SEG5} onChange={setSoreness} />
      </Question>
      <Question title="Recovered" help="Perceived Recovery Status, 0–10. Lower than 5 halves everyone's ceiling.">
        <Seg value={prs} options={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} onChange={setPrs} />
      </Question>
      <Question title="Pain" help="A flagged muscle is parked for 48 hours and excluded from selection.">
        <label className="label" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={pain} onChange={(event) => setPain(event.target.checked)} />
          something hurts
        </label>
        {pain ? (
          <select className="pick" value={painWhere} onChange={(event) => setPainWhere(event.target.value)}>
            <option value="">where?</option>
            {dash.muscles.map((muscle) => (
              <option key={muscle.slug} value={muscle.slug}>{muscle.name}</option>
            ))}
          </select>
        ) : null}
      </Question>
      <div className="qfoot">
        <button className="submit" type="button" onClick={submit} disabled={busy}>Save check-in</button>
        <span className="qmsg">{msg ?? ""}</span>
        <span className="label" style={{ marginLeft: "auto" }}>
          readiness {ready.score.toFixed(2)} · {ready.stale ? "stale" : "today"}
        </span>
      </div>
    </div>
  );
}

export function PostSheet({ todo, secondsLeft, onClose, onDone }: {
  todo: CheckinTodo & { round: NonNullable<CheckinTodo["round"]> };
  secondsLeft: number; onClose: () => void; onDone: () => void;
}) {
  const [srpe, setSrpe] = useState<number | null>(null);
  const [rir, setRir] = useState<number | null>(null);
  const [stopper, setStopper] = useState("");
  const [muscles, setMuscles] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [left, setLeft] = useState(secondsLeft);

  useEffect(() => {
    const id = setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { kind: "post", roundKey: todo.round.roundKey };
      if (srpe !== null) body.srpe = srpe;
      if (rir !== null) body.rir = rir;
      if (stopper) body.stopper = stopper;
      if (Object.keys(muscles).length) body.muscleSoreness = muscles;
      await api.checkin(body);
      onDone();
      onClose();
    } catch (error) {
      setMsg(error instanceof ApiError ? (error.problem.detail ?? error.message) : "could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="sheet">
        <div className="sheet-head">
          <span className="label">After the set</span>
          <span className="right">
            <span className="label">{left > 0 ? `closes in ${clock(left)}` : "window closed"}</span>
            <button className="x" type="button" onClick={onClose} aria-label="Close">×</button>
          </span>
        </div>
        <div className="sheet-set">
          {todo.round.exercises.map((item) => `${item.reps} ${item.name.toLowerCase()}`).join(", ")}
        </div>
        <Question title="Effort" help="sRPE, 0–10: how hard the whole set felt.">
          <Seg value={srpe} options={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} onChange={setSrpe} />
        </Question>
        <Question title="Reps left" help="RIR: 0 = none left, 3+ = plenty. Zero makes the next set more expensive.">
          <Seg value={rir} options={[0, 1, 2, 3]} onChange={setRir} labels={(n) => (n === 3 ? "3+" : String(n))} />
        </Question>
        <Question title="Stopped by" help="What ended the set. Muscle failure is the interesting one.">
          <select className="pick" value={stopper} onChange={(event) => setStopper(event.target.value)}>
            <option value="">—</option>
            <option value="muscle">muscle</option>
            <option value="breathing">breathing</option>
            <option value="joints">joints</option>
            <option value="boredom">boredom</option>
          </select>
        </Question>
        {todo.round.muscles.map((muscle) => (
          <Question key={muscle.slug} title={muscle.name} help={`How sore is it now? 1–5. ${muscle.role} in that set.`}>
            <Seg
              value={muscles[muscle.slug] ?? null}
              options={SEG5}
              onChange={(value) => {
                setMuscles((prev) => {
                  const next = { ...prev };
                  if (value === null) delete next[muscle.slug];
                  else next[muscle.slug] = value;
                  return next;
                });
              }}
            />
          </Question>
        ))}
        <div className="qfoot">
          <button className="submit" type="button" onClick={submit} disabled={busy || left <= 0}>
            Save measurement
          </button>
          <span className="qmsg">{msg ?? ""}</span>
        </div>
      </div>
    </div>
  );
}
