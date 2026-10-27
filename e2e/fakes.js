// Spotify, Gemini, LRCLIB, Google Fonts and the sync Worker, simulated, so the tests touch nothing live and spend no
// Gemini requests. `world` is what those services hold; `device` opens the page as one of the user's devices.
import { test as base, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

export { expect };

// The conversion app.js stamps on lines: older ones are redone when their song opens.
export const CONVERSION = Number(readFileSync(new URL("../app.js", import.meta.url), "utf8").match(/const CONVERSION = (\d+)/)[1]);
const SCOPE = "user-read-currently-playing user-modify-playback-state user-read-playback-state";
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, PUT, POST, OPTIONS" };

// A short song of made-up lines: ليه comes twice, أيه and ايه are one word spelled two ways, and the last line repeats
// the first.
export const SONG_KEY = "TestSong00000000000001";
const LINES = [
  { t: 0, text: "ليه يا حبيبي", n: 1 },
  { t: 4000, text: "أيه اللي حصل", n: 2 },
  { t: 8000, text: "قولي ايه", n: 3 },
  { t: 12000, text: "ليه بتسيبني", n: 4 },
  { t: 16000, text: "ليه يا حبيبي", n: 1 },
];
const word = (ar, rom, en, note = "") => ({ ar, rom, en, note });
// Gemini's answer for each line.
export const ANSWERS = {
  1: { n: 1, rom: "leih ya habeebi", en: "Why, my love?", words: [word("ليه", "leih", "why", "question word"), word("يا", "ya", "oh"), word("حبيبي", "habeebi", "my love")] },
  2: { n: 2, rom: "eih elli hasal", en: "What happened?", words: [word("أيه", "eih", "what"), word("اللي", "elli", "that"), { ...word("حصل", "hasal", "happened", "past tense"), verb: "حصل" }] },
  3: { n: 3, rom: "ooli eih", en: "Tell me what", words: [word("قولي", "ooli", "tell me", "imperative + -i (me)"), word("ايه", "eih", "what")] },
  4: { n: 4, rom: "leih betseebni", en: "Why are you leaving me?", words: [word("ليه", "leih", "why", "question word"), { ...word("بتسيبني", "betseebni", "you leave me"), verb: "ساب" }] },
};
// The same lines from an older conversion, which spelled ليه differently.
export const OLD_ANSWERS = JSON.parse(JSON.stringify(ANSWERS).replaceAll("leih", "leeh"));

/** The song as the app saves it, converted with `answers`; `v` is the conversion they are stamped with (none: older). */
export function song({ answers = ANSWERS, v = CONVERSION } = {}) {
  return {
    key: SONG_KEY,
    title: "Test song",
    artist: "Test singer",
    artist1: "Test singer",
    art: "",
    duration: 30000,
    status: "ready",
    source: "lrclib",
    synced: true,
    lines: LINES,
    unique: LINES.slice(0, 4).map(({ n, text }) => ({ n, text })),
    conv: Object.fromEntries(Object.values(answers).map((a) => [a.n, { ...a, ar: "", ...(v && { v }) }])),
  };
}

/** The flashcard the app makes for `ar` from line `n` of the song, with `extra` fields (progress, say). */
export function card(ar, n, extra = {}, answers = ANSWERS) {
  const a = answers[n];
  const w = a.words.find((x) => x.ar === ar);
  const use = { song: SONG_KEY, title: "Test song", t: LINES.find((l) => l.n === n).t, line: LINES.find((l) => l.n === n).text, lineRom: a.rom, lineEn: a.en, en: w.en, note: w.note };
  return { key: ar, ar, rom: w.rom, uses: [use], box: 0, due: 0, updated: 1, ...extra };
}

const track = (id) => ({
  id,
  name: id === SONG_KEY ? "Test song" : "Another song",
  duration_ms: 30000,
  artists: [{ name: "Test singer" }],
  album: { images: [] },
});

// What Spotify answers: `list` is what it is playing through (a playlist, say), `queue` what was queued, `devices` the
// devices it lists, `idle` when none of them is active.
function fakeSpotify(world, route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const sp = world.spotify;
  const url = new URL(req.url());
  const path = url.pathname.replace("/v1/me/player", "");
  const ok = () => route.fulfill({ status: 204, headers: cors });
  if (path === "/currently-playing") {
    if (sp.idle) return ok();
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ currently_playing_type: "track", is_playing: sp.playing, progress_ms: sp.ms, item: track(sp.list[sp.i]) }) });
  }
  world.calls.push(req.method() + " " + path + url.search);
  if (path === "/devices") return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ devices: sp.devices }) });
  if (path === "/queue") return sp.queue.push(url.searchParams.get("uri").split(":").pop()), ok();
  if (path === "/next") {
    if (sp.queue.length) sp.list.splice(sp.i + 1, 0, sp.queue.shift());
    // nothing to go on to: how "stuck" looks
    if (sp.i + 1 >= sp.list.length) return route.fulfill({ status: 403, headers: cors, body: JSON.stringify({ error: { status: 403, message: "Restriction violated" } }) });
    Object.assign(sp, { i: sp.i + 1, ms: 0, playing: true });
    return ok();
  }
  if (path === "/seek") return (sp.ms = Number(url.searchParams.get("position_ms"))), ok();
  if (path === "/play") {
    if (sp.idle && !url.searchParams.has("device_id")) return route.fulfill({ status: 404, headers: cors }); // no active device
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (body.uris) Object.assign(sp, { list: body.uris.map((u) => u.split(":").pop()), i: 0, ms: body.position_ms || 0 });
    Object.assign(sp, { idle: false, playing: true });
    return ok();
  }
  return route.fulfill({ status: 404, headers: cors });
}

// Gemini streams its answer for each line asked about.
function fakeGemini(world, route) {
  world.geminiCalls++;
  const ns = [...JSON.parse(route.request().postData()).input.matchAll(/^(\d+)\|/gm)].map((m) => Number(m[1]));
  const text = ns.map((n) => JSON.stringify(world.answers[n])).join("\n");
  const events = [
    { event_type: "step.start", index: 0, step: { type: "model_output", content: [{ type: "text", text }] } },
    { event_type: "interaction.completed", interaction: { status: "completed" } },
  ];
  return route.fulfill({ status: 200, headers: cors, contentType: "text/event-stream", body: events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") });
}

// A verb's tables as the Worker gives them (made up, in lisaanmasry.org's layout and spelling).
const VERB = {
  key: "حصل",
  url: "https://www.lisaanmasry.org/online/verb.php?ui=en&id=1",
  ar: "حَصَل",
  rom: "Hasal",
  en: "happen",
  tenses: [
    { name: "Perfect", rows: [{ en: "It(m) happened", rom: "huwa Hasal", ar: "هُوَ حَصَل" }, { en: "It(f) happened", rom: "hiya Hasalit", ar: "هِيَ حَصَلِت" }] },
    { name: "Bi-Imperfect", rows: [{ en: "It(m) happens", rom: "huwa biyiHSal", ar: "هُوَ بِيِحصَل" }] },
  ],
};

// The sync Worker (worker/index.js): one row per song and per flashcard.
function fakeSync(world, route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const path = new URL(req.url()).pathname;
  if (path === "/") return route.fulfill({ status: 204, headers: cors });
  if (path === "/flashcards") return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(Object.values(world.db.flashcards)) });
  if (path.startsWith("/verbs/")) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(VERB) });
  const [, table, key] = path.match(/^\/(songs|flashcards)\/(.+)$/);
  const rows = world.db[table];
  if (req.method() === "PUT") {
    rows[decodeURIComponent(key)] = JSON.parse(req.postData());
    return route.fulfill({ status: 204, headers: cors });
  }
  const row = rows[decodeURIComponent(key)];
  return route.fulfill(row ? { status: 200, headers: cors, body: JSON.stringify(row) } : { status: 404, headers: cors });
}

// Fills a new device's storage the first time the page loads there, as if it had been used before.
function seed({ songs, cards, spotify, scope }) {
  if (localStorage.getItem("e2e")) return;
  localStorage.setItem("e2e", "1");
  localStorage.setItem("gemini:key", '"fake"');
  localStorage.setItem("sync:token", '"fake"');
  for (const s of songs) localStorage.setItem("song:" + s.key, JSON.stringify({ ...s, uploaded: true }));
  localStorage.setItem("songs", JSON.stringify(songs.map((s) => s.key)));
  localStorage.setItem("flashcards", JSON.stringify(Object.fromEntries(cards.map((c) => [c.key, c]))));
  if (spotify) localStorage.setItem("spotify:tokens", JSON.stringify({ access: "x", refresh: "y", expires: Date.now() + 3600e3, scope }));
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take their dependencies as a pattern
  world: async ({}, use) => {
    await use({
      db: { songs: {}, flashcards: {} },
      answers: ANSWERS,
      geminiCalls: 0,
      spotify: { idle: true, playing: false, list: [], i: 0, ms: 0, queue: [], devices: [{ id: "phone" }] },
      calls: [], // Spotify player requests but what's playing, as "METHOD /path?query"
      errors: [], // uncaught errors on any device
      offline: false, // every device: no service answers (set it with goOffline)
    });
  },

  device: async ({ browser, world }, use) => {
    const contexts = [];
    await use(async ({ songs = [], cards = [], spotify = true, colorScheme = "light" } = {}) => {
      const context = await browser.newContext({ baseURL: "http://127.0.0.1:8000/", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme });
      contexts.push(context);
      await context.route("https://api.spotify.com/**", (r) => fakeSpotify(world, r));
      await context.route("https://generativelanguage.googleapis.com/**", (r) => fakeGemini(world, r));
      await context.route("https://arabi-whisper-sync.eycode.workers.dev/**", (r) => fakeSync(world, r));
      await context.route("https://lrclib.net/**", (r) => r.fulfill({ status: 200, headers: cors, body: "[]" }));
      await context.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, headers: cors, contentType: "text/css", body: "" }));
      await context.route("https://open.spotify.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>Spotify</p>" }));
      // routed requests are answered even when the browser is offline: this, routed last, is asked first
      await context.route("**", (r) => (world.offline ? r.abort("internetdisconnected") : r.fallback()));
      await context.addInitScript(seed, { songs, cards, spotify, scope: SCOPE });
      const page = await context.newPage();
      page.on("pageerror", (e) => world.errors.push(e.message));
      await page.goto("/");
      return page;
    });
    await Promise.all(contexts.map((c) => c.close()));
    expect(world.errors).toEqual([]);
  },
});

/** Takes `page`'s device off the network, or back on. */
export async function goOffline(page, world, offline = true) {
  world.offline = offline;
  await page.context().setOffline(offline);
}

/** The links into other apps ("spotify:…") that `page` opens from now on. Chrome asks before opening an app, unseen
 * in tests, so none opens. */
export async function appLinks(page) {
  const links = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  cdp.on("Page.frameRequestedNavigation", (e) => !e.url.startsWith("http") && links.push(e.url));
  return links;
}

/** This device's saved flashcards, by key. */
export const savedCards = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("flashcards")));

/** The word `ar` in the lyrics' line at `i` (0-based, as shown). */
export const wordIn = (page, i, ar) =>
  page
    .locator(".lines li.line")
    .nth(i)
    .locator(".ar .w")
    .filter({ hasText: new RegExp(`^${ar}$`) });
