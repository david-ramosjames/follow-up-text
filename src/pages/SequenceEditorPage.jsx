import { ArrowLeft, ChevronDown, ChevronUp, Moon, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import AppNav from "../components/AppNav";
import EmojiField from "../components/EmojiField";
import { api, DAY_NAMES, TIMEZONES } from "../lib/api";
import { DELAY_PRESETS, describeDelay, hasEmoji, MERGE_FIELDS, previewStep } from "../../shared/messaging";

const SAMPLE = {
  first_name: "Maria",
  last_name: "Alvarez",
  case_reference: "MVA-2026-118",
  assigned_user: "Sam",
  firm_name: "the firm",
};

// 24-hour labels were a trap: picking "05:00" for five in the afternoon saves an
// end hour of 5, which is before the 9am start, and the database rightly refuses
// it. Nobody in a Texas law office thinks in 24-hour time, so neither does this.
function hourLabel(hour) {
  if (hour === 0 || hour === 24) return "Midnight";
  if (hour === 12) return "Noon";
  return `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? "AM" : "PM"}`;
}

function StepCard({ step, index, total, sequence, onChange, onMove, onRemove, language }) {
  const preview = previewStep(step, {
    language,
    isFirst: index === 0,
    appendNotice: sequence.append_opt_out_notice,
    vars: SAMPLE,
  });
  const empty = !(language === "es" ? step.body_es : step.body_en)?.trim();

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
          <EmojiField
            value={step.body_en}
            onChange={(body_en) => onChange(step, { body_en })}
            placeholder="Hi {{first_name}}, this is the firm following up about your accident."
          />
        </label>
        <label>
          <span>Spanish</span>
          <EmojiField
            value={step.body_es}
            onChange={(body_es) => onChange(step, { body_es })}
            placeholder="Hola {{first_name}}, le escribimos del bufete sobre su accidente."
          />
        </label>
      </div>

      {/* Only worth the space on a text that can actually go out at night, which
          in practice is the first one of a sequence that answers immediately. */}
      {(index === 0 || step.body_en_night || step.body_es_night) && (
        <details className="night-copy" open={Boolean(step.body_en_night || step.body_es_night)}>
          <summary>
            <Moon size={13} /> Different wording at night
            {!step.body_en_night && !step.body_es_night && <span> — optional</span>}
          </summary>
          <p>
            Used instead of the copy above when the text goes out during the night hours set
            under Settings, judged by the client's clock. Leave either box empty to use the
            usual wording at any hour. “We just received your message” is the sort of line
            that needs this.
          </p>
          <div className="body-grid">
            <label>
              <span>English at night</span>
              <EmojiField
                value={step.body_en_night || ""}
                onChange={(body_en_night) => onChange(step, { body_en_night })}
                rows={3}
                placeholder="Hi {{first_name}}, we have your message and will call you in the morning."
              />
            </label>
            <label>
              <span>Spanish at night</span>
              <EmojiField
                value={step.body_es_night || ""}
                onChange={(body_es_night) => onChange(step, { body_es_night })}
                rows={3}
                placeholder="Hola {{first_name}}, recibimos su mensaje y le llamamos por la mañana."
              />
            </label>
          </div>
        </details>
      )}

      <div className={`preview ${preview.segments > 1 ? "warn" : ""}`}>
        <p className="preview-label">
          On the client's phone
          {index === 0 && sequence.append_opt_out_notice && " — the opt-out line is added automatically"}
        </p>
        {empty
          ? <p className="preview-empty">No {language === "es" ? "Spanish" : "English"} copy yet.</p>
          : <p className="preview-body">{preview.body}</p>}
        <p className="preview-meta">
          {preview.characters} of {preview.encoding === "UCS-2" ? 70 : 160} characters ·
          {" "}{preview.encoding} · {preview.segments} segment{preview.segments === 1 ? "" : "s"}
          {preview.segments > 1 && " — this bills as more than one text"}
        </p>
        {/* Naming the encoding is not an explanation. An emoji costs two of the
            seventy, and it is the emoji rather than the accents that surprises
            people, so say which one did it. */}
        {preview.encoding === "UCS-2" && (
          <p className="preview-note">
            {hasEmoji(preview.body)
              ? "An emoji puts this message in UCS-2: 70 characters per segment instead of 160, and each emoji counts as two of them. Worth it for a first text, expensive on all six."
              : "An accent outside the GSM-7 set (á, í, ó, ú — but not é or ñ) puts this in UCS-2: 70 characters per segment instead of 160."}
          </p>
        )}
      </div>
    </article>
  );
}

export default function SequenceEditorPage() {
  const { slug } = useParams();
  const [sequence, setSequence] = useState(null);
  const [steps, setSteps] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [status, setStatus] = useState("loading");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [language, setLanguage] = useState("en");

  useEffect(() => {
    Promise.all([api.get(`/sequences/${slug}`), api.get("/quo-numbers")])
      .then(([data, numberData]) => {
        setSequence(data);
        setSteps(data.steps ?? []);
        setNumbers(numberData);
        setStatus("ready");
      })
      .catch((loadError) => {
        setError(loadError.message);
        setStatus(loadError.message.includes("No such") ? "missing" : "error");
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
    setSteps((current) => current.map((item) => (item.id === step.id ? { ...item, ...values } : item)));
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
      const created = await api.post(`/sequences/${sequence.id}/steps`);
      setSteps((current) => [...current, created]);
    } catch (createError) {
      setError(createError.message);
    }
  };

  const removeStep = async (step) => {
    if (!window.confirm("Delete this text?")) return;
    setError("");
    try {
      await api.delete(`/steps/${step.id}`);
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
      if (sequence.is_active && !steps.some((step) => step.is_active)) {
        throw new Error("This sequence is switched on but has no texts in it. Add at least one, or switch it off.");
      }

      const updated = await api.put(`/sequences/${sequence.id}/steps`, { steps });
      await api.patch(`/sequences/${sequence.id}`, {
        name: sequence.name,
        description: sequence.description || null,
        is_active: sequence.is_active,
        quo_number_id: sequence.quo_number_id || null,
        timezone: sequence.timezone,
        quiet_hours_start: sequence.quiet_hours_start,
        quiet_hours_end: sequence.quiet_hours_end,
        send_days: sequence.send_days,
        append_opt_out_notice: sequence.append_opt_out_notice,
        respond_immediately: Boolean(sequence.respond_immediately),
        auto_routable: Boolean(sequence.auto_routable),
      });

      setSteps(updated.steps ?? []);
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

  if (status === "loading") return <main className="page-state">Loading…</main>;
  if (status === "missing") {
    return (
      <main className="page">
        <div className="shell">
          <AppNav />
          <div className="empty-state">
            <h2>That sequence does not exist</h2>
            <Link to="/sequences">Back to sequences</Link>
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
          <Link to="/sequences"><ArrowLeft size={15} /> All sequences</Link>
          <div>
            {dirty && <span className="unsaved">Unsaved changes</span>}
            <button type="button" className="button primary" onClick={save} disabled={saving || !dirty}>
              <Save size={15} /> {saving ? "Saving…" : "Save"}
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
            <p>Which Quo number the texts come from, and when they may go out.</p>
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
                <small>
                  Paralegals can only start a series on a sequence that is switched on. Switching it
                  off also holds any series already running on it.
                </small>
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

            <label className="wide">
              <span>Send from</span>
              <select
                value={sequence.quo_number_id || ""}
                onChange={(event) => updateSequence({ quo_number_id: event.target.value || null })}
              >
                <option value="">Use the default number from Settings</option>
                {numbers.map((number) => (
                  <option key={number.id} value={number.id} disabled={!number.is_active}>
                    {number.label ? `${number.label} — ${number.phone_e164}` : number.phone_e164}
                    {number.is_active ? "" : " (no longer in Quo)"}
                  </option>
                ))}
              </select>
              {numbers.length === 0 && (
                <small className="field-note">
                  No numbers yet. Sync them from Quo under <Link to="/settings">Settings</Link>.
                </small>
              )}
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

            {/* Each list is bounded by the other, so an end before the start is
                not a mistake you can make and then have rejected on save. */}
            <div className="hours">
              <label>
                <span>Earliest</span>
                <select
                  value={sequence.quiet_hours_start}
                  onChange={(event) => updateSequence({ quiet_hours_start: Number(event.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => hour)
                    .filter((hour) => hour < sequence.quiet_hours_end)
                    .map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                </select>
              </label>
              <label>
                <span>Latest</span>
                <select
                  value={sequence.quiet_hours_end}
                  onChange={(event) => updateSequence({ quiet_hours_end: Number(event.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, hour) => hour + 1)
                    .filter((hour) => hour > sequence.quiet_hours_start)
                    .map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
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
                A text that comes due outside this window waits for the next opening rather than
                being skipped. Federal and Texas rules both measure this against the client's local
                time, which is why the timezone matters.
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
                <small>Appends “Reply STOP to opt out.” (or the Spanish version) to the first text only.</small>
              </span>
            </label>

            <label className="checkbox wide">
              <input
                type="checkbox"
                checked={Boolean(sequence.auto_routable)}
                onChange={(event) => updateSequence({ auto_routable: event.target.checked })}
              />
              <span>
                <strong>Offer this sequence to the lead router</strong>
                <small>
                  Makes this a track the router can choose for an incoming form fill. The
                  name and description above are what it reads to decide, so write them for a
                  stranger — “Another lawyer or firm referring a case, not an injured person”
                  is what separates a referral track from a client one. Leave it off for
                  sequences a person should start by hand.
                </small>
              </span>
            </label>

            <label className="checkbox wide">
              <input
                type="checkbox"
                checked={Boolean(sequence.respond_immediately)}
                onChange={(event) => updateSequence({ respond_immediately: event.target.checked })}
              />
              <span>
                <strong>Answer immediately, whatever the hour</strong>
                <small>
                  For sequences that reply to a form the person filled in seconds ago, where
                  waiting until 9am is the wrong answer. The <em>first</em> text ignores the
                  window above; every later text still respects it. Give text 1 night wording
                  so a 3am reply reads properly.
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
                  className={language === value ? "on" : ""}
                  onClick={() => setLanguage(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            {steps.length === 0 && <p className="empty-inline">No texts yet. Add the first one below.</p>}

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
                language={language}
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
