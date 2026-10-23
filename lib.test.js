import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLyrics,
  numberLines,
  pickLyrics,
  cleanTitle,
  activeIndex,
  lineEnd,
  buildPrompt,
  readResult,
  lineWords,
  quotaReset,
  review,
  mergeCards,
  toggleUse,
  objectSplitter,
  createGeminiStream,
  StreamError,
} from "./lib.js";

test("parseLyrics reads timed lines, repeated tags and instrumental gaps", () => {
  const lines = parseLyrics("[ar: Amr Diab]\n[00:12.50] تملي معاك\n[00:20.00]\n[00:15.00][01:02.00]  ولو حتى بعيد  عني ", null);
  assert.deepEqual(lines, [
    { t: 12500, text: "تملي معاك" },
    { t: 15000, text: "ولو حتى بعيد عني" },
    { t: 20000, text: "" },
    { t: 62000, text: "ولو حتى بعيد عني" },
  ]);
});

test("parseLyrics treats lines without letters as gaps", () => {
  assert.deepEqual(parseLyrics("[00:01.00] ♪\n[00:02.00] تملي", null), [{ t: 1000, text: "" }, { t: 2000, text: "تملي" }]);
  assert.deepEqual(parseLyrics(null, 'سطر\n"""""\nسطر 2'), [{ t: null, text: "سطر" }, { t: null, text: "" }, { t: null, text: "سطر 2" }]);
});

test("parseLyrics joins و and prefixes that transcribers write apart", () => {
  assert.deepEqual(parseLyrics(null, "أهواك و أتمنّى\nتملي فـ بالي وفـ قلبي\nيـا و baby"), [
    { t: null, text: "أهواك وأتمنّى" },
    { t: null, text: "تملي فبالي وفقلبي" },
    { t: null, text: "يـا و baby" },
  ]);
});

test("parseLyrics falls back to plain lyrics and keeps one blank line between stanzas", () => {
  assert.deepEqual(parseLyrics("", "\n\nسطر واحد\n\n\n\nسطر اتنين\n\n"), [
    { t: null, text: "سطر واحد" },
    { t: null, text: "" },
    { t: null, text: "سطر اتنين" },
  ]);
});

test("numberLines converts a repeated line once", () => {
  const { lines, unique } = numberLines([{ t: 1, text: "a" }, { t: 2, text: "" }, { t: 3, text: "b" }, { t: 4, text: "a" }]);
  assert.deepEqual(lines.map((l) => l.n), [1, 0, 2, 1]);
  assert.deepEqual(unique, [{ n: 1, text: "a" }, { n: 2, text: "b" }]);
});

test("pickLyrics prefers Arabic script, then timing, and rejects other recordings", () => {
  const latin = { id: 1, duration: 243, plainLyrics: "Tamally maak", syncedLyrics: "[00:01.00] Tamally maak" };
  const arabic = { id: 2, duration: 245, plainLyrics: "تملي معاك", syncedLyrics: null };
  const live = { id: 3, duration: 300, plainLyrics: "تملي معاك", syncedLyrics: "[00:01.00] تملي معاك" };
  assert.equal(pickLyrics([latin, arabic, live], 243.4).id, 2);
  assert.equal(pickLyrics([latin, live], 243.4).id, 1);
  assert.equal(pickLyrics([live, { id: 4, instrumental: true, duration: 243 }], 243), null);
  assert.equal(pickLyrics({ message: "busy" }, 243), null);
});

test("cleanTitle drops featuring credits and version suffixes", () => {
  assert.equal(cleanTitle("Kalam Forsan (feat. Mohamed Mounir) - Remastered"), "Kalam Forsan");
  assert.equal(cleanTitle("(Intro)"), "(Intro)");
});

test("activeIndex finds the line being sung", () => {
  const lines = [{ t: 1000 }, { t: 5000 }, { t: 9000 }];
  assert.equal(activeIndex(lines, 500), -1);
  assert.equal(activeIndex(lines, 5000), 1);
  assert.equal(activeIndex(lines, 99999), 2);
  assert.equal(activeIndex([{ t: null }], 5000), -1);
});

test("lineEnd is where the next timed line starts, with limits for the last line", () => {
  const lines = [{ t: 1000 }, { t: 1000 }, { t: 5000 }, { t: 9000 }];
  assert.equal(lineEnd(lines, 0), 5000); // a line repeated at the same time is not an end
  assert.equal(lineEnd(lines, 2), 9000);
  assert.equal(lineEnd(lines, 3), 17000); // last line: 8 s
  assert.equal(lineEnd(lines, 3, 12000), 12000); // but never past the song's end
});

test("buildPrompt numbers the lines and names the song", () => {
  const { input } = buildPrompt({ title: "Tamally Maak", artist: "Amr Diab" }, [{ n: 3, text: "تملي معاك" }]);
  assert.equal(input, 'Song: "Tamally Maak" by Amr Diab\n\nLines (number|text):\n3|تملي معاك');
});

test("readResult keeps only wanted, well-formed lines", () => {
  const wanted = new Set([1]);
  assert.deepEqual(readResult({ n: "1", rom: " albi ", en: "my heart", words: [{ ar: "قلبي", rom: "albi", en: "my heart" }, "x", { ar: "?" }] }, wanted), {
    n: 1,
    ar: "",
    rom: "albi",
    en: "my heart",
    words: [{ ar: "قلبي", rom: "albi", en: "my heart", note: "" }],
  });
  assert.equal(readResult({ n: 2, rom: "x" }, wanted), null);
  assert.equal(readResult({ n: 1, rom: "" }, wanted), null);
  assert.equal(readResult(null, wanted), null);
});

test("lineWords keeps word cards only when they line up with the line's words, showing the words as written", () => {
  const w = (ar, rom) => ({ ar, rom, en: "", note: "" });
  const ars = (words) => words?.map((x) => x.ar);
  // Gemini garbled a word and dropped a vowel mark: the card shows the line's own word
  const line = "هواك، يا إنتَ بنساك";
  assert.deepEqual(ars(lineWords({ words: [w("هواك،", "hawaak,"), w("يا", "ya"), w("انت", "enta"), w("بنساak", "bansaak")] }, line)), line.split(" "));
  assert.equal(lineWords({ words: [w("هواك،", "hawaak,"), w("يا", "ya")] }, "هواك، يا - عمري"), null);
  assert.equal(lineWords({ words: [w("هواك،", "hawaak,"), w("يا", "ya"), w("عمري", "omri")] }, "هواك، يا - عمري").length, 3); // punctuation alone may be skipped
  // و written apart, merged into the next word: every later card would be off by one
  assert.equal(lineWords({ words: [w("و", "we-ansa"), w("أنسى", "roohi"), w("روحي", "wayyaak")] }, "و أنسى روحي ويّاك"), null);
  const latin = { ar: "تملي معاك", words: [w("تملي", "tamalli"), w("معاك", "ma'aak")] };
  assert.deepEqual(ars(lineWords(latin, "Tamallymaak")), ["تملي", "معاك"]); // a line in English letters is matched to its Arabic spelling
  assert.equal(lineWords({ words: [] }, "Baby"), null);
});

test("objectSplitter finds objects across chunks, braces in strings, fences and pretty printing", () => {
  const got = [];
  const push = objectSplitter((o) => got.push(o));
  for (const chunk of ['```json\n{"n":1,"rom":"a {b}', ' \\"c\\""}\n{\n  "n": 2', ',\n  "rom": "x"\n}\n{"n":3,"rom":}\n```']) push(chunk);
  assert.deepEqual(got, [{ n: 1, rom: 'a {b} "c"' }, { n: 2, rom: "x" }]);
});

// Event shapes from https://ai.google.dev/gemini-api/docs/thinking (streaming example); keep-alive and [DONE] as the live API sends them.
const sse = [
  ": keep-alive",
  'event: interaction.created\ndata: {"interaction":{"id":"v1_x","status":"in_progress"},"event_type":"interaction.created"}',
  'event: step.start\ndata: {"index":0,"step":{"signature":"","summary":[{"text":"{\\"n\\":9}","type":"text"}],"type":"thought"},"event_type":"step.start"}',
  'event: step.delta\ndata: {"index":0,"delta":{"signature":"Ep","type":"thought_signature"},"event_type":"step.delta"}',
  'event: step.start\ndata: {"index":1,"step":{"content":[{"text":"{\\"n\\":1,\\"rom\\":\\"ana\\"}\\n{\\"n\\":2,","type":"text"}],"type":"model_output"},"event_type":"step.start"}',
  'event: step.delta\ndata: {"index":1,"delta":{"text":"\\"rom\\":\\"enta\\"}","type":"text"},"event_type":"step.delta"}',
  'event: interaction.completed\ndata: {"interaction":{"id":"v1_x","status":"completed"},"event_type":"interaction.completed"}',
  "event: done\ndata: [DONE]",
].join("\r\n\r\n");

test("createGeminiStream reads model output and skips thoughts, whatever the chunk edges", () => {
  for (const size of [1, 7, 64, sse.length]) {
    const got = [];
    const stream = createGeminiStream((o) => got.push(o));
    for (let i = 0; i < sse.length; i += size) stream.push(sse.slice(i, i + size));
    assert.equal(stream.end(), "completed");
    assert.deepEqual(got, [{ n: 1, rom: "ana" }, { n: 2, rom: "enta" }], `chunk size ${size}`);
  }
});

test("createGeminiStream raises stream errors", () => {
  const stream = createGeminiStream(() => {});
  assert.throws(() => stream.push('data: {"event_type":"error","error":{"code":"x","message":"boom"}}\n\n'), StreamError);
});

test("quotaReset is the next midnight in California", () => {
  assert.equal(quotaReset(new Date("2026-10-23T11:14:09.500Z")).toISOString(), "2026-10-24T07:00:00.000Z"); // summer time
  assert.equal(quotaReset(new Date("2026-12-01T20:00:00Z")).toISOString(), "2026-12-02T08:00:00.000Z");
  assert.equal(quotaReset(new Date("2026-12-02T07:59:59Z")).toISOString(), "2026-12-02T08:00:00.000Z");
});

test("review moves a card up a box on Got it, and back to the start on Again", () => {
  const now = Date.UTC(2026, 9, 23);
  const day = 86400000;
  assert.deepEqual(review({ box: 0 }, true, now), { box: 1, due: now + day });
  assert.deepEqual(review({ box: 2 }, true, now), { box: 3, due: now + 7 * day });
  assert.deepEqual(review({ box: 6 }, true, now), { box: 6, due: now + 90 * day }); // the last box stays
  assert.deepEqual(review({ box: 4 }, false, now), { box: 0, due: now });
});

test("mergeCards keeps the newer copy of each card, and removed cards stay removed", () => {
  const local = {
    a: { key: "a", updated: 5 }, // newer here
    b: { key: "b", updated: 1 }, // older here
    c: { key: "c", updated: 9, deleted: true }, // removed here
    d: { key: "d", updated: 2 }, // only here
  };
  const remote = { a: { key: "a", updated: 3 }, b: { key: "b", updated: 4 }, c: { key: "c", updated: 8 }, e: { key: "e", updated: 1 } };
  const { cards, toPush } = mergeCards(local, remote);
  assert.deepEqual(cards, { a: local.a, b: remote.b, c: local.c, d: local.d, e: remote.e });
  assert.deepEqual(toPush.map((c) => c.key), ["a", "c", "d"]);
  assert.deepEqual(mergeCards({}, {}), { cards: {}, toPush: [] });
});

test("toggleUse adds a word's lyric line to its flashcard, takes it off again, and removes the card with its last line", () => {
  const word = { key: "حبيبي", rom: "habibi" };
  const line1 = { song: "s1", line: "يا حبيبي تعالى", en: "my love" };
  const line2 = { song: "s2", line: "حبيبي يا عمري", en: "my darling" };
  const card = toggleUse(undefined, word, line1, 10);
  assert.deepEqual(card, { key: "حبيبي", ar: "حبيبي", rom: "habibi", uses: [line1], box: 0, due: 10, updated: 10 });
  const both = toggleUse({ ...card, box: 3 }, word, line2, 20);
  assert.deepEqual([both.uses, both.box, both.updated], [[line1, line2], 3, 20]); // progress kept
  const one = toggleUse(both, word, { ...line1, en: "changed" }, 30); // the same line, whatever its notes say
  assert.deepEqual([one.uses, one.deleted], [[line2], false]);
  const gone = toggleUse(one, word, line2, 40);
  assert.deepEqual([gone.uses, gone.deleted, gone.updated], [[], true, 40]);
  const fresh = toggleUse(gone, word, line1, 50); // back after removal: a new card, due now
  assert.deepEqual([fresh.uses, fresh.box, fresh.due, fresh.deleted], [[line1], 0, 50, undefined]);
});
