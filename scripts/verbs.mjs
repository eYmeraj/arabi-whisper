// Builds verbs.json: the Egyptian Arabic verbs that have a conjugation table on Wiktionary (CC BY-SA 4.0), from
// kaikki.org's extract of it, respelled the app's way. Run it again to pick up new verbs: node scripts/verbs.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { plainArabic } from "../lib.js";

const SOURCE = "https://kaikki.org/dictionary/Egyptian%20Arabic/kaikki.org-dictionary-EgyptianArabic.jsonl";

// Wiktionary's letters, as the app writes them (the Sounds guide in index.html)
const LETTERS = { ʕ: "'", ʿ: "'", ʔ: "'", ʾ: "'", š: "sh", ḥ: "h", ṭ: "t", ḵ: "kh", ṣ: "s", ḡ: "gh", ḍ: "d", ẓ: "z", ṯ: "th", ɡ: "g", ā: "aa", ī: "ee", ū: "oo", ē: "ei", ō: "o", á: "a", í: "i", ú: "u" };

export function respell(rom) {
  return rom
    .replace(/^[ʔʾ]/, "") // a glottal stop at the start isn't written (ع is: ')
    .replace(/([stkgd])([hḥ])/g, "$1-$2") // two letters, not sh or kh: as-ha, bet-hebb
    .replace(/./g, (c) => LETTERS[c] ?? c)
    .replace(/^bi(?=[ytn])/, "be") // the prefixes: be-, ye-, te-, ne-, and e- for a word-initial i
    .replace(/^(be|ha|)([ytn])i/, "$1$2e")
    .replace(/^i/, "e");
}

assert.equal(respell("biyiktib"), "beyektib");
assert.equal(respell("hatiktibi"), "hatektibi");
assert.equal(respell("niktib"), "nektib");
assert.equal(respell("iktib"), "ektib");
assert.equal(respell("baktib"), "baktib");
assert.equal(respell("ʕiriftu"), "'iriftu");
assert.equal(respell("šāf"), "shaaf");
assert.equal(respell("ʔistanna"), "estanna");
assert.equal(respell("yisḥab"), "yes-hab");

// The rows of each tense, in the order of the Verbs page, with the tags that pick each form
const PEOPLE = [
  ["I", "first-person singular"],
  ["you m.", "second-person masculine singular"],
  ["you f.", "second-person feminine singular"],
  ["he", "third-person masculine singular"],
  ["she", "third-person feminine singular"],
  ["we", "first-person plural"],
  ["you pl.", "second-person plural"],
  ["they", "third-person plural"],
];
const TENSES = [
  ["Past", "past", PEOPLE],
  ["Now · be-", "indicative present", PEOPLE],
  ["Will · ha-", "future", PEOPLE],
  ["Bare (after laazim, 'aayiz…)", "subjunctive", PEOPLE],
  ["Commands", "imperative", [["to a man", "masculine singular"], ["to a woman", "feminine singular"], ["to a group", "plural"]]],
];

function table(entry) {
  const tenses = TENSES.map(([name, tense, rows]) => ({
    name,
    rows: rows.flatMap(([en, who]) => {
      const want = (tense + " " + who).split(" ");
      const f = entry.forms.find((f) => want.every((t) => f.tags?.includes(t)) && f.roman);
      return f ? [{ en, rom: respell(f.roman), ar: f.form }] : [];
    }),
  })).filter((t) => t.rows.length);
  if (tenses.length < 4) return null; // no full table on Wiktionary
  // Wiktionary's hollow verbs end "you f." in -u with be- and ha- (bitšūfu); it is -i, as in the bare form (tišūfi)
  const row = (name, en) => tenses.find((t) => t.name === name)?.rows.find((r) => r.en === en);
  for (const name of ["Now · be-", "Will · ha-"]) {
    const f = row(name, "you f."), m = row(name, "you m.");
    if (f && m && row(TENSES[3][0], "you f.")?.rom.endsWith("i") && f.rom.endsWith("u")) Object.assign(f, { rom: m.rom + "i", ar: m.ar + "ي" });
  }
  const head = entry.forms.find((f) => f.tags?.includes("romanization"))?.form;
  return {
    ar: (entry.forms.find((f) => f.tags?.includes("canonical"))?.form ?? entry.word).replace(/\s.*$/, ""),
    rom: respell(head || tenses[0].rows[3].rom),
    en: (entry.senses?.[0]?.glosses?.[0] || "").replace(/^to /, ""),
    url: "https://en.wiktionary.org/wiki/" + encodeURIComponent(entry.word) + "#Egyptian_Arabic",
    tenses,
  };
}

const lines = (await (await fetch(SOURCE)).text()).split("\n").filter(Boolean);
const verbs = {};
for (const entry of lines.map((l) => JSON.parse(l)).filter((e) => e.pos === "verb" && e.forms)) {
  const key = plainArabic(entry.word);
  const t = !verbs[key] && table(entry); // shortcut: one verb per spelling, the first listed; homographs would need Gemini's meaning to choose
  if (t) verbs[key] = t;
}
const out = {
  source: "Wiktionary (https://en.wiktionary.org), via kaikki.org, respelled; CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
  verbs,
};
writeFileSync(new URL("../verbs.json", import.meta.url), JSON.stringify(out));
console.log(Object.keys(verbs).length, "verbs");
