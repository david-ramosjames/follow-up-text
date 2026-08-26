import { CheckCircle2, Copy, Edit3, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppNav from "../components/AppNav";
import { api, slugify } from "../lib/api";
import { describeDelay } from "../../shared/messaging";

export default function SequencesPage() {
  const navigate = useNavigate();
  const [sequences, setSequences] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [status, setStatus] = useState("loading");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState("");
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      const [sequenceData, numberData] = await Promise.all([
        api.get("/sequences"),
        api.get("/quo-numbers"),
      ]);
      setSequences(sequenceData);
      setNumbers(numberData);
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  };

  useEffect(() => { refresh(); }, []);

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await api.post("/sequences", { name: name.trim(), slug: slugify(name) });
      navigate(`/sequences/${created.slug}`);
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (sequence) => {
    setError("");
    try {
      await api.post(`/sequences/${sequence.id}/default`);
      await refresh();
    } catch (updateError) {
      setError(updateError.message);
    }
  };

  const duplicate = async (sequence) => {
    const confirmed = window.confirm(
      `Create a switched-off copy of “${sequence.name}”? You can change a few texts, then `
        + "turn it on. People already on this sequence stay on it.",
    );
    if (!confirmed) return;
    setDuplicatingId(sequence.id);
    setError("");
    try {
      const created = await api.post(`/sequences/${sequence.id}/duplicate`);
      navigate(`/sequences/${created.slug}`, { state: { duplicated: true } });
    } catch (duplicateError) {
      setError(duplicateError.message);
    } finally {
      setDuplicatingId("");
    }
  };

  const remove = async (sequence) => {
    const confirmed = window.confirm(
      `Delete “${sequence.name}”? Series already running on it keep their history, but the `
        + "schedule and message copy are gone for good.",
    );
    if (!confirmed) return;
    setError("");
    try {
      await api.delete(`/sequences/${sequence.id}`);
      await refresh();
    } catch (deleteError) {
      setError(deleteError.message.includes("violates foreign key")
        ? "That sequence still has series attached to it. Stop them first, or just switch the sequence off."
        : deleteError.message);
    }
  };

  const numberLabel = (id) => {
    const found = numbers.find((number) => number.id === id);
    if (!found) return id ? "unknown number" : "default";
    return found.label || found.phone_e164;
  };

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Message copy</p>
            <h1>Sequences</h1>
            <p>The schedules paralegals start from Slack.</p>
          </div>
        </header>

        <form className="inline-create" onSubmit={create}>
          <label>
            <span>New sequence</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New MVA lead follow-up"
            />
          </label>
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>
            <Plus size={16} /> {busy ? "Creating…" : "Create"}
          </button>
        </form>
        <p className="inline-note">
          New sequences start switched off, so you can write the texts before anyone can send them.
          Duplicate an existing one if you only need a few changes.
        </p>

        {error && <p className="form-error">{error}</p>}
        {status === "loading" && <div className="page-state">Loading…</div>}

        {status === "ready" && sequences.length === 0 && (
          <div className="empty-state">
            <h2>No sequences yet</h2>
            <p>Create one above, write the texts and timings, then switch it on.</p>
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
                  <th>Sends from</th>
                  <th>Window</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sequences.map((sequence) => {
                  const active = (sequence.steps ?? []).filter((step) => step.is_active);
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
                      <td>{numberLabel(sequence.quo_number_id)}</td>
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
                            <button type="button" onClick={() => makeDefault(sequence)} title="Make this the default">
                              <CheckCircle2 size={16} />
                            </button>
                          )}
                          <Link to={`/sequences/${sequence.slug}`} title="Edit"><Edit3 size={16} /></Link>
                          <button type="button" disabled={Boolean(duplicatingId)} onClick={() => duplicate(sequence)} title="Duplicate">
                            <Copy size={16} />
                          </button>
                          <button type="button" className="danger" onClick={() => remove(sequence)} title="Delete">
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
