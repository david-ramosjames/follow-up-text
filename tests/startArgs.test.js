import test from "node:test";
import assert from "node:assert/strict";

import { parseStartArgs } from "../shared/startArgs.js";

const numbers = [
  { id: "PNINTAKE", phone_e164: "+15125557777", label: "Intake line" },
  { id: "PNSPARE", phone_e164: "+15125558888", label: "Spare line" },
];

test("a start with no from uses the default sending number", () => {
  const parsed = parseStartArgs(["512-555-0123", "es", "Maria"], {
    sequenceSlugs: ["new-lead"],
    sendingNumbers: numbers,
  });
  assert.equal(parsed.phone, "+15125550123");
  assert.equal(parsed.language, "es");
  assert.equal(parsed.firstName, "Maria");
  assert.equal(parsed.quoNumberId, undefined);
});

test("from plus a Quo label picks that sending number", () => {
  const parsed = parseStartArgs(["512-555-0123", "from", "spare"], {
    sendingNumbers: numbers,
  });
  assert.equal(parsed.quoNumberId, "PNSPARE");
  assert.equal(parsed.fromAsked, true);
  assert.equal(parsed.firstName, undefined);
});

test("from plus last four digits picks that sending number", () => {
  const parsed = parseStartArgs(["512-555-0123", "Maria", "from", "8888"], {
    sendingNumbers: numbers,
  });
  assert.equal(parsed.quoNumberId, "PNSPARE");
  assert.equal(parsed.firstName, "Maria");
});

test("from secondary uses the alias from Settings", () => {
  const parsed = parseStartArgs(["512-555-0123", "from", "secondary"], {
    sendingNumbers: numbers,
    aliases: { secondary: "PNSPARE", "2nd": "PNSPARE" },
  });
  assert.equal(parsed.quoNumberId, "PNSPARE");
});

test("an unmatched from is not treated as a first name", () => {
  const parsed = parseStartArgs(["512-555-0123", "from", "nope", "Maria"], {
    sendingNumbers: numbers,
  });
  assert.equal(parsed.fromAsked, true);
  assert.equal(parsed.quoNumberId, undefined);
  assert.equal(parsed.fromUnmatched, "nope");
  assert.equal(parsed.firstName, "Maria");
});
