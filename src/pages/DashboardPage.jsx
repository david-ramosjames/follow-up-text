import { AlertTriangle, CheckCircle2, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AppNav from "../components/AppNav";
import { DailyChart, SequenceBars, StatTile, StepBars, useInterval } from "../components/charts";
import { api, formatWhen } from "../lib/api";
import { formatPhone } from "../../shared/messaging";

const RANGES = [7, 30, 90];

function percent(part, whole) {
  const total = Number(whole) || 0;
  if (!total) return "—";
  return `${Math.round((Number(part) / total) * 100)}%`;
}

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [ranResult, setRanResult] = useState(null);
  const [openSequence, setOpenSequence] = useState(null);

  const load = useCallback(async (nextDays = days) => {
    try {
      setData(await api.get(`/dashboard?days=${nextDays}`));
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  }, [days]);

  useEffect(() => { load(days); }, [days, load]);
  // The dashboard is something people leave open on a second screen, so keep it
  // current without making them reload.
  useInterval(() => load(days), 60_000);

  const runNow = async () => {
    setRunning(true);
    setRanResult(null);
    try {
      const result = await api.post("/dispatch/run");
      setRanResult(result);
      await load(days);
    } catch (runError) {
      setError(runError.message);
    } finally {
      setRunning(false);
    }
  };

  if (status === "loading") return <main className="page-state">Loading…</main>;

  const totals = data?.totals ?? {};
  const health = data?.health ?? {};

  const warnings = [];
  if (!health.quoConfigured) warnings.push("QUO_API_KEY is not set, so no texts can be sent.");
  if (!health.slackConfigured) warnings.push("No Slack bot token, so the start form and thread notifications are off.");
  if (!health.numbers) warnings.push("No Quo numbers have been synced yet — do it under Settings.");
  if (!health.sequencesReady) warnings.push("No sequence is switched on with at least one text in it.");
  if (!health.operators) warnings.push("Nobody is on the operator list, so nobody can start a series from Slack.");

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Overview</p>
            <h1>Dashboard</h1>
            <p>How the follow-up texts are doing over the last {days} days.</p>
          </div>
          <div className="heading-actions">
            <div className="tabs compact">
              {RANGES.map((range) => (
                <button
                  key={range}
                  type="button"
                  className={days === range ? "active" : ""}
                  onClick={() => setDays(range)}
                >
                  {range} days
                </button>
              ))}
            </div>
            <button type="button" className="button ghost" onClick={runNow} disabled={running}>
              {running ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              {running ? "Sending…" : "Send due texts now"}
            </button>
          </div>
        </header>

        {error && <p className="form-error">{error}</p>}

        {ranResult && (
          <p className="form-ok">
            {ranResult.claimed
              ? `Sent ${ranResult.sent} of ${ranResult.claimed} due texts${ranResult.failed ? `, ${ranResult.failed} failed` : ""}.`
              : "Nothing was due."}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="warning-panel">
            <h2><AlertTriangle size={15} /> Needs attention before this can send</h2>
            <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </div>
        )}

        <div className="stat-row">
          <StatTile label="Running now" value={Number(totals.active ?? 0)} detail={`${totals.started ?? 0} started in ${days} days`} />
          <StatTile
            label="Clients who came back"
            value={Number(totals.reengaged ?? 0)}
            detail={`${percent(totals.reengaged, totals.started)} of series started`}
            tone="good"
          />
          <StatTile
            label="Texts sent"
            value={Number(totals.sent ?? 0)}
            detail={`${totals.segments ?? 0} billable segments`}
          />
          <StatTile
            label="Opted out"
            value={Number(totals.opted_out ?? 0)}
            detail="all time, across every sequence"
            tone={Number(totals.opted_out) > 0 ? "warn" : "neutral"}
          />
        </div>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>Texts out, replies in</h2>
              <p>Replies are the point. A day with sends and no replies is worth looking at.</p>
            </div>
          </header>
          <DailyChart data={data?.daily ?? []} />
        </section>

        <section className="panel">
          <header className="panel-head">
            <div>
              <h2>How each sequence performs</h2>
              <p>
                Share of series that ended because the client replied or called back — the only
                outcome that matters.
              </p>
            </div>
            <Link to="/sequences" className="panel-link">Edit sequences</Link>
          </header>
          <SequenceBars sequences={data?.bySequence ?? []} />

          {(data?.bySequence ?? []).filter((row) => Number(row.started) > 0).length > 0 && (
            <div className="step-detail">
              <div className="tabs compact">
                {(data?.bySequence ?? []).filter((row) => Number(row.started) > 0).map((row) => (
                  <button
                    key={row.slug}
                    type="button"
                    className={openSequence === row.slug ? "active" : ""}
                    onClick={() => setOpenSequence(openSequence === row.slug ? null : row.slug)}
                  >
                    {row.name}
                  </button>
                ))}
              </div>
              {openSequence && (
                <>
                  <p className="panel-note">Texts sent at each step. A step that sends far fewer
                    than the one before it is where people are dropping out — usually the right
                    place to shorten the sequence.</p>
                  <StepBars steps={data?.byStep ?? []} sequenceSlug={openSequence} />
                </>
              )}
            </div>
          )}
        </section>

        <div className="panel-grid">
          <section className="panel">
            <header className="panel-head"><div><h2>Going out next</h2></div></header>
            {(data?.upcoming ?? []).length === 0
              ? <p className="panel-note">Nothing is queued.</p>
              : (
                <ul className="upcoming">
                  {data.upcoming.map((row) => (
                    <li key={row.id}>
                      <div>
                        <strong>{row.first_name || formatPhone(row.phone_e164)}</strong>
                        <small>{row.sequence_name} · text {row.next_position}</small>
                      </div>
                      <time>{formatWhen(row.next_run_at, row.timezone)}</time>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section className="panel">
            <header className="panel-head"><div><h2>Outcomes in this period</h2></div></header>
            <table className="mini-table">
              <tbody>
                <tr><th>Came back to us</th><td>{totals.reengaged ?? 0}</td></tr>
                <tr><th>Ran out with no reply</th><td>{totals.completed ?? 0}</td></tr>
                <tr><th>Opted out</th><td>{totals.opted_out ?? 0}</td></tr>
                <tr><th>Texts that never arrived</th><td>{totals.undelivered ?? 0}</td></tr>
                <tr><th>Series that gave up</th><td>{totals.failed ?? 0}</td></tr>
              </tbody>
            </table>
            <p className="panel-note">
              {Number(totals.undelivered) > 0
                ? "Texts that never arrived are usually landlines, or a number that is not registered for A2P — see Help."
                : "Everything sent in this period was accepted by the carrier."}
            </p>
          </section>
        </div>

        <section className="panel health">
          <header className="panel-head"><div><h2>System check</h2></div></header>
          <ul className="health-list">
            <li className={health.quoConfigured ? "ok" : "bad"}>
              {health.quoConfigured ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              Quo API key {health.quoConfigured ? "is set" : "is missing"}
            </li>
            <li className={health.numbers ? "ok" : "bad"}>
              {health.numbers ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {health.numbers} Quo number{health.numbers === 1 ? "" : "s"} available
            </li>
            <li className={health.slackConfigured ? "ok" : "bad"}>
              {health.slackConfigured ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              Slack bot token {health.slackConfigured ? "is set" : "is missing"}
            </li>
            <li className={health.sequencesReady ? "ok" : "bad"}>
              {health.sequencesReady ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {health.sequencesReady} sequence{health.sequencesReady === 1 ? "" : "s"} ready to send
            </li>
            <li className={health.operators ? "ok" : "bad"}>
              {health.operators ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {health.operators} operator{health.operators === 1 ? "" : "s"} can start a series
            </li>
            <li className="ok">
              <CheckCircle2 size={14} />
              Last text sent {health.lastSendAt ? formatWhen(health.lastSendAt) : "never"}
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
