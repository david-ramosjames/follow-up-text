import { CheckCircle2, Edit3, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppNav from "../components/AppNav";
import {
  createSequence,
  deleteSequence,
  loadOverview,
  loadSequences,
  setDefaultSequence,
  slugify,
} from "../lib/followups";
import { describeDelay } from "../lib/render";

export default function SequencesPage() {
  const navigate = useNavigate();
  const [sequences, setSequences] = useState([]);
  const [overview, setOverview] = useState(null);
  const [status, setStatus] = useState("loading");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => loadSequences().then((data) => {
    setSequences(data);
    setStatus("ready");
  }).catch((loadError) => {
    setError(loadError.message);
    setStatus("error");
  });

  useEffect(() => {
    refresh();
    loadOverview().then(setOverview).catch(() => setOverview(null));
  }, []);

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const sequence = await createSequence({
        slug: slugify(name),
        name: name.trim(),
        is_active: false,
        is_default: sequences.length === 0,
      });
      navigate(`/sequences/${sequence.slug}`);
    } catch (createError) {
      setError(createError.message || "The sequence could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (sequence) => {
    setError("");
    try {
      await setDefaultSequence(sequence.id);
      await refresh();
    } catch (updateError) {
      setError(updateError.message);
    }
  };

  const remove = async (sequence) => {
    const confirmed = window.confirm(
      `Delete “${sequence.name}”? Any series already running on it will keep their history, `
        + "but the schedule and message copy are gone for good.",
    );
    if (!confirmed) return;
    setError("");
    try {
      await deleteSequence(sequence.id);
      await refresh();
    } catch (deleteError) {
      // A sequence with live enrollments is protected by a foreign key.
      setError(deleteError.code === "23503"
        ? "That sequence still has follow-up series attached to it. Stop them first, or just turn the sequence off."
        : deleteError.message);
    }
  };

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Text follow-ups</p>
            <h1>Sequences</h1>
            <p>The schedules paralegals start from Slack with <code>/followup</code>.</p>
          </div>
        </header>

        {overview && (
          <div className="stat-row">
            <div><strong>{overview.active}</strong><span>running now</span></div>
            <div><strong>{overview.sentToday}</strong><span>texts sent today</span></div>
            <div><strong>{overview.repliedToday}</strong><span>replies today</span></div>
            <div><strong>{overview.optedOut}</strong><span>opted out</span></div>
          </div>
        )}

        <form className="inline-create" onSubmit={create}>
          <label>
            <span>New sequence</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New MVA lead follow-up"
            />
          </label>
          <button type="submit" disabled={busy || !name.trim()}>
            <Plus size={16} /> {busy ? "Creating..." : "Create"}
          </button>
        </form>
        <p className="inline-note">
          New sequences start switched off so you can write the texts before anyone can send them.
        </p>

        {error && <p className="form-error">{error}</p>}
        {status === "loading" && <div className="page-state">Loading sequences...</div>}

        {status === "ready" && sequences.length === 0 && (
          <div className="empty-state">
            <h2>No sequences yet</h2>
            <p>Create one above, add the texts and timings, then switch it on.</p>
          </div>
        )}

        {sequences.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sequence</th>
                  <th>Texts</th>
                  <th>Spans</th>
                  <th>Sending window</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sequences.map((sequence) => {
                  const active = sequence.steps.filter((step) => step.is_active);
                  const last = active[active.length - 1];
                  return (
                    <tr key={sequence.id}>
                      <td>
                        <strong>
                          {sequence.name}
                          {sequence.is_default && <span className="tag"><Star size={11} /> default</span>}
                        </strong>
                        <small>{sequence.slug}</small>
                      </td>
                      <td>{active.length}</td>
                      <td>{last ? describeDelay(last.delay_minutes).replace("after ", "") : "—"}</td>
                      <td>
                        {String(sequence.quiet_hours_start).padStart(2, "0")}:00–
                        {String(sequence.quiet_hours_end).padStart(2, "0")}:00
                        <small>{sequence.timezone}</small>
                      </td>
                      <td>
                        <span className={`status-dot ${sequence.is_active ? "on" : "off"}`}>
                          {sequence.is_active ? "On" : "Off"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          {!sequence.is_default && (
                            <button
                              type="button"
                              onClick={() => makeDefault(sequence)}
                              title="Make this the default sequence"
                            >
                              <CheckCircle2 size={16} />
                            </button>
                          )}
                          <Link to={`/sequences/${sequence.slug}`} title="Edit"><Edit3 size={16} /></Link>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => remove(sequence)}
                            title="Delete"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
