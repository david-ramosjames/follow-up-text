import { Smile } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// A short, deliberate list rather than a full emoji keyboard. These are texts
// from a law firm to an injured client: the tone that fits is warm and plain,
// and a picker offering 1,800 options mostly offers ways to strike the wrong
// one. The operating system's own picker is still there for anything else —
// Ctrl+Cmd+Space on a Mac, Win+. on Windows — and typing or pasting works too.
const GROUPS = [
  { label: "Warm", emoji: ["👋", "🙂", "😊", "🙏", "💙", "🤝", "👍", "✨"] },
  // ⚠️ carries its variation selector on purpose: bare U+26A0 renders as a flat
  // monochrome glyph on a lot of handsets, and the yellow sign is the point.
  { label: "Time and urgency", emoji: ["⏳", "⚠️", "⏰", "📅", "❗", "✅"] },
  { label: "Getting in touch", emoji: ["📞", "📱", "💬", "📩"] },
  { label: "The case", emoji: ["⚖️", "📄", "📋", "🏥", "🚗", "🩺", "💼", "📌"] },
];

export default function EmojiField({ value, onChange, rows = 4, placeholder, id }) {
  const [open, setOpen] = useState(false);
  const areaRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocument = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Insert where the cursor is, not at the end — the useful place for an emoji
  // is usually mid-sentence, and appending would mean retyping around it.
  const insert = (emoji) => {
    const area = areaRef.current;
    const text = value ?? "";
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);

    onChange(next);
    setOpen(false);

    // The value lands on the next render, so move the caret after it.
    requestAnimationFrame(() => {
      if (!area) return;
      const caret = start + emoji.length;
      area.focus();
      area.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="emoji-field" ref={wrapRef}>
      <textarea
        id={id}
        ref={areaRef}
        rows={rows}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="emoji-toggle"
        aria-label="Insert an emoji"
        aria-expanded={open}
        title="Insert an emoji"
        onClick={() => setOpen(!open)}
      >
        <Smile size={15} />
      </button>

      {open && (
        <div className="emoji-pop" role="dialog" aria-label="Emoji">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <h4>{group.label}</h4>
              <div className="emoji-grid">
                {group.emoji.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => insert(emoji)} title={emoji}>
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p>Your keyboard's own picker works too — <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>Space</kbd> or <kbd>Win</kbd>+<kbd>.</kbd></p>
        </div>
      )}
    </div>
  );
}
