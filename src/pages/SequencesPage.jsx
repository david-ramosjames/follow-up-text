import { CheckCircle2, Copy, Download, Edit3, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AppNav from "../components/AppNav";
import { useFirm } from "../components/Firm";
import { api, slugify } from "../lib/api";
import { describeDelay } from "../../shared/messaging";

export default function SequencesPage() {
  const navigate = useNavigate();
  const firm = useFirm();
  const otherFirms = (firm?.firms ?? []).filter((item) => item.id !== firm?.current?.id);
  const [sequences, setSequences] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [status, setStatus] = useState("loading");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState("");
  const [error, setError] = useState("");
  const [importNote, setImportNote] = useState("");
  const [sourceFirmId, setSourceFirmId] = useState("");
  const [catalog, setCatalog] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [catalogStatus, setCatalogStatus] = useState("idle");
  const [importing, setImporting] = useState(false);
  const sequencesRef = useRef(sequences);
  sequencesRef.current = sequences;

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

  useEffect(() => {
    if (!sourceFirmId) {
      setCatalog([]);
      setSelectedIds(new Set());
      setCatalogStatus("idle");
      return undefined;
    }
    let cancelled = false;
    setCatalogStatus("loading");
    api.get(`/firms/${sourceFirmId}/sequences`)
      .then((list) => {
        if (cancelled) return;
        const taken = new Set(sequencesRef.current.map((sequence) => sequence.slug));
        setCatalog(list);
        setSelectedIds(new Set(list.filter((row) => !taken.has(row.slug)).map((row) => row.id)));
        setCatalogStatus("ready");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError.message);
        setCatalogStatus("error");
      });
    return () => { cancelled = true; };
  }, [sourceFirmId]);

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

  const importSequences = async (event) => {
    event.preventDefault();
    if (!sourceFirmId || importableIds.length === 0) return;
    setImporting(true);
    setError("");
    setImportNote("");
    try {
      const result = await api.post("/sequences/import", {
        source_firm_id: sourceFirmId,
        sequence_ids: importableIds,
      });
      const n = result.imported?.length ?? 0;
      const skip = result.skipped?.length ?? 0;
      const bits = [];
      if (n) bits.push(`Imported ${n} sequence${n === 1 ? "" : "s"}, switched off.`);
      if (skip) bits.push(`${skip} skipped because this firm already has that short name.`);
      setImportNote(bits.join(" ") || "Nothing to import.");
      const importedSlugs = new Set((result.imported ?? []).map((row) => row.slug));
      const skippedIds = new Set((result.skipped ?? []).map((row) => row.id));
      setSelectedIds((current) => new Set([...current].filter((id) => {
        if (skippedIds.has(id)) return false;
        const row = catalog.find((item) => item.id === id);
        return row && !importedSlugs.has(row.slug);
      })));
      await refresh();
    } catch (importError) {
      setError(importError.message);
    } finally {
      setImporting(false);
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

  const takenSlugs = new Set(sequences.map((sequence) => sequence.slug));
  const importableIds = [...selectedIds].filter((id) => {
    const row = catalog.find((item) => item.id === id);
    return row && !takenSlugs.has(row.slug);
  });

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

        {otherFirms.length > 0 && (
          <form className="import-panel" onSubmit={importSequences}>
            <h2>Import from another firm</h2>
            <p>
              Copies keep the same short names so the lead router still recognises
              qualified-lead and referral. They start switched off. This firm’s sending
              number is not filled in — pick one before you turn sending on.
            </p>
            <label>
              <span>Copy from</span>
              <select
                value={sourceFirmId}
                onChange={(event) => setSourceFirmId(event.target.value)}
              >
                <option value="">Choose a firm</option>
                {otherFirms.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            {catalogStatus === "loading" && <p className="inline-note">Loading their sequences…</p>}
            {catalogStatus === "ready" && catalog.length === 0 && (
              <p className="inline-note">That firm has no sequences yet.</p>
            )}
            {catalog.length > 0 && (
              <div className="import-picker">
                {catalog.map((row) => {
                  const taken = takenSlugs.has(row.slug);
                  return (
                    <label key={row.id} className="checkbox">
                      <input
                        type="checkbox"
                        disabled={taken}
                        checked={!taken && selectedIds.has(row.id)}
                        onChange={(event) => {
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        <strong>{row.name}</strong>
                        <small>
                          {row.slug}
                          {row.step_count != null ? ` · ${row.step_count} text${row.step_count === 1 ? "" : "s"}` : ""}
                          {taken ? " · already here" : ""}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <button
              type="submit"
              className="button"
              disabled={importing || !sourceFirmId || importableIds.length === 0}
            >
              <Download size={16} /> {importing ? "Importing…" : "Import"}
            </button>
          </form>
        )}

        {importNote && <p className="form-ok">{importNote}</p>}
        {error && <p className="form-error">{error}</p>}
        {status === "loading" && <div className="page-state">Loading…</div>}

        {status === "ready" && sequences.length === 0 && (
          <div className="empty-state">
            <h2>No sequences yet</h2>
            <p>
              Create one above, write the texts and timings, then switch it on.
              {otherFirms.length > 0 ? " Or import copies from another firm." : ""}
            </p>
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
