export function languageLabel(language) {
  return language === "es" ? "Spanish" : "English";
}

// Rewrites Language, the routing line, and the switch button on an existing
// start card so a language change does not drop Wrong track or the rest of the
// original confirmation.
export function patchEnrollmentLanguageBlocks(blocks, language, enrollmentId) {
  const label = languageLabel(language);
  const other = language === "es" ? "English" : "Spanish";
  const cloned = JSON.parse(JSON.stringify(Array.isArray(blocks) ? blocks : []));
  const switchButton = {
    type: "button",
    action_id: "followup_switch_language",
    text: { type: "plain_text", text: `Switch to ${other}` },
    value: String(enrollmentId),
  };

  for (const block of cloned) {
    if (block.type === "section" && Array.isArray(block.fields)) {
      for (const field of block.fields) {
        if (typeof field.text === "string" && /^\*Language\*/.test(field.text)) {
          field.text = `*Language*\n${label}`;
        }
      }
    }
    if (block.type === "context") {
      for (const element of block.elements ?? []) {
        if (typeof element.text === "string") {
          element.text = element.text.replace(/ · (?:English|Spanish)\b/, ` · ${label}`);
        }
      }
    }
    if (block.type === "actions" && Array.isArray(block.elements)) {
      const existing = block.elements.find((element) => element.action_id === "followup_switch_language");
      if (existing) {
        existing.text = switchButton.text;
        existing.value = switchButton.value;
      } else {
        const stopAt = block.elements.findIndex((element) => element.action_id === "followup_stop");
        block.elements.splice(stopAt >= 0 ? stopAt + 1 : 0, 0, switchButton);
      }
    }
  }

  return cloned;
}
