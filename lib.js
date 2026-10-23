// Pure helpers shared by the app and its tests (npm test). No DOM, no network.

export const hasArabic = (s) => /[؀-ۿ]/.test(s || "");

// A line with no letters or digits ("♪", """"") is a gap, not lyrics. Transcribers often write و and prefixes
// ending in ـ apart ("و أنساك", "فـ بالي"); they are joined to the next word, as Arabic writes them.
const tidy = (s) =>
  /[\p{L}\p{N}]/u.test(s)
    ? s
        .replace(/\s+/g, " ")
        .trim()
        .replace(/(^| )(و|[^ ]*ـ) (?=[؀-ۿ])/g, (_, start, prefix) => start + prefix.replace(/ـ$/, ""))
    : "";

/** LRCLIB lyrics -> [{t, text}]: t is the line's start in ms, or null when the lyrics have no timing. */
export function parseLyrics(synced, plain) {
  if (synced) {
    const out = [];
    for (const raw of synced.split(/\r?\n/)) {
      const m = raw.match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/);
      if (!m) continue; // metadata such as [ar: ...] or [length: ...]
      const text = tidy(m[2]);
      for (const [, min, sec] of m[1].matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)) {
        out.push({ t: Math.round((Number(min) * 60 + Number(sec.replace(":", "."))) * 1000), text });
      }
    }
    if (out.length) return out.sort((a, b) => a.t - b.t);
  }
  const lines = [];
  for (const raw of (plain || "").split(/\r?\n/)) {
    const text = tidy(raw);
    if (text || lines.at(-1)?.text) lines.push({ t: null, text }); // keep one blank line between stanzas
  }
  while (lines.length && !lines.at(-1).text) lines.pop();
  return lines;
}

/** Numbers every distinct line text, so a chorus that repeats is converted once. Blank lines get n = 0. */
export function numberLines(lines) {
  const ids = new Map();
  const unique = [];
  const numbered = lines.map((line) => {
    if (!line.text) return { ...line, n: 0 };
    if (!ids.has(line.text)) {
      ids.set(line.text, unique.length + 1);
      unique.push({ n: unique.length + 1, text: line.text });
    }
    return { ...line, n: ids.get(line.text) };
  });
  return { lines: numbered, unique };
}

/** Best LRCLIB search result for a track of `seconds` length: Arabic script first, then timed lyrics, then the closest length. */
export function pickLyrics(results, seconds) {
  let best = null;
  let bestScore = -Infinity;
  for (const r of Array.isArray(results) ? results : []) {
    const text = r.syncedLyrics || r.plainLyrics;
    if (r.instrumental || !text) continue;
    const off = Math.abs((r.duration ?? seconds) - seconds);
    if (off > 8) continue; // another recording, or another song with the same name
    const score = (hasArabic(text) ? 4 : 0) + (r.syncedLyrics ? 2 : 0) - off / 2;
    if (score > bestScore) [best, bestScore] = [r, score];
  }
  return best;
}

/** "Song (feat. X) - Remastered" -> "Song", for a looser second search. */
export const cleanTitle = (s) => s.replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+.*$/, "").trim() || s;

/** Index of the line being sung at `ms`, or -1 before the first line. Lines must be timed and sorted. */
export function activeIndex(lines, ms) {
  let i = -1;
  while (i + 1 < lines.length && lines[i + 1].t != null && lines[i + 1].t <= ms) i++;
  return i;
}

/** A song position in ms as a clock: 85000 -> "1:25", 3725000 -> "1:02:05". */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** When timed line i ends: where the next timed line starts. The last line gets at most 8 s, and never runs past the song. */
export function lineEnd(lines, i, songMs = Infinity) {
  const start = lines[i].t;
  const next = lines.slice(i + 1).find((l) => l.t != null && l.t > start);
  return next ? next.t : Math.min(start + 8000, songMs);
}

// The spelling rules here are the same ones the "Sounds" guide in index.html explains. Keep them in step.
const SYSTEM = `You are an Egyptian Arabic teacher. An English speaker is learning Egyptian Arabic by reading song lyrics. For every lyric line you receive, give its pronunciation in plain English letters, its meaning in English, and a word-by-word breakdown.

PRONUNCIATION ("rom")
- Spell each word the way the singer actually pronounces it. Egyptian songs use Cairo pronunciation: ج is "g", ث is "t" or "s", ذ is "d" or "z", ظ is "z", غ is always "gh", and ق is a glottal stop (قلبي = albi, بقى = ba'a, قريب = areeb, أشتاق = ashtaa', دلوقتي = delwa'ti). In a Cairo word ق is never "q", "g" or "k", and never silent, rhymes included. Only a line sung in Classical Arabic gets Classical pronunciation (ق is then "q").
- Use Cairo vowels, not Classical ones: present-tense prefixes are ye-, te-, ne- (yeb'a, tendahlak, tekoon), and a vowel at the end of a word is short (albi, roohi, taani, fi, hawa), so a word never ends in aa, ee or oo.
- Use only English letters, spaces, hyphens, apostrophes and the line's own punctuation. Never use numbers for sounds (no 3, 7 or 2), accents or IPA, and no silent letters (kon, not kone).
- Vowels: a (ana), aa (salaam), e (enta), i (min), ee (habeeb), ei for the "ay" of "day" (beit), o for the "o" of "more" (yom), oo (noor), u (kull).
- Consonants: h for both ح and ه, kh (khalaas), gh (ghaali), sh, g is always hard, r is rolled.
- Write ' for ع everywhere, also at the start of a word ('omri, 'ein, ma'aak). Write ' for a glottal stop (ء, or ق in Cairo speech) only inside a word, also after a prefix (so'aal, ba'a, el-'alb); at the very start of a word it is not written: ana, albi (قلبي), abl (قبل), add (قد).
- Write doubled consonants twice: habbeit, kull.
- Write the article as heard, joined with a hyphen: el-'ein, el-hawa, wel-leil. It blends into t, d, s, z, sh, r, n and their heavy forms, and in Cairo also into ج: esh-shams, en-noor, er-rooh, ber-raaha, eg-gaay.
- Hyphens go only after a prefix (el-, we-, be-, le-) and between two letters that would otherwise read as one sound: t-h, s-h, k-h, g-h, d-h (as-ha, saa'et-ha, bet-hebb, mas-hoor).
- Each word is spelled on its own: never carry a sound or a hyphen across a space (في الدنيا = fi ed-donya, يا اللي = ya elli).
- Keep English words and names as they are.

MEANING ("en")
- Natural, faithful English for the line, read in the context of the whole song. Keep it short. No explanations here.

WORDS ("words")
- One entry per space-separated word of the line, in the same order, as {"ar","rom","en","note"}. Never merge or split words. A word with attached parts stays one entry (وبحبك = we-bahebbak); explain the parts in its note.
- ar: the word exactly as written in the line, in Arabic script, with any punctuation attached to it.
- rom: its pronunciation, spelled exactly as in "rom". Joining the rom of all words with single spaces must give exactly "rom".
- en: its meaning here, 1 to 4 words.
- note: at most 12 words on grammar (prefixes, suffixes, tense, person), dialect or idiom. Only state what you are sure of. Use "" when there is nothing useful to add.

LINES NOT IN ARABIC SCRIPT
- Arabic written in English letters (for example "Tamally maak"): treat it as Arabic. Add "ar" with the whole line in Arabic script and use that spelling in words[].ar.
- Lines in English or another language: "rom" is the line unchanged, "en" is its meaning in English, "words" is [].

OUTPUT
One JSON object per input line, in input order, each on its own line, using the line's number as "n". No other text and no code fences:
{"n":1,"rom":"...","en":"...","words":[{"ar":"...","rom":"...","en":"...","note":""}]}`;

/** Prompt for the lines in `todo` ([{n, text}]) of `song`. */
export function buildPrompt(song, todo) {
  const by = song.artist ? ` by ${song.artist}` : "";
  return {
    system: SYSTEM,
    input: `Song: "${song.title}"${by}\n\nLines (number|text):\n${todo.map((u) => `${u.n}|${u.text}`).join("\n")}`,
  };
}

/** Checks one object from the model. Returns a clean result, or null when it isn't one of the `wanted` line numbers. */
export function readResult(o, wanted) {
  const n = Number(o?.n);
  if (!wanted.has(n) || typeof o.rom !== "string" || !o.rom.trim()) return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const words = (Array.isArray(o.words) ? o.words : [])
    .filter((w) => w && typeof w === "object")
    .map((w) => ({ ar: str(w.ar), rom: str(w.rom), en: str(w.en), note: str(w.note) }))
    .filter((w) => w.rom);
  return { n, ar: str(o.ar), rom: str(o.rom), en: str(o.en), words };
}

const wordy = (s) => /\p{L}/u.test(s || "");

/**
 * The word cards of a converted line, or null unless they line up one to one with the words of the line (punctuation
 * aside). Cards that match word for word show the line's own words: Gemini sometimes garbles or simplifies the Arabic.
 */
export function lineWords(conv, text) {
  const words = conv?.words || [];
  const own = (conv?.ar || text).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length === own.length) return words.map((w, i) => ({ ...w, ar: own[i] }));
  return words.filter((w) => wordy(w.ar || w.rom)).length === own.filter(wordy).length ? words : null;
}

/** Feeds text chunks; calls onObject for every complete top-level {...}, wherever line breaks and chunk edges fall. */
export function objectSplitter(onObject) {
  let cur = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    for (const ch of chunk) {
      if (depth === 0) {
        if (ch !== "{") continue; // prose or code fences between objects
        cur = "";
      }
      cur += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          onObject(JSON.parse(cur));
        } catch {
          // a malformed object: its line stays unconverted and can be retried
        }
      }
    }
  };
}

export class StreamError extends Error {}

/**
 * Reads a streamed Gemini Interactions response (server-sent events) and passes each JSON object the model writes
 * to onObject. Thought steps are skipped. push() takes raw response text; end() returns the interaction status.
 */
export function createGeminiStream(onObject) {
  const feed = objectSplitter(onObject);
  const outputSteps = new Set();
  let sse = "";
  let status = "";
  const onEvent = (e) => {
    if (e.event_type === "step.start" && e.step?.type === "model_output") {
      outputSteps.add(e.index);
      for (const c of e.step.content || []) if (c.type === "text" && c.text) feed(c.text);
    } else if (e.event_type === "step.delta" && outputSteps.has(e.index) && e.delta?.type === "text") {
      feed(e.delta.text || "");
    } else if (e.event_type === "interaction.completed") {
      status = e.interaction?.status || "";
    } else if (e.event_type === "error") {
      throw new StreamError(e.error?.message || "The response stopped with an error.");
    }
  };
  return {
    push(chunk) {
      sse += chunk;
      const events = sse.split(/\r?\n\r?\n/);
      sse = events.pop();
      for (const ev of events) {
        const data = ev
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data && data !== "[DONE]") onEvent(JSON.parse(data)); // [DONE] closes the stream, after interaction.completed
      }
    },
    end() {
      if (sse.trim()) this.push("\n\n");
      return status;
    },
  };
}

/**
 * When Gemini's daily free requests come back: the next midnight in California.
 * shortcut: an hour off if the device's own clock changes for summer time that night; fine for a hint.
 */
export function quotaReset(now = new Date()) {
  const la = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const midnight = new Date(la);
  midnight.setHours(24, 0, 0, 0);
  return new Date(now.getTime() - (now.getTime() % 1000) + (midnight - la));
}

// ---- Flashcards ----
const DAY = 86400000;
const WAITS = [1, 3, 7, 14, 30, 90]; // days until a card comes back, by box (Leitner boxes)

/** A card's next box and due time after a review: "Got it" moves it up a box, "Again" back to the start, due now. */
export function review(card, gotIt, now = Date.now()) {
  if (!gotIt) return { box: 0, due: now };
  const box = Math.min((card.box || 0) + 1, WAITS.length);
  return { box, due: now + WAITS[box - 1] * DAY };
}

export const sameUse = (a, b) => a.song === b.song && a.line === b.line;

/**
 * The flashcard after "+" or "✓" in a word card. `use` is the lyric line the word was tapped in: it is added to the
 * card, or taken off when it is already there. Taking off the last line removes the card; adding to a removed card
 * starts a fresh one. `word` is {key, rom}.
 */
export function toggleUse(card, word, use, now) {
  const uses = card && !card.deleted ? card.uses : [];
  if (uses.some((u) => sameUse(u, use))) {
    const rest = uses.filter((u) => !sameUse(u, use));
    return { ...card, uses: rest, deleted: !rest.length, updated: now };
  }
  if (uses.length) return { ...card, uses: [...uses, use], updated: now };
  return { key: word.key, ar: word.key, rom: word.rom, uses: [use], box: 0, due: now, updated: now };
}

/**
 * Merges this device's flashcards with the database's ({key: card}). The newer `updated` wins for each card; removed
 * cards stay as {deleted: true} so another device can't bring them back. toPush: the cards the database lacks or has older.
 */
export function mergeCards(local, remote) {
  const cards = { ...remote };
  const toPush = [];
  for (const [key, card] of Object.entries(local)) {
    if (!remote[key] || card.updated > remote[key].updated) {
      cards[key] = card;
      toPush.push(card);
    }
  }
  return { cards, toPush };
}
