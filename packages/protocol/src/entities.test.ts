import assert from "node:assert/strict";
import { test } from "node:test";
import { displayText } from "./entities.ts";

// Every non-ASCII character in this file is written as an escape, so that no
// invisible or bidirectional character can hide in the source.

const text = displayText(64);

test("displayText accepts letters, scripts and emoji sequences", () => {
  const accepted: [label: string, value: string][] = [
    ["Latin", "Caf\u00E9 cr\u00E8me"],
    ["Turkish", "\u0130stanbul \u00C7al\u0131\u015Fmas\u0131"],
    ["Arabic", "\u0645\u0631\u062D\u0628\u0627"],
    ["Persian with ZWNJ", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"],
    ["Devanagari with ZWJ", "\u0915\u094D\u200D\u0937"],
    ["CJK", "\u9879\u76EE\u540D\u79F0"],
    ["ZWJ family emoji", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["skin tone", "\u{1F44D}\u{1F3FD}"],
    ["VS16", "\u2764\uFE0F"],
    ["regional-indicator flag", "\u{1F1F9}\u{1F1F7}"],
    ["keycap", "1\uFE0F\u20E3"],
    ["mixed", "Agent 7 (review) for \u0130zmir"],
  ];
  for (const [label, value] of accepted) {
    assert.equal(text.safeParse(value).success, true, label);
  }
  assert.equal(text.safeParse("a".repeat(64)).success, true, "64 characters");
});

test("displayText rejects blank, too long, control, format and invisible characters", () => {
  const rejectedWhole: [label: string, value: string][] = [
    ["empty", ""],
    ["spaces only", "   "],
    ["no-break space only", "\u00A0"],
    ["ideographic space only", "\u3000\u3000"],
    ["over the limit", "a".repeat(65)],
    [
      "ten million characters ending in U+202E",
      `${"a".repeat(10_000_000)}\u202E`,
    ],
    [
      "England subdivision flag (trade-off)",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
    ],
  ];
  for (const [label, value] of rejectedWhole) {
    assert.equal(text.safeParse(value).success, false, label);
  }

  const rejectedInside: [label: string, value: string][] = [
    ["NUL", "\u0000"],
    ["BEL", "\u0007"],
    ["tab", "\u0009"],
    ["line feed", "\u000A"],
    ["carriage return", "\u000D"],
    ["ESC", "\u001B"],
    ["DEL", "\u007F"],
    ["C1 PAD", "\u0080"],
    ["C1 NEL", "\u0085"],
    ["C1 CSI", "\u009B"],
    ["ARABIC LETTER MARK", "\u061C"],
    ["LEFT-TO-RIGHT MARK", "\u200E"],
    ["RIGHT-TO-LEFT MARK", "\u200F"],
    ["LEFT-TO-RIGHT EMBEDDING", "\u202A"],
    ["RIGHT-TO-LEFT EMBEDDING", "\u202B"],
    ["POP DIRECTIONAL FORMATTING", "\u202C"],
    ["LEFT-TO-RIGHT OVERRIDE", "\u202D"],
    ["RIGHT-TO-LEFT OVERRIDE", "\u202E"],
    ["LEFT-TO-RIGHT ISOLATE", "\u2066"],
    ["RIGHT-TO-LEFT ISOLATE", "\u2067"],
    ["FIRST STRONG ISOLATE", "\u2068"],
    ["POP DIRECTIONAL ISOLATE", "\u2069"],
    ["ZERO WIDTH SPACE", "\u200B"],
    ["WORD JOINER", "\u2060"],
    ["ZERO WIDTH NO-BREAK SPACE", "\uFEFF"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
    ["SOFT HYPHEN", "\u00AD"],
    ["TAG LATIN CAPITAL LETTER A", "\u{E0041}"],
    ["CANCEL TAG", "\u{E007F}"],
    ["lone high surrogate", "\uD800"],
    ["lone low surrogate", "\uDC00"],
    ["INTERLINEAR ANNOTATION ANCHOR", "\uFFF9"],
    ["private use", "\uE000"],
    ["supplementary private use", "\u{F0000}"],
    ["HANGUL FILLER", "\u3164"],
    ["HANGUL CHOSEONG FILLER", "\u115F"],
    ["HALFWIDTH HANGUL FILLER", "\uFFA0"],
    ["COMBINING GRAPHEME JOINER", "\u034F"],
    ["MONGOLIAN VOWEL SEPARATOR", "\u180E"],
    ["INHIBIT SYMMETRIC SWAPPING", "\u206A"],
    ["VARIATION SELECTOR-1", "\uFE00"],
  ];
  for (const [label, character] of rejectedInside) {
    assert.equal(
      text.safeParse(`abc${character}def`).success,
      false,
      `${label} inside text`,
    );
    assert.equal(text.safeParse(character).success, false, `${label} alone`);
  }
});
