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
          <b>{item.reps}</b>
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

function MuscleRow({ muscle, active, onHover }: {
  muscle: Muscle; active: boolean; onHover: (slug: string | null) => void;
}) {
  const classes = ["mrow2"];
  if (muscle.load === 0) classes.push("zero");
  if (muscle.load >= 10) classes.push("warm");
  if (muscle.load >= muscle.stopEffective) classes.push("shut");
  if (active) classes.push("active");
  return (
    <div
      className={classes.join(" ")}
      onMouseEnter={() => onHover(muscle.slug)}
      onMouseLeave={() => onHover(null)}
    >
      <span className="mn">{muscle.name}</span>
      <span className="mbar">
        <i style={{ width: `${Math.min(100, muscle.load)}%` }} />
        <b style={{ left: `${muscle.stopEffective}%` }} />
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

  const heroSub = dash.lifetime.setsDone === 0 && dash.lifetime.totalReps === 0
    ? "nothing logged yet"
    : <><b>{dash.lifetime.setsDone}</b> sets logged · <b>{dash.lifetime.setsMissed}</b> missed</>;

  return (
    <>
      <h1>Workout stack</h1>
      <p className="lede">
        A set every {dash.settings.intervalMinutes} minutes. Confirm inside the{" "}
        {dash.settings.responseMinutes} minute window to drop back to the base reps; silence pushes one
        more rep into the next set.
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
                <span className="label">{open ? "On the clock" : "Next set"}</span>
                <span className="label">{open ? "response window" : "scheduled"}</span>
              </div>
              <div className="clockrow">
                <div className="clock">{clock(secondsLeft)}</div>
                <button className="mark" type="button" onClick={onConfirm} disabled={!open || busy}>
                  Mark done
                </button>
              </div>
              <div className="track"><span style={{ width: `${pct}%` }} /></div>
              <div className="cmeta">
                {open ? (
                  <>sent <b>{current?.localSent}</b> · answer within {dash.settings.responseMinutes}m</>
                ) : dash.nextSet ? (
                  <>at <b>{dash.nextSet.local}</b>{dash.nextSet.deferred ? " · held out of quiet hours" : ""}</>
                ) : "nothing scheduled"}
              </div>
            </div>
            <div className="cell now">
              <div>
                <div className="chead">
                  <span className="label status">{open ? "Assignment" : "Up next"}</span>
                  <span className="tick">{dash.clock.bonus > 0 ? `+${dash.clock.bonus} bonus` : ""}</span>
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
                stop {Math.round(dash.muscles[0]?.stopEffective ?? 80)}
              </span>
            </div>
            <div className="mwrap">
              <div className="muscles">
                {dash.muscles.map((muscle) => (
                  <MuscleRow key={muscle.slug} muscle={muscle} active={active === muscle.slug} onHover={setActive} />
                ))}
              </div>
              <figure className="body">
                <Atlas active={active} />
                <figcaption>Art: Ryan Graves · CC BY 4.0</figcaption>
              </figure>
            </div>
          </section>

          <section className="block">
            <div className="block-head">
              <span className="label">Profile</span>
              <span className="label">
                {dash.profile.calibration.mae === null
                  ? "no calibration yet"
                  : `error ${dash.profile.calibration.mae} · n ${dash.profile.calibration.n}`}
              </span>
            </div>
            {dash.profile.params.map((param) => (
              <div className="prow" key={param.key}>
                <span className="pl">{param.key.replace(/_/g, " ")}</span>
                <span className="pv">{param.value}</span>
                <span className="pn">
                  prior {param.prior} · n {param.n}{param.fitted ? " · fitted" : ""}
                </span>
              </div>
            ))}
          </section>

          <section className="block">
            <div className="block-head">
              <span className="label">Activity</span>
              <span className="label">
                {dash.months.current.reps} / {thousands(dash.months.current.target)} this month
              </span>
            </div>
            <YearCalendar calendar={dash.calendar} />
            <div className="cal-legend"><span>less</span><span>more</span></div>
          </section>

          <section className="block">
            <div className="block-head">
              <span className="label">Recent</span>
              <span className="label">
                {dash.lifetime.setsDone} logged, {dash.lifetime.setsMissed} missed
              </span>
            </div>
            {dash.recentRounds.length === 0
              ? <div className="empty">Nothing yet.</div>
              : dash.recentRounds.map((round) => (
                <div className="rrow" key={round.roundKey}>
                  <span className="t">{round.day} {round.local}</span>
                  <span className="what">
                    {round.exercises.map((item) => (
                      <span key={item.name}><b>{item.reps}</b> {item.name.toLowerCase()} </span>
                    ))}
                  </span>
                  <span className={`res ${round.status}`}>{round.status}</span>
                </div>
              ))}
          </section>
        </div>

        <aside className="rail">
          <span className="label">This month</span>
          <div className="gauge">
            <span className="pct">{Math.round(dash.months.current.ratio * 100)}%</span>
            <i style={{ height: `${Math.min(100, dash.months.current.ratio * 100)}%` }} />
          </div>
          <div className="gauge-meta">
            <b>{thousands(dash.months.current.reps)}</b> / {thousands(dash.months.current.target)}
          </div>
          <div className="mhist">
            {dash.months.history.map((month) => (
              <div className={`mrow${month.current ? " now" : ""}`} key={month.month}>
                <span className="m">{month.label}</span>
                <span className="bar"><i style={{ width: `${Math.min(100, month.ratio * 100)}%` }} /></span>
                <span className="v">{thousands(month.reps)}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
