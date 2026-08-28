import { ArrowLeft, ChevronDown, ChevronUp, Copy, Languages, Moon, Plus, Save, Split, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import AppNav from "../components/AppNav";
import EmojiField from "../components/EmojiField";
import { api, DAY_NAMES, TIMEZONES } from "../lib/api";
import { DELAY_PRESETS, clockHourLabel, describeDelay, hasEmoji, MERGE_FIELDS, nightEndHours, nightStartHours, parseCaseTypePhrases, previewStep, sendingWindowHours } from "../../shared/messaging";

function sampleVars(firmName) {
  return {
    first_name: "Maria",
    last_name: "Alvarez",
    case_reference: "MVA-2026-118",
    case_type: "slip and fall",
    assigned_user: "Sam",
    firm_name: String(firmName ?? "").trim(),
  };
}

// 24-hour labels were a trap: picking "05:00" for five in the afternoon saves an
// end hour of 5, which is before the 9am start, and the database rightly refuses
// it. Nobody in a Texas law office thinks in 24-hour time, so neither does this.
const hourLabel = clockHourLabel;

function TranslateFromEnglish({ disabled, busy, title, onClick }) {
  return (
    <button
      type="button"
      className="translate-btn"
      disabled={disabled || busy}
      title={title}
      onClick={onClick}
    >
      <Languages size={13} />
      {busy ? "Translating…" : "Translate from English"}
    </button>
  );
}

function CaseTypePhrases({ value, onChange }) {
  const phrases = parseCaseTypePhrases(value);
  const [draft, setDraft] = useState("");

  const add = (raw) => {
    const next = parseCaseTypePhrases([...phrases, raw]);
    if (next.length === phrases.length) {
      setDraft("");
      return;
    }
    onChange(next);
    setDraft("");
  };

  return (
    <div className="phrase-chips">
      {phrases.map((phrase) => (
        <span className="chip" key={phrase.toLowerCase()}>
          {phrase}
          <button
            type="button"
            title={`Remove ${phrase}`}
            onClick={() => onChange(phrases.filter((item) => item !== phrase))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={phrases.length ? "Add another" : "wrongful death"}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => { if (draft.trim()) add(draft); }}
      />
    </div>
  );
}

function StepCard({
  step, index, total, sequence, onChange, onMove, onRemove, language,
  firmName, canTranslate, translating, onTranslate,
}) {
  const [previewNight, setPreviewNight] = useState(false);
  const [previewAlt, setPreviewAlt] = useState(false);
  const nightStart = Number(sequence.night_starts_hour ?? 21);
  const nightEnd = Number(sequence.night_ends_hour ?? 8);
  const altPhrases = parseCaseTypePhrases(step.alt_case_types);
  const hasAlt = Boolean(step.body_en_alt || step.body_es_alt || altPhrases.length);
  const hasNight = Boolean(index === 0 || step.body_en_night || step.body_es_night);
  const previewVars = {
    ...sampleVars(firmName),
    ...(previewAlt && altPhrases[0] ? { case_type: altPhrases[0] } : {}),
  };
  const preview = previewStep(step, {
    language,
    isFirst: index === 0,
    appendNotice: sequence.append_opt_out_notice,
    isNight: previewNight,
    useAlternate: previewAlt,
    vars: previewVars,
  });
  const empty = !(language === "es" ? step.body_es : step.body_en)?.trim();
  const translateTitle = canTranslate
    ? "Replace the Spanish with a translation of the English. You can edit it before saving."
    : "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to translate.";

  return (
    <article className="step-card">
      <header>
        <div>
          <span className="step-number">Text {index + 1}</span>
          <strong>{describeDelay(step.delay_minutes)}</strong>
          {step.label && <span className="step-label">{step.label}</span>}
          {hasAlt && <span className="tag muted">alternate copy</span>}
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
          <span className="field-head">
            Spanish
            <TranslateFromEnglish
              disabled={!canTranslate || !String(step.body_en ?? "").trim()}
              busy={translating === `${step.id}:body_es`}
              title={translateTitle}
              onClick={() => onTranslate(step, "body_en", "body_es")}
            />
          </span>
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
            Used instead of the copy above from {hourLabel(nightStart)} to{" "}
            {hourLabel(nightEnd)} on the client's clock. Those hours only choose
            night wording vs usual wording — they do not send or hold the text.
            Whether text 1 may leave outside Earliest–Latest is{" "}
            <strong>First text goes immediately</strong> above.
            Leave either box empty to use the usual wording at any hour.
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
              <span className="field-head">
                Spanish at night
                <TranslateFromEnglish
                  disabled={!canTranslate || !String(step.body_en_night ?? "").trim()}
                  busy={translating === `${step.id}:body_es_night`}
                  title={translateTitle}
                  onClick={() => onTranslate(step, "body_en_night", "body_es_night")}
                />
              </span>
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

      <details className="night-copy" defaultOpen={hasAlt}>
        <summary>
          <Split size={13} /> Different wording for some case types
          {!hasAlt && <span> — optional</span>}
        </summary>
        <p>
          Used instead of the copy above when the client's case type includes one of
          these phrases — decided when the series starts, from the form or from what
          a paralegal typed. Wrongful death, child abuse, and sexual assault are the
          usual ones. Leave this closed to use the usual wording for every case.
        </p>
        <span className="field-label">Case types that use this wording</span>
        <CaseTypePhrases
          value={step.alt_case_types}
          onChange={(alt_case_types) => onChange(step, { alt_case_types })}
        />
        <div className="body-grid">
          <label>
            <span>English for these cases</span>
            <EmojiField
              value={step.body_en_alt || ""}
              onChange={(body_en_alt) => onChange(step, { body_en_alt })}
              rows={3}
              placeholder="Hi {{first_name}}, we are so sorry for your loss. This is {{firm_name}}."
            />
          </label>
          <label>
            <span className="field-head">
              Spanish for these cases
              <TranslateFromEnglish
                disabled={!canTranslate || !String(step.body_en_alt ?? "").trim()}
                busy={translating === `${step.id}:body_es_alt`}
                title={translateTitle}
                onClick={() => onTranslate(step, "body_en_alt", "body_es_alt")}
              />
            </span>
            <EmojiField
              value={step.body_es_alt || ""}
              onChange={(body_es_alt) => onChange(step, { body_es_alt })}
              rows={3}
              placeholder="Hola {{first_name}}, sentimos mucho su perdida. Le escribimos de {{firm_name}}."
            />
          </label>
        </div>
        {hasNight && (
          <div className="body-grid stacked">
            <label>
              <span>English at night for these cases</span>
              <EmojiField
                value={step.body_en_alt_night || ""}
                onChange={(body_en_alt_night) => onChange(step, { body_en_alt_night })}
                rows={3}
                placeholder="Optional. Leave empty to use the alternate copy above at night too."
              />
            </label>
            <label>
              <span className="field-head">
                Spanish at night for these cases
                <TranslateFromEnglish
                  disabled={!canTranslate || !String(step.body_en_alt_night ?? "").trim()}
                  busy={translating === `${step.id}:body_es_alt_night`}
                  title={translateTitle}
                  onClick={() => onTranslate(step, "body_en_alt_night", "body_es_alt_night")}
                />
              </span>
              <EmojiField
                value={step.body_es_alt_night || ""}
                onChange={(body_es_alt_night) => onChange(step, { body_es_alt_night })}
                rows={3}
                placeholder="Opcional."
              />
            </label>
          </div>
        )}
      </details>

      <div className={`preview ${preview.segments > 1 ? "warn" : ""}`}>
        <p className="preview-label">
          On the client's phone
          {index === 0 && sequence.append_opt_out_notice && " — the opt-out line is added automatically"}
        </p>
        {(index === 0 || step.body_en_night || step.body_es_night) && (
          <div className="preview-toggle tight">
            <span>Show</span>
            <button type="button" className={!previewNight ? "on" : ""} onClick={() => setPreviewNight(false)}>
              Day wording
            </button>
            <button type="button" className={previewNight ? "on" : ""} onClick={() => setPreviewNight(true)}>
              Night wording
            </button>
          </div>
        )}
        {hasAlt && (
          <div className="preview-toggle tight">
            <span>Case</span>
            <button type="button" className={!previewAlt ? "on" : ""} onClick={() => setPreviewAlt(false)}>
              Usual
            </button>
            <button type="button" className={previewAlt ? "on" : ""} onClick={() => setPreviewAlt(true)}>
              {altPhrases[0] ? altPhrases.slice(0, 2).join(", ") : "These case types"}
            </button>
          </div>
        )}
        {empty
          ? <p className="preview-empty">No {language === "es" ? "Spanish" : "English"} copy yet.</p>
          : <p className="preview-body">{preview.body}</p>}
        {previewNight && !preview.usedNight && (
          <p className="preview-note">No night wording yet — showing the usual copy.</p>
        )}
        {previewAlt && !preview.usedAlternate && (
          <p className="preview-note">No alternate wording yet — showing the usual copy.</p>
        )}
        {!String(firmName ?? "").trim() && (
          <p className="preview-note">
            Firm name is not set, so this preview falls back to “our office”. Set it under{" "}
            <Link to="/settings">Settings</Link>.
          </p>
        )}
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
  const navigate = useNavigate();
  const location = useLocation();
  const copied = Boolean(location.state?.duplicated);
  const [sequence, setSequence] = useState(null);
  const [steps, setSteps] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [status, setStatus] = useState("loading");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [language, setLanguage] = useState("en");
  const [firmName, setFirmName] = useState("");
  const [canTranslate, setCanTranslate] = useState(false);
  const [translating, setTranslating] = useState("");

  useEffect(() => {
    setStatus("loading");
    Promise.all([
      api.get(`/sequences/${slug}`),
      api.get("/quo-numbers"),
      api.get("/settings").catch(() => null),
    ])
      .then(([data, numberData, settings]) => {
        setSequence(data);
        setSteps(data.steps ?? []);
        setNumbers(numberData);
        setFirmName(String(settings?.values?.firm_name ?? "").trim());
        setCanTranslate(Boolean(settings?.environment?.leadRouting));
        setDirty(false);
        setSaved(copied
          ? "This is a switched-off copy. Change what you need, then turn it on."
          : "");
        setError("");
        setStatus("ready");
      })
      .catch((loadError) => {
        setError(loadError.message);
        setStatus(loadError.message.includes("No such") ? "missing" : "error");
      });
  }, [slug, copied]);

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

  const translateStep = async (step, source, target) => {
    const english = String(step[source] ?? "").trim();
    if (!english) return;
    setTranslating(`${step.id}:${target}`);
    setError("");
    try {
      const result = await api.post("/translate", { text: english });
      updateStep(step, { [target]: result.spanish });
    } catch (translateError) {
      setError(translateError.message);
    } finally {
      setTranslating("");
    }
  };

  const duplicate = async () => {
    const confirmed = window.confirm(
      dirty
        ? "You have unsaved changes. Duplicate copies the last saved version — not what's on this "
          + "page — as a switched-off sequence. Duplicate anyway?"
        : `Create a switched-off copy of “${sequence.name}”? You can change a few texts, then `
          + "turn it on. People already on this sequence stay on it.",
    );
    if (!confirmed) return;
    setDuplicating(true);
    setError("");
    try {
      const created = await api.post(`/sequences/${sequence.id}/duplicate`);
      navigate(`/sequences/${created.slug}`, { state: { duplicated: true } });
    } catch (duplicateError) {
      setError(duplicateError.message);
    } finally {
      setDuplicating(false);
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
        quiet_hours_start: Number(sequence.quiet_hours_start),
        quiet_hours_end: Number(sequence.quiet_hours_end),
        send_days: sequence.send_days,
        append_opt_out_notice: sequence.append_opt_out_notice,
        respond_immediately: Boolean(sequence.respond_immediately),
        auto_routable: Boolean(sequence.auto_routable),
        night_starts_hour: Number(sequence.night_starts_hour ?? 21),
        night_ends_hour: Number(sequence.night_ends_hour ?? 8),
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
            <button
              type="button"
              className="button ghost"
              onClick={duplicate}
              disabled={duplicating || saving}
            >
              <Copy size={15} /> {duplicating ? "Duplicating…" : "Duplicate"}
            </button>
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
            <p>
              Which Quo number the texts come from, when later texts may send, whether
              the first one goes out immediately, and which copy it uses at night.
            </p>
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
                  Paralegals can only start a series on a sequence that is switched on, and Live
                  will not send on one that is off. Switching it off also holds any series already
                  running. It does not take this sequence off the lead router — that is the box
                  below.
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
              {numbers.length > 0 && (
                <small className="field-note">
                  Usual number for this sequence. A Slack start can still pick a different
                  Quo line for one series — `/followup` lists them by name, or tag the bot
                  with `from` and the line’s Quo name.
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
                <span>Earliest send</span>
                <select
                  value={Number(sequence.quiet_hours_start)}
                  onChange={(event) => updateSequence({ quiet_hours_start: Number(event.target.value) })}
                >
                  {sendingWindowHours()
                    .filter((hour) => hour < 24 && hour < Number(sequence.quiet_hours_end))
                    .map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                </select>
              </label>
              <label>
                <span>Latest send</span>
                <select
                  value={Number(sequence.quiet_hours_end)}
                  onChange={(event) => updateSequence({ quiet_hours_end: Number(event.target.value) })}
                >
                  {sendingWindowHours()
                    .filter((hour) => hour > 0 && hour > Number(sequence.quiet_hours_start))
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
                The overall clock for later texts, in the client's local time. Times are
                in 30-minute steps. The checkbox below can override this for text 1 only.
              </p>
            </div>

            <label className="checkbox wide">
              <input
                type="checkbox"
                checked={Boolean(sequence.respond_immediately)}
                onChange={(event) => updateSequence({ respond_immediately: event.target.checked })}
              />
              <span>
                <strong>First text goes immediately</strong>
                <small>
                  Overrides Earliest–Latest and the days above for text 1 only. A lead at
                  11:00 PM or 8:00 AM is texted now, instead of waiting for{" "}
                  {hourLabel(sequence.quiet_hours_start)}. Every later text still waits
                  for that window.
                </small>
              </span>
            </label>

            <div className="clock-explainer wide">
              <p>
                <strong>
                  Overall clock — {hourLabel(sequence.quiet_hours_start)} to{" "}
                  {hourLabel(sequence.quiet_hours_end)}
                </strong>
                {" "}on the days above. Later texts due outside it wait until{" "}
                {hourLabel(sequence.quiet_hours_start)} the next allowed day. Latest
                send does not pick night wording.
              </p>
              {sequence.respond_immediately ? (
                <p>
                  <strong>Text 1 ignores that clock</strong>, because First text goes
                  immediately is on. From{" "}
                  {hourLabel(Number(sequence.night_starts_hour ?? 21))} to{" "}
                  {hourLabel(Number(sequence.night_ends_hour ?? 8))} it uses night copy;
                  otherwise the usual copy. Set that split below. A 4-hour gap after an
                  11:00 PM first text still becomes {hourLabel(sequence.quiet_hours_start)},
                  not 3:00 AM.
                </p>
              ) : (
                <p>
                  <strong>Text 1 waits for that clock too</strong>, because First text
                  goes immediately is off. Night copy below only appears if the first
                  text actually leaves during those hours — with this window, that
                  usually never happens.
                </p>
              )}
            </div>

            <div className="wide">
              <span className="field-label">Which first text — night vs usual copy</span>
              <div className="hours">
                <label>
                  <span>Night copy from</span>
                  <select
                    value={Number(sequence.night_starts_hour ?? 21)}
                    onChange={(event) => updateSequence({ night_starts_hour: Number(event.target.value) })}
                  >
                    {nightStartHours().map((hour) => (
                      <option key={hour} value={hour}>{hourLabel(hour)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Usual copy from</span>
                  <select
                    value={Number(sequence.night_ends_hour ?? 8)}
                    onChange={(event) => updateSequence({ night_ends_hour: Number(event.target.value) })}
                  >
                    {nightEndHours().map((hour) => (
                      <option key={hour} value={hour}>{hourLabel(hour)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="field-note">
                These hours only choose which wording text 1 uses. They do not send or
                hold anything — that is Earliest–Latest, unless First text goes immediately
                is on. From {hourLabel(Number(sequence.night_starts_hour ?? 21))} until{" "}
                {hourLabel(Number(sequence.night_ends_hour ?? 8))} the first text uses night
                copy; after that it uses the usual copy.
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
                  This is the switch that makes Qualified vs Referral a track. The router
                  still assigns forms here even when the sequence is switched off — Sequence
                  is on (above) only holds sending. The name and description above are what
                  the classifier reads. A form marked Referral or Referal is parsed in code
                  onto a referral track — that means this firm will send the person to
                  another lawyer, not represent them. Leave this off for sequences a person
                  should start by hand.
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
              series starts. A later text can also carry alternate wording for particular case
              types — wrongful death, child abuse, sexual assault — without splitting the sequence.
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
                firmName={firmName}
                canTranslate={canTranslate}
                translating={translating}
                onTranslate={translateStep}
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
