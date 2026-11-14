import { useCallback, useEffect, useState } from "react";
import { api, type Dashboard } from "./api.js";
import { DashboardView } from "./features/Dashboard.js";
import { GateForm, PostSheet } from "./features/Checkin.js";
import { SettingsPage } from "./features/Settings.js";
import { clock } from "./lib/format.js";

const POLL_MS = 30_000;

export default function App() {
  const isSettings = /\/settings\/?$/.test(window.location.pathname);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [postSeen, setPostSeen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.dashboard();
      setDash(next);
      setFetchedAt(Date.now());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "could not reach the server");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // a post-set window opens by itself, once per round
  useEffect(() => {
    if (!dash) return;
    const todo = dash.checkinTodo;
    if (todo.due === "post" && todo.round && todo.round.secondsLeft > 0 && postSeen !== todo.round.roundKey) {
      setPostOpen(true);
      setPostSeen(todo.round.roundKey);
    }
  }, [dash, postSeen]);

  if (!dash) {
    return (
      <div className="wrap">
        <p className="lede">{error ?? "Loading…"}</p>
      </div>
    );
  }

  const elapsed = (now - fetchedAt) / 1000;
  const secondsLeft = Math.max(
    0,
    (dash.roundOpen ? dash.currentRound?.secondsLeft ?? 0 : dash.nextSet?.secondsLeft ?? 0) - elapsed,
  );
  const postLeft = Math.max(0, (dash.checkinTodo.round?.secondsLeft ?? 0) - elapsed);

  const confirm = async () => {
    if (!dash.currentRound) return;
    setBusy(true);
    try {
      await api.confirm(dash.currentRound.key);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const checkinBlock = (
    <section className="block">
      <div className="block-head">
        <span className="label">
          {dash.checkinTodo.due === "post" ? "After the set" : "Check-in"}
        </span>
        <span className="label">
          readiness {dash.readiness.score.toFixed(2)}
          {dash.readiness.stale ? " · stale" : ""}
        </span>
      </div>
      {dash.checkinTodo.due === "post" && dash.checkinTodo.round ? (
        <div className="qfoot">
          <button className="submit" type="button" onClick={() => setPostOpen(true)}>
            Measure that set
          </button>
          <span className="label">
            closes in {clock(postLeft)}
          </span>
        </div>
      ) : (
        <GateForm dash={dash} onDone={() => void load()} />
      )}
    </section>
  );

  return (
    <div className="wrap">
      <div className="masthead">
        <span className="left">
          <a className="brand" href="/">Get fit</a>
          <a className="navlink" href={isSettings ? "/" : "/settings"}>
            {isSettings ? "Dashboard" : "Settings"}
          </a>
        </span>
        <span className="stamp">
          {dash.serverTime.local} · {dash.serverTime.timezone}
        </span>
      </div>

      {error ? <p className="lede" style={{ color: "var(--accent)" }}>{error}</p> : null}

      {isSettings ? (
        <SettingsPage dash={dash} onSaved={() => void load()} />
      ) : (
        <DashboardView
          dash={dash}
          secondsLeft={secondsLeft}
          onConfirm={() => void confirm()}
          onOpenPost={() => setPostOpen(true)}
          busy={busy}
          checkin={checkinBlock}
        />
      )}

      {postOpen && dash.checkinTodo.round && dash.checkinTodo.due === "post" ? (
        <PostSheet
          todo={{ ...dash.checkinTodo, round: dash.checkinTodo.round }}
          secondsLeft={postLeft}
          onClose={() => setPostOpen(false)}
          onDone={() => void load()}
        />
      ) : null}
    </div>
  );
}
