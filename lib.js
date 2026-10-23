// Pure helpers shared by the app and its tests (npm test). No DOM, no network.

export const hasArabic = (s) => /[؀-ۿ]/.test(s || "");

const tidy = (s) => s.replace(/\s+/g, " ").trim();

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

/** When timed line i ends: where the next timed line starts. The last line gets at most 8 s, and never runs past the song. */
export function lineEnd(lines, i, songMs = Infinity) {
  const start = lines[i].t;
  const next = lines.slice(i + 1).find((l) => l.t != null && l.t > start);
  return next ? next.t : Math.min(start + 8000, songMs);
}

// The spelling rules here are the same ones the "Sounds" guide in index.html explains. Keep them in step.
const SYSTEM = `You are an Egyptian Arabic teacher. An English speaker is learning Egyptian Arabic by reading song lyrics. For every lyric line you receive, give its pronunciation in plain English letters, its meaning in English, and a word-by-word breakdown.

PRONUNCIATION ("rom")
- Spell each word the way the singer actually pronounces it. Egyptian songs use Cairo pronunciation: ج is "g", ق is a glottal stop (قلبي = albi, بقى = ba'a), ث is "t" or "s", ذ is "d" or "z", ظ is "z". If a line is sung in Classical Arabic, spell that pronunciation instead (ق is then "q").
- Use only English letters, spaces, hyphens and apostrophes. Never use numbers for sounds (no 3, 7 or 2), accents or IPA.
- Vowels: a (ana), aa (salaam), e (enta), i (min), ee (habeeb), ei for the "ay" of "day" (beit), o for the "o" of "more" (yom), oo (noor), u (kull).
- Consonants: h for both ح and ه, kh (khalaas), gh (ghaali), sh, g is always hard, r is rolled.
- Write ' for ع and for a glottal stop (ء, or ق in Cairo speech) everywhere except at the very start of a word: ma'aak, so'aal, el-'ein, but ein, albi.
- Write doubled consonants twice: habbeit, kull.
- Write the article as heard, joined with a hyphen: el-'ein, el-hawa. It blends into some letters: esh-shams, en-noor, er-rooh.
- Keep English words and names as they are.

MEANING ("en")
- Natural, faithful English for the line, read in the context of the whole song. Keep it short. No explanations here.

WORDS ("words")
- Every word of the line, in order, as {"ar","rom","en","note"}.
- ar: the word exactly as written in the line, in Arabic script.
- rom: its pronunciation, spelled exactly as in "rom". Joining the rom of all words with single spaces must give exactly "rom".
- en: its meaning here, 1 to 4 words.
- note: at most 12 words on grammar (prefixes, suffixes, tense, person), dialect or idiom. Use "" when there is nothing useful to add.
- A word with attached parts stays one word (وبحبك = we-bahebbak). Explain the parts in its note.

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
