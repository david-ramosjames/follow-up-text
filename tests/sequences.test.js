import test from "node:test";
import assert from "node:assert/strict";

import { slugify, uniqueCopyIdentity } from "../shared/sequences.js";

test("slugify matches the Sequences page create form", () => {
  assert.equal(slugify("Qualified lead"), "qualified-lead");
  assert.equal(slugify("  New  MVA  "), "new-mva");
});

test("the first copy of a sequence gets (copy) and a -copy slug", () => {
  const identity = uniqueCopyIdentity("Qualified lead", ["qualified-lead", "referral"]);
  assert.equal(identity.name, "Qualified lead (copy)");
  assert.equal(identity.slug, "qualified-lead-copy");
});

test("a second copy increments rather than colliding", () => {
  const identity = uniqueCopyIdentity("Qualified lead", [
    "qualified-lead",
    "qualified-lead-copy",
  ]);
  assert.equal(identity.name, "Qualified lead (copy 2)");
  assert.equal(identity.slug, "qualified-lead-copy-2");
});

test("duplicating a copy does not nest (copy) (copy)", () => {
  const identity = uniqueCopyIdentity("Qualified lead (copy)", [
    "qualified-lead",
    "qualified-lead-copy",
  ]);
  assert.equal(identity.name, "Qualified lead (copy 2)");
  assert.equal(identity.slug, "qualified-lead-copy-2");
});

test("a long name still gets a unique slug under the 60-character cap", () => {
  const long = "A very long sequence name that will overflow the slug limit when copied";
  const first = uniqueCopyIdentity(long, []);
  assert.ok(first.slug.length <= 60);
  assert.match(first.slug, /-copy$/);

  const second = uniqueCopyIdentity(long, [first.slug]);
  assert.ok(second.slug.length <= 60);
  assert.notEqual(second.slug, first.slug);
  assert.match(second.slug, /-copy-2$/);
});
