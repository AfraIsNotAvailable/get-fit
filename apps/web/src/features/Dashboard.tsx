import { useState } from "react";
import type { Dashboard, Muscle } from "../api.js";
import { clock, thousands } from "../lib/format.js";
import { Atlas } from "./Atlas.js";
import { YearCalendar } from "./Calendar.js";

interface Props {
  dash: Dashboard;
  secondsLeft: number;
  onConfirm: () => void;
  onOpenPost: () => void;
  busy: boolean;
  checkin: React.ReactNode;
}

function assignmentItems(
  items: { id: string; name: string; reps: number; formUrl: string | null }[],
  open: boolean,
) {
  if (items.length === 0) return <span className="idle">Nothing scheduled.</span>;
  return (
    <>
      {items.map((item) => (
        <span className="item" key={item.id}>
          <b>{item.reps}</b>{" "}
          {item.formUrl ? (
            <a className="ex" href={item.formUrl} target="_blank" rel="noreferrer">{item.name}</a>
          ) : (
            <span className="ex missing" data-warn="no verified form article — add it in Settings">
              {item.name}
            </span>
          )}
        </span>
      ))}
      {open ? null : null}
    </>
  );
}

function MuscleRow({ muscle, ready, onHover }: {
  muscle: Muscle; ready: number; onHover: (slug: string | null) => void;
}) {
  const eff = Math.max(30, muscle.stopAt - (1 - ready) * 20);
  const classes = ["mrow2"];
  if (muscle.load < 0.5) classes.push("zero");
  else if (muscle.load >= 5) classes.push("warm");
  if (muscle.resting || muscle.load >= eff) classes.push("shut");
  return (
    <div
      className={classes.join(" ")}
      title={`${muscle.name} · wear ${muscle.wear} · soreness ${muscle.soreness}`}
      onMouseEnter={() => onHover(muscle.slug)}
    >
      <span className="mn">{muscle.name}</span>
      <span className="mbar" style={{ "--stop": `${eff}%` } as React.CSSProperties}>
        <i style={{ width: `${Math.min(100, muscle.load)}%` }} />
        <b />
      </span>
      <span className="mv">{Math.round(muscle.load)}</span>
    </div>
  );
}

export function DashboardView({ dash, secondsLeft, onConfirm, onOpenPost, busy, checkin }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const open = dash.roundOpen && dash.currentRound;
  const current = dash.currentRound;
  const total = open ? dash.settings.responseMinutes * 60 : dash.settings.intervalMinutes * 60;
  const pct = Math.max(0, Math.min(100, (secondsLeft / Math.max(1, total)) * 100));

  const started = dash.lifetime.startedAt;
  const heroSub = started
    ? <><b>{dash.lifetime.setsDone}</b> {dash.lifetime.setsDone === 1 ? "set" : "sets"} logged since{" "}
        {new Date(started).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</>
    : "nothing logged yet";

  return (
    <>
      <h1>Workout stack</h1>
      <p className="lede">
        A set every {dash.settings.intervalMinutes} minutes, {dash.settings.quietEnd} to{" "}
        {dash.settings.quietStart} local, answered here within {dash.settings.responseMinutes} minutes.
      </p>

      <div className="hero">
        <div className="hero-main">
          <span className="label">Lifetime reps</span>
          <div className="hero-num">{thousands(dash.lifetime.totalReps)}</div>
          <div className="hero-sub">{heroSub}</div>
        </div>
        <div className="hero-ex">
          <div className="exscroll">
            {dash.lifetime.exercises.map((exercise) => (
              <div className="excell" key={exercise.id}>
                <span className="nm">
                  {exercise.name}
                  {exercise.retired ? <span className="gone">retired</span> : null}
                </span>
                <span className="num">{thousands(exercise.reps)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="dash">
        <div className="main">
          <section className="band">
            <div className={`cell${open ? " live" : ""}`}>
              <div className="chead">
                <span className="label">{open ? "Round ends in" : "Next set in"}</span>
                <span className="label">
                  {open
                    ? "not logged"
                    : dash.nextSet?.deferred
                      ? "quiet hours"
                      : dash.clock.bonus
                        ? `stack plus ${dash.clock.bonus}`
                        : "base stack"}
                </span>
              </div>
              <div className="clockrow">
                <div className="clock">{clock(secondsLeft)}</div>
                {/* a missed round can still be logged, it just counts as late */}
                <button
                  className="mark"
                  type="button"
                  onClick={onConfirm}
                  disabled={busy || !(current && (current.status === "pending" || current.status === "missed"))}
                >
                  Mark done
                </button>
              </div>
              <div className="track"><span style={{ width: `${pct}%` }} /></div>
              <div className="cmeta">
                {open ? (
                  <>sent {current?.localSent}, window {dash.settings.responseMinutes} min</>
                ) : dash.nextSet ? (
                  dash.nextSet.deferred ? `held until ${dash.nextSet.local}` : `lands at ${dash.nextSet.local}`
                ) : "not scheduled"}
              </div>
            </div>
            <div className="cell now">
              <div>
                <div className="chead">
                  <span className="label status">{open ? "On the clock" : "Assignment"}</span>
                  <span className="tick">
                    {open ? `sent ${current?.localSent ?? ""}` : dash.nextSet ? `next ${dash.nextSet.local}` : ""}
                  </span>
                </div>
                <div className="set">
                  {open && current
                    ? assignmentItems(
                        current.items.map((i) => ({
                          id: i.exerciseSlug, name: i.exerciseName, reps: i.reps,
                          formUrl: dash.settings.exercises.find((e) => e.id === i.exerciseSlug)?.formUrl ?? null,
                        })),
                        true,
                      )
                    : assignmentItems(dash.nextAssignment, false)}
                </div>
              </div>
              <div className="chead">
                <span className="label">
                  {dash.selection.deload ? "deload — every group is near capacity" : ""}
                </span>
                {dash.checkinTodo.due === "post" ? (
                  <button className="mark" type="button" onClick={onOpenPost}>Log the set</button>
                ) : null}
              </div>
            </div>
          </section>

          {checkin}

          <section className="block">
            <div className="block-head">
              <span className="label">Muscles</span>
              <span className="label">
                stop {Math.round(dash.muscles[0]?.stopAt ?? 80)}
              </span>
            </div>
            <div className="mwrap">
              <div className="muscles" onMouseLeave={() => setActive(null)}>
                {[...dash.muscles]
                  .sort((a, b) => a.sort - b.sort)
                  .map((muscle) => (
                    <MuscleRow
                      key={muscle.slug}
                      muscle={muscle}
                      ready={dash.readiness.score}
                      onHover={setActive}
                    />
                  ))}
              </div>
              <Atlas active={active} />
            </div>
          </section>

          <section className="block">
            <div className="block-head">
              <span className="label">Profile</span>
              <span className="label">
                {dash.profile.calibration.n ? `${dash.profile.calibration.n} observations` : "no answers yet"}
              </span>
            </div>
            {([
              ["Recovery", "wear_half_life", " h"],
              ["Readiness", "readiness_influence", ""],
              ["Ceiling", "stop_base", ""],
            ] as const).map(([label, key, unit]) => {
              const param = dash.profile.params.find((p) => p.key === key);
              if (!param) return null;
              return (
                <div className="prow" key={key}>
                  <span className="pl">{label}</span>
                  <span className="pv">{param.value}{unit}</span>
                  <span className="pn">{param.fitted ? `${param.n} obs` : "prior"}</span>
                </div>
              );
            })}
            <div className="prow">
              <span className="pl">Error</span>
              <span className="pv">{dash.profile.calibration.mae ?? "—"}</span>
              <span className="spark">
                {(() => {
                  const series = dash.profile.calibration.series;
                  const max = Math.max(1, ...series.map((s) => s.error));
                  return series.map((point) => (
                    <i key={point.checkin} style={{ height: `${Math.max(8, (point.error / max) * 100)}%` }} />
                  ));
                })()}
              </span>
            </div>
          </section>

          <section className="block">
            <div className="block-head">
              <span className="label">Activity</span>
              <span className="label">last 12 months</span>
            </div>
            <YearCalendar
              calendar={dash.calendar}
              dayScale={Math.max(1, dash.months.roundsPerDay * dash.months.baseReps)}
            />
          </section>

          <section className="block">
            <div className="block-head">
              <span className="label">Recent</span>
              <span className="label">
                {dash.lifetime.setsDone} logged, {dash.lifetime.setsMissed} missed
              </span>
            </div>
            {dash.recentRounds.length === 0
              ? <div className="empty">Nothing yet. The first set will show up here once it lands.</div>
              : dash.recentRounds.slice(0, 6).map((round) => {
                const words: Record<string, string> = { missed: "missed", done: "logged", late: "logged late" };
                return (
                  <div className="rrow" key={round.roundKey}>
                    <span className="t">{round.day} {round.local}</span>
                    <span className="what">
                      {round.exercises.map((item) => (
                        <span key={item.name}><b>{item.reps}</b> {item.name} </span>
                      ))}
                    </span>
                    <span className={`res${round.status === "missed" ? " missed" : ""}`}>
                      {words[round.status] ?? round.status}
                    </span>
                  </div>
                );
              })}
          </section>
        </div>

        <aside className="rail">
          <span className="label">
            {dash.months.current.label} {dash.months.current.year}
          </span>
          <div className="gauge">
            <span className="pct">
              {(() => {
                const pct = dash.months.current.ratio * 100;
                return `${pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
              })()}
            </span>
            <i style={{ height: `max(2px, ${Math.min(100, dash.months.current.ratio * 100)}%)` }} />
          </div>
          <div className="gauge-meta">
            <b>{thousands(dash.months.current.reps)}</b> of {thousands(dash.months.current.target)} reps
          </div>
          <div className="mhist">
            {dash.months.history.map((month) => (
              <div className={`mrow${month.current ? " now" : ""}`} key={month.month}>
                <span className="m">{month.label}</span>
                <span className="bar"><i style={{ width: `${Math.min(100, month.ratio * 100)}%` }} /></span>
                <span className="v">{month.reps ? thousands(month.reps) : "–"}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <footer>
        No sets between <span>{dash.settings.quietStart} and {dash.settings.quietEnd}</span>, and a
        penalty earned at night is still there in the morning. Answering after the window logs the set
        but adds two reps instead of one.
      </footer>
    </>
  );
}
