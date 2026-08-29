import test from "node:test";
import assert from "node:assert/strict";

import { formatSlackMentions, parseSlackUserIds } from "../shared/slackMentions.js";

test("a single member id becomes a mention Slack can resolve to a name", () => {
  assert.deepEqual(parseSlackUserIds("U0PARALEGAL"), ["U0PARALEGAL"]);
  assert.equal(formatSlackMentions("U0PARALEGAL"), "<@U0PARALEGAL>");
});

test("comma-separated member ids each get their own mention", () => {
  const stored = "U026P9FUKHC, U0AFCCVC7S5, U0ANAJK56LD, U07SDBC2146";
  assert.deepEqual(parseSlackUserIds(stored), [
    "U026P9FUKHC", "U0AFCCVC7S5", "U0ANAJK56LD", "U07SDBC2146",
  ]);
  assert.equal(
    formatSlackMentions(stored),
    "<@U026P9FUKHC> <@U0AFCCVC7S5> <@U0ANAJK56LD> <@U07SDBC2146>",
  );
});

test("already-wrapped mentions are not wrapped again as one lump", () => {
  assert.equal(
    formatSlackMentions("<@U026P9FUKHC, U0AFCCVC7S5>"),
    "<@U026P9FUKHC> <@U0AFCCVC7S5>",
  );
  assert.equal(formatSlackMentions("<@U0PARALEGAL|Sam>"), "<@U0PARALEGAL>");
});

test("a name with no member id is left as the name", () => {
  assert.equal(formatSlackMentions("", "Sam"), "Sam");
  assert.equal(formatSlackMentions("   ", "Sam"), "Sam");
});
