import { ArrowLeft, ChevronDown, ChevronUp, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AppNav from "../components/AppNav";
import {
  createStep,
  DAY_NAMES,
  deleteStep,
  loadSequence,
  reorderSteps,
  saveSequence,
  saveStep,
  TIMEZONES,
} from "../lib/followups";
import { DELAY_PRESETS, describeDelay, MERGE_FIELDS, previewStep } from "../lib/render";

const SAMPLE = { first_name: "Maria", last_name: "Alvarez", case_reference: "MVA-2026-118", assigned_user: "Sam", firm_name: "the firm" };

function StepCard({ step, index, total, sequence, onChange, onMove, onRemove, previewLanguage }) {
  const preview = previewStep(step, {
    language: previewLanguage,
    isFirst: index === 0,
    appendNotice: sequence.append_opt_out_notice,
    vars: SAMPLE,
  });

  const empty = !(previewLanguage === "es" ? step.body_es : step.body_en)?.trim();

  return (
    <article className="step-card">
      <header>
        <div>
          <span className="step-number">Text {index + 1}</span>
          <strong>{describeDelay(step.delay_minutes)}</strong>
          {!step.is_active && <span className="tag muted">skipped</span>}
        </div>
        <div className="step-controls">
          <button type="button" disabled={index === 0} onClick={() => onMove(index, -1)} title="Move earlier">
            <ChevronUp size={15} />
          </button>
          <button type="button" disabled={index === total - 1} onClick={() => onMove(index, 1)} title="Move later">
            <ChevronDown size={15} />
          </button>
          <button type="button" className="danger" onClick={() => onRemove(step)} title="Delete this text">
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <div className="step-grid">
        <label>
          <span>Send</span>
          <select
            value={DELAY_PRESETS.some((preset) => preset.minutes === step.delay_minutes) ? step.delay_minutes : "custom"}
            onChange={(event) => {
              if (event.target.value === "custom") return;
              onChange(step, { delay_minutes: Number(event.target.value) });
            }}
          >
            {DELAY_PRESETS.map((preset) => (
              <option key={preset.minutes} value={preset.minutes}>{preset.label}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>

        <label>
          <span>Or exact minutes</span>
          <input
            type="number"
            min="0"
            value={step.delay_minutes}
            onChange={(event) => onChange(step, { delay_minutes: Math.max(0, Number(event.target.value) || 0) })}
          />
        </label>

        <label>
          <span>Label (internal)</span>
          <input
            value={step.label || ""}
            placeholder="First touch"
            onChange={(event) => onChange(step, { label: event.target.value })}
          />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={step.is_active}
            onChange={(event) => onChange(step, { is_active: event.target.checked })}
          />
          <span>Include this text</span>
        </label>
      </div>

      <div className="body-grid">
        <label>
          <span>English</span>
          <textarea
            rows={4}
            value={step.body_en}
            onChange={(event) => onChange(step, { body_en: event.target.value })}
            placeholder="Hi {{first_name}}, this is the firm following up about your accident."
          />
        </label>
        <label>
          <span>Spanish</span>
          <textarea
            rows={4}
            value={step.body_es}
            onChange={(event) => onChange(step, { body_es: event.target.value })}
            placeholder="Hola {{first_name}}, le escribimos del bufete sobre su accidente."
          />
        </label>
      </div>

      <div className={`preview ${preview.segments > 1 ? "warn" : ""}`}>
        <p className="preview-label">
          On the client's phone
          {index === 0 && sequence.append_opt_out_notice && " — the opt-out line is added automatically"}
        </p>
        {empty
          ? <p className="preview-empty">No {previewLanguage === "es" ? "Spanish" : "English"} copy yet.</p>
          : <p className="preview-body">{preview.body}</p>}
        <p className="preview-meta">
          {preview.characters} characters · {preview.encoding} · {preview.segments} segment
          {preview.segments === 1 ? "" : "s"}
          {preview.segments > 1 && " — this bills as more than one text"}
        </p>
      </div>
    </article>
  );
}

export default function SequenceEditorPage() {
  const { slug } = useParams();
  const [sequence, setSequence] = useState(null);
  const [steps, setSteps] = useState([]);
  const [status, setStatus] = useState("loading");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [previewLanguage, setPreviewLanguage] = useState("en");

  useEffect(() => {
    loadSequence(slug).then((data) => {
      if (!data) { setStatus("missing"); return; }
      setSequence(data);
      setSteps(data.steps);
      setStatus("ready");
    }).catch((loadError) => {
      setError(loadError.message);
      setStatus("error");
    });
  }, [slug]);

  const totalSpan = useMemo(() => {
    const active = steps.filter((step) => step.is_active);
    return active.length ? describeDelay(active[active.length - 1].delay_minutes) : null;
  }, [steps]);

  const updateSequence = (values) => {
    setSequence((current) => ({ ...current, ...values }));
    setDirty(true);
    setSaved("");
  };

  const updateStep = (step, values) => {
    setSteps((current) => current.map((item) => item.id === step.id ? { ...item, ...values } : item));
    setDirty(true);
    setSaved("");
  };

  const moveStep = (index, direction) => {
    setSteps((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
    setSaved("");
  };

  const addStep = async () => {
    setError("");
    try {
      const last = steps[steps.length - 1];
      const created = await createStep(sequence.id, steps.length + 1, {
        delay_minutes: last ? last.delay_minutes + 1440 : 0,
        body_en: "",
        body_es: "",
        // A brand new step has no copy, so it stays out of the rotation until
        // somebody writes it. Saving an empty body would fail the length check.
        is_active: false,
      });
      setSteps((current) => [...current, created]);
    } catch (createError) {
      setError(createError.message);
    }
  };

  const removeStep = async (step) => {
    if (!window.confirm("Delete this text?")) return;
    setError("");
    try {
      await deleteStep(step.id);
      setSteps((current) => current.filter((item) => item.id !== step.id));
      setDirty(true);
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved("");
    try {
      // An active step with no copy would be sent as an empty text, so catch it
      // here rather than letting the database constraint produce a raw error.
      const blank = steps.find((step) => step.is_active && (!step.body_en.trim() || !step.body_es.trim()));
      if (blank) {
        throw new Error(`Text ${steps.indexOf(blank) + 1} is switched on but is missing its `
          + `${!blank.body_en.trim() ? "English" : "Spanish"} copy. Every text needs both, because the `
          + "language is chosen per client when the series starts.");
      }
      if (sequence.is_active && !steps.some((step) => step.is_active)) {
        throw new Error("This sequence is switched on but has no texts in it. Add at least one, or switch it off.");
      }

      await reorderSteps(steps);
      for (const [index, step] of steps.entries()) {
        await saveStep(step.id, {
          position: index + 1,
          label: step.label || null,
          delay_minutes: step.delay_minutes,
          body_en: step.body_en,
          body_es: step.body_es,
          is_active: step.is_active,
        });
      }

      const updated = await saveSequence(sequence.id, {
        name: sequence.name,
        description: sequence.description || null,
        is_active: sequence.is_active,
        quo_from_number: sequence.quo_from_number || null,
        quo_phone_number_id: sequence.quo_phone_number_id || null,
        timezone: sequence.timezone,
        quiet_hours_start: sequence.quiet_hours_start,
        quiet_hours_end: sequence.quiet_hours_end,
        send_days: sequence.send_days,
        append_opt_out_notice: sequence.append_opt_out_notice,
      });

      setSequence(updated);
      setSteps(updated.steps);
      setDirty(false);
      setSaved("Saved. Changes apply to the next text that goes out, including series already running.");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (iso) => {
    const current = sequence.send_days || [];
    const next = current.includes(iso)
      ? current.filter((day) => day !== iso)
      : [...current, iso].sort((a, b) => a - b);
    if (!next.length) return;
    updateSequence({ send_days: next });
  };

  if (status === "loading") return <main className="page-state">Loading...</main>;
  if (status === "missing") {
    return (
      <main className="page">
        <div className="shell">
          <AppNav />
          <div className="empty-state">
            <h2>That sequence does not exist</h2>
            <Link to="/">Back to sequences</Link>
          </div>
        </div>
      </main>
    );
  }
  if (status === "error") return <main className="page-state">{error}</main>;

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <div className="editor-bar">
          <Link to="/"><ArrowLeft size={15} /> All sequences</Link>
          <div>
            {dirty && <span className="unsaved">Unsaved changes</span>}
            <button type="button" onClick={save} disabled={saving || !dirty}>
              <Save size={15} /> {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        <header className="page-heading">
          <div>
            <p className="eyebrow">Sequence</p>
            <input
              className="title-input"
              value={sequence.name}
              onChange={(event) => updateSequence({ name: event.target.value })}
            />
            <p>
              {steps.filter((step) => step.is_active).length} texts
              {totalSpan && ` · last one ${totalSpan}`}
            </p>
          </div>
        </header>

        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-ok">{saved}</p>}

        <section className="editor-section">
          <div>
            <h2>Settings</h2>
            <p>When texts may go out and which Quo number they come from.</p>
          </div>
          <div className="editor-fields">
            <label className="checkbox wide">
              <input
                type="checkbox"
                checked={sequence.is_active}
                onChange={(event) => updateSequence({ is_active: event.target.checked })}
              />
              <span>
                <strong>Sequence is on</strong>
                <small>Paralegals can only start a series on a sequence that is switched on.</small>
              </span>
            </label>

            <label className="wide">
              <span>Description (internal)</span>
              <input
                value={sequence.description || ""}
                onChange={(event) => updateSequence({ description: event.target.value })}
                placeholder="For new MVA leads who filled in the website form but have not answered."
              />
            </label>

            <label>
              <span>Quo number to send from</span>
              <input
                value={sequence.quo_from_number || ""}
                onChange={(event) => updateSequence({ quo_from_number: event.target.value })}
                placeholder="+15125550100"
              />
            </label>

            <label>
              <span>Quo phone number ID (optional)</span>
              <input
                value={sequence.quo_phone_number_id || ""}
                onChange={(event) => updateSequence({ quo_phone_number_id: event.target.value })}
                placeholder="PN..."
              />
            </label>

            <label>
              <span>Client timezone</span>
              <select
                value={sequence.timezone}
                onChange={(event) => updateSequence({ timezone: event.target.value })}
              >
                {TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>

            <div className="hours">
              <label>
                <span>Earliest</span>
                <select
                  value={sequence.quiet_hours_start}
                  onChange={(event) => updateSequence({ quiet_hours_start: Number(event.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Latest</span>
                <select
                  value={sequence.quiet_hours_end}
                  onChange={(event) => updateSequence({ quiet_hours_end: Number(event.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => hour + 1).map((hour) => (
                    <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="wide">
              <span className="field-label">Days texts may go out</span>
              <div className="day-picker">
                {DAY_NAMES.map((day) => (
                  <button
                    key={day.iso}
                    type="button"
                    className={(sequence.send_days || []).includes(day.iso) ? "on" : ""}
                    onClick={() => toggleDay(day.iso)}
                  >
                    {day.short}
                  </button>
                ))}
              </div>
              <p className="field-note">
                A text that comes due outside this window waits for the next opening rather than being
                skipped. Federal and Texas rules both measure this against the client's local time,
                which is why the timezone above matters.
              </p>
            </div>

            <label className="checkbox wide">
              <input
                type="checkbox"
                checked={sequence.append_opt_out_notice}
                onChange={(event) => updateSequence({ append_opt_out_notice: event.target.checked })}
              />
              <span>
                <strong>Add the opt-out line to the first text</strong>
                <small>
                  Appends “Reply STOP to opt out.” (or the Spanish version) to the first text only.
                </small>
              </span>
            </label>
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>The texts</h2>
            <p>
              Every text needs both languages. Which one is sent is chosen per client when the
              series starts.
            </p>
            <div className="merge-help">
              <span className="field-label">Merge fields</span>
              {MERGE_FIELDS.map((field) => (
                <code key={field.token} title={field.label}>{field.token}</code>
              ))}
            </div>
          </div>

          <div className="steps">
            <div className="preview-toggle">
              <span>Preview as</span>
              {[["en", "English"], ["es", "Spanish"]].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={previewLanguage === value ? "on" : ""}
                  onClick={() => setPreviewLanguage(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {steps.length === 0 && (
              <p className="empty-inline">No texts yet. Add the first one below.</p>
            )}

            {steps.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                index={index}
                total={steps.length}
                sequence={sequence}
                onChange={updateStep}
                onMove={moveStep}
                onRemove={removeStep}
                previewLanguage={previewLanguage}
              />
            ))}

            <button type="button" className="add-step" onClick={addStep}>
              <Plus size={16} /> Add a text
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
