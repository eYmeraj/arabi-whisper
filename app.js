// Arabi Whisper: follows what Spotify is playing, fetches the lyrics from LRCLIB and asks Gemini how each line
// is pronounced, what it means and what every word means. Everything runs in the browser; there is no server.
import {
  hasArabic,
  parseLyrics,
  numberLines,
  pickLyrics,
  cleanTitle,
  activeIndex,
  buildPrompt,
  readResult,
  createGeminiStream,
} from "./lib.js";

// ---- Configuration ----
const SPOTIFY_CLIENT_ID = ""; // from your Spotify developer app (see README)
// Tried in order: the second one takes over when the first is out of free requests or overloaded.
const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const POLL_MS = 5000;
const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, "");
const LRCLIB_HEADERS = { "Lrclib-Client": "Arabi Whisper (https://github.com/eYmeraj/arabi-whisper)" };

const EXAMPLE = {
  line: { t: null, text: "حبيبي يا نور العين", n: 1 },
  conv: {
    rom: "habeebi ya noor el-'ein",
    en: "My love, light of my eyes",
    words: [
      { ar: "حبيبي", rom: "habeebi", en: "my love", note: "habeeb = loved one; -i = my" },
      { ar: "يا", rom: "ya", en: "oh", note: "said before calling someone" },
      { ar: "نور", rom: "noor", en: "light", note: "" },
      { ar: "العين", rom: "el-'ein", en: "the eye", note: "el- = the; ' is the throat sound of ع" },
    ],
  },
};

// ---- Storage (per device; every access can fail in private windows) ----
const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing to remove
    }
  },
};

// Songs are kept as "song:<key>"; "songs" lists their keys, least recently opened first.
function saveSong(song) {
  const { converting, error, ...data } = song;
  const index = (store.get("songs") || []).filter((k) => k !== song.key);
  while (!store.set("song:" + song.key, data) && index.length) store.remove("song:" + index.shift()); // full: drop the oldest
  store.set("songs", [...index, song.key]);
}

// ---- State ----
const state = {
  song: null, // the song on screen
  trackKey: null, // the Spotify track last opened
  playback: null, // {key, playing, progress, at} from the last Spotify poll
  lineEls: [], // <li> per lyric line of the song on screen
  active: -1, // index of the line being sung
  follow: true, // scroll along with the music
  notice: null, // a Spotify or login problem to show
  card: null, // the <li> whose word card is open
};
const songs = new Map(); // songs opened in this session, so a conversion running in the background keeps its object

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const el = {
  art: $("art"),
  title: $("songTitle"),
  artist: $("songArtist"),
  chip: $("chip"),
  progress: $("progress"),
  notice: $("notice"),
  content: $("content"),
  follow: $("followBtn"),
  settings: $("settings"),
  sounds: $("sounds"),
  paste: $("paste"),
  pasteText: $("pasteText"),
  geminiKey: $("geminiKey"),
  keyState: $("keyState"),
  spotifyBtn: $("spotifyBtn"),
  spotifyState: $("spotifyState"),
};

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// ---- Rendering ----
function render() {
  renderHeader();
  renderNotice();
  renderContent();
}

function renderHeader() {
  const { song, playback } = state;
  el.title.textContent = song ? song.title : "Arabi Whisper";
  el.title.classList.toggle("brand", !song);
  el.artist.textContent = song ? song.artist || "Pasted lyrics" : "Egyptian songs, the way they're sung";
  el.art.hidden = !song?.art;
  if (song?.art && el.art.getAttribute("src") !== song.art) el.art.src = song.art;
  const here = !!(song && playback?.key === song.key);
  el.chip.hidden = !here;
  el.chip.textContent = here && playback.playing ? (song.synced ? "Live" : "Playing") : "Paused";
  el.chip.classList.toggle("on", here && playback.playing);
  const total = song?.unique?.length || 0;
  el.progress.hidden = !(song?.converting && total);
  el.progress.firstElementChild.style.width = `${total ? (100 * Object.keys(song.conv).length) / total : 0}%`;
}

function renderNotice() {
  const n = state.notice || songNotice(state.song);
  el.notice.hidden = !n;
  if (!n) return;
  el.notice.className = "notice" + (n.warn ? " warn" : "");
  el.notice.replaceChildren(
    h("span", { class: "notice-text", text: n.text }),
    ...(n.actions || []).map(([label, fn]) => h("button", { class: "btn-ghost sm", type: "button", onclick: fn, text: label })),
  );
}

function songNotice(song) {
  if (!song) return null;
  if (song.status === "lyrics") return { text: "Finding the lyrics…" };
  const total = song.unique?.length || 0;
  const done = Object.keys(song.conv || {}).length;
  if (!total || done === total) return null;
  if (song.converting) return { text: `Writing the pronunciation… ${done} of ${total} lines` };
  if (song.error) return { warn: true, text: song.error, actions: [["Try again", () => convert(song)]] };
  if (!store.get("gemini:key")) return { warn: true, text: "Add your Gemini key to see the pronunciation.", actions: [["Open settings", openSettings]] };
  return null;
}

function renderContent() {
  closeCard();
  state.active = -1;
  state.lineEls = [];
  const song = state.song;
  const setUp = store.get("gemini:key") && store.get("spotify:tokens");
  el.content.replaceChildren(song ? songView(song) : setUp ? waitingView() : welcomeView());
}

function welcomeView() {
  return h(
    "section",
    { class: "welcome" },
    h("h1", { class: "display", text: "Read Egyptian songs the way they're sung" }),
    h("p", {
      class: "lede",
      text: "Play a song on Spotify. Arabi Whisper finds the lyrics, spells out how every line sounds in English letters, translates it and explains each word.",
    }),
    h("figure", { class: "example" }, h("figcaption", { class: "eyebrow", text: "Example · tap a word" }), h("ol", { class: "lines" }, lineItem(EXAMPLE.line, EXAMPLE.conv))),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", type: "button", onclick: openSettings, text: "Set up in 2 steps" }),
      h("button", { class: "btn-ghost", type: "button", onclick: openPaste, text: "Paste lyrics" }),
    ),
  );
}

function waitingView() {
  return h(
    "section",
    { class: "empty" },
    h("h1", { class: "display", text: "Play a song on Spotify" }),
    h("p", { text: "On this device or any other. The lyrics show up here a few seconds after the song starts." }),
    h("div", { class: "actions" }, h("button", { class: "btn-ghost", type: "button", onclick: openPaste, text: "Paste lyrics instead" })),
  );
}

function songView(song) {
  if (song.status === "lyrics") {
    const ph = () => h("li", { class: "line" }, ["ph ph-ar", "ph ph-rom", "ph ph-en"].map((c) => h("span", { class: c })));
    return h("ol", { class: "lines converting", "aria-hidden": "true" }, Array.from({ length: 5 }, ph));
  }
  if (song.status === "nolyrics") {
    return h(
      "section",
      { class: "empty" },
      h("h1", { class: "display", text: "No lyrics found" }),
      h("p", { text: `LRCLIB doesn't have lyrics for “${song.title}” yet. Paste them from anywhere and they'll be saved for this song.` }),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: openPaste, text: "Paste lyrics" })),
    );
  }
  if (song.status === "lyricsError") {
    return h(
      "section",
      { class: "empty" },
      h("h1", { class: "display", text: "Couldn't load the lyrics" }),
      h("p", { text: "The lyrics service didn't answer. Check your connection and try again, or paste the lyrics yourself." }),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn", type: "button", onclick: () => loadLyrics(song), text: "Try again" }),
        h("button", { class: "btn-ghost", type: "button", onclick: openPaste, text: "Paste lyrics" }),
      ),
    );
  }
  // A blank timed line is an instrumental break; a blank untimed line just separates verses.
  const gap = (line) => h("li", { class: "gap", "aria-hidden": "true", text: line.t == null ? "" : "♪" });
  state.lineEls = song.lines.map((line) => (line.text ? lineItem(line, song.conv[line.n]) : gap(line)));
  const source = song.source === "paste" ? "Lyrics pasted by you." : "Lyrics from LRCLIB.";
  return h(
    "div",
    {},
    h("ol", { class: "lines" + (song.converting ? " converting" : "") }, state.lineEls),
    h("p", { class: "credits", text: `${source} Pronunciation, translation and word notes by Gemini, which can make mistakes.` }),
  );
}

function lineItem(line, conv) {
  const li = h("li", { class: "line" });
  li.line = line;
  fillLine(li, conv);
  return li;
}

// Arabic on top (as written), then the sound, then the meaning. Words are buttons once Gemini has explained them.
function fillLine(li, conv) {
  li.conv = conv;
  const words = conv?.words?.length ? conv.words : null;
  const arabic = conv?.ar || (hasArabic(li.line.text) ? li.line.text : "");
  const rows = [];
  if (words?.some((w) => w.ar)) rows.push(h("p", { class: "ar", dir: "rtl", lang: "ar" }, wordButtons(words, "ar")));
  else if (arabic) rows.push(h("p", { class: "ar", dir: "rtl", lang: "ar", text: arabic }));
  if (conv) {
    rows.push(h("p", { class: "rom" }, words ? wordButtons(words, "rom") : conv.rom));
    if (conv.en && conv.en.toLowerCase() !== conv.rom.toLowerCase()) rows.push(h("p", { class: "en", text: conv.en }));
  } else {
    if (!arabic) rows.push(h("p", { class: "rom source", text: li.line.text })); // Arabic in English letters, until converted
    rows.push(h("span", { class: "ph ph-rom" }), h("span", { class: "ph ph-en" }));
  }
  li.replaceChildren(...rows);
}

function wordButtons(words, field) {
  const out = [];
  words.forEach((w, i) => {
    if (!w[field]) return;
    if (out.length) out.push(" ");
    out.push(h("button", { class: "w", type: "button", "data-w": i, "aria-pressed": "false", text: w[field] }));
  });
  return out;
}

// ---- Word cards ----
function openCard(li, i) {
  closeCard();
  const w = li.conv.words[i];
  for (const b of li.querySelectorAll(".w")) b.setAttribute("aria-pressed", String(Number(b.dataset.w) === i));
  li.dataset.sel = i;
  li.append(
    h(
      "div",
      { class: "card" },
      w.ar && h("span", { class: "c-ar", lang: "ar", dir: "rtl", text: w.ar }),
      h("span", { class: "c-rom", text: w.rom }),
      w.en && h("span", { class: "c-en", text: w.en }),
      w.note && h("span", { class: "c-note", text: w.note }),
    ),
  );
  state.card = li;
}

function closeCard() {
  const li = state.card;
  if (!li) return;
  li.querySelector(".card")?.remove();
  for (const b of li.querySelectorAll(".w")) b.setAttribute("aria-pressed", "false");
  delete li.dataset.sel;
  state.card = null;
}

el.content.addEventListener("click", (e) => {
  const b = e.target.closest("button.w");
  if (!b) return;
  const li = b.closest("li");
  const i = Number(b.dataset.w);
  if (state.card === li && li.dataset.sel === String(i)) closeCard();
  else openCard(li, i);
  stopFollow(); // studying a word: stay here instead of scrolling with the music
});

// ---- Following the music ----
function isLive() {
  const { song, playback } = state;
  return !!(song?.synced && state.lineEls.length && playback?.key === song.key);
}

function tick() {
  const live = isLive();
  const playing = live && state.playback.playing;
  document.body.classList.toggle("live", playing && state.follow);
  el.follow.hidden = !(playing && !state.follow);
  if (!live) return;
  const { progress, at } = state.playback;
  const position = progress + (playing ? performance.now() - at : 0);
  const i = activeIndex(state.song.lines, position + 300); // light the line just as it starts
  if (i === state.active) return;
  state.lineEls[state.active]?.classList.remove("on");
  state.active = i;
  const li = state.lineEls[i];
  li?.classList.add("on");
  if (li && playing && state.follow) li.scrollIntoView({ block: "center", behavior: motion() });
}

function stopFollow() {
  if (state.follow && isLive() && state.playback.playing) state.follow = false;
}

el.follow.addEventListener("click", () => {
  state.follow = true;
  state.lineEls[state.active]?.scrollIntoView({ block: "center", behavior: motion() });
});
for (const type of ["wheel", "touchmove"]) addEventListener(type, stopFollow, { passive: true });
addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key) && !e.target.closest("input, textarea, button, dialog")) stopFollow();
});

// ---- Spotify ----
const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const randomString = (length) => base64url(crypto.getRandomValues(new Uint8Array(length))).slice(0, length);

async function connectSpotify() {
  const verifier = randomString(64);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const nonce = randomString(16);
  store.set("spotify:pkce", { verifier, nonce });
  location.assign(
    "https://accounts.spotify.com/authorize?" +
      new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        code_challenge_method: "S256",
        code_challenge: challenge,
        scope: "user-read-currently-playing",
        state: nonce,
      }),
  );
}

// Spotify sends the browser back here with ?code=... after login.
async function finishSpotifyLogin() {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return;
  history.replaceState(null, "", REDIRECT_URI);
  const pkce = store.get("spotify:pkce");
  store.remove("spotify:pkce");
  if (!q.has("code") || !pkce || q.get("state") !== pkce.nonce) {
    state.notice = { warn: true, text: "Spotify login didn't finish. Try connecting again.", actions: [["Open settings", openSettings]] };
    return;
  }
  try {
    await spotifyToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIRECT_URI, client_id: SPOTIFY_CLIENT_ID, code_verifier: pkce.verifier });
  } catch {
    state.notice = { warn: true, text: "Spotify login failed. Try connecting again.", actions: [["Open settings", openSettings]] };
  }
}

async function spotifyToken(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    if (res.status === 400) store.remove("spotify:tokens"); // login revoked or expired: connect again
    throw new Error(`Spotify token request failed (${res.status})`);
  }
  const j = await res.json();
  const old = store.get("spotify:tokens") || {};
  store.set("spotify:tokens", { access: j.access_token, refresh: j.refresh_token || old.refresh, expires: Date.now() + (j.expires_in - 60) * 1000 });
}

async function spotifyGet(url) {
  const refresh = () => spotifyToken({ grant_type: "refresh_token", refresh_token: store.get("spotify:tokens").refresh, client_id: SPOTIFY_CLIENT_ID });
  if (Date.now() > store.get("spotify:tokens").expires) await refresh();
  const get = () => fetch(url, { headers: { authorization: "Bearer " + store.get("spotify:tokens").access } });
  let res = await get();
  if (res.status === 401) {
    await refresh();
    res = await get();
  }
  return res;
}

let polling = false;
let pollPausedUntil = 0;
async function poll() {
  if (polling || document.hidden || Date.now() < pollPausedUntil || !SPOTIFY_CLIENT_ID || !store.get("spotify:tokens")) return;
  polling = true;
  try {
    const res = await spotifyGet("https://api.spotify.com/v1/me/player/currently-playing");
    if (res.status === 429) {
      pollPausedUntil = Date.now() + (Number(res.headers.get("retry-after")) || 30) * 1000;
    } else if (res.status === 401) {
      store.remove("spotify:tokens"); // still refused after a fresh token
      disconnected();
    } else if (res.status === 403) {
      setNotice({ warn: true, text: "Spotify refused access. In your Spotify developer app, add your account under User Management and check that Premium is active." });
    } else if (res.ok) {
      setNotice(null);
      onPlayback(res.status === 204 ? null : await res.json());
    }
  } catch {
    if (!store.get("spotify:tokens")) disconnected(); // otherwise probably offline: the next poll tries again
  } finally {
    polling = false;
  }
}

function disconnected() {
  state.playback = null;
  setNotice({ warn: true, text: "Spotify disconnected. Connect it again in Settings.", actions: [["Open settings", openSettings]] });
  render();
}

function setNotice(notice) {
  if (JSON.stringify(notice) === JSON.stringify(state.notice)) return;
  state.notice = notice;
  renderNotice();
}

function onPlayback(data) {
  const item = data?.currently_playing_type === "track" ? data.item : null;
  if (!item) {
    if (state.playback) {
      state.playback = null;
      renderHeader();
    }
    return;
  }
  const key = item.id || item.uri;
  state.playback = { key, playing: !!data.is_playing, progress: data.progress_ms || 0, at: performance.now() };
  // Switch only when Spotify moves to another track, so pasted lyrics stay open while music plays.
  if (key === state.trackKey) return renderHeader();
  state.trackKey = key;
  openTrack(item);
}

function openTrack(item) {
  const key = item.id || item.uri;
  const images = item.album?.images || [];
  const known = songs.get(key);
  const song = known ||
    store.get("song:" + key) || {
      key,
      title: item.name,
      artist: item.artists.map((a) => a.name).join(", "),
      artist1: item.artists[0]?.name || "",
      art: (images.filter((i) => i.width >= 100).at(-1) || images[0])?.url || "",
      duration: item.duration_ms,
      status: "lyrics",
      lines: [],
      unique: [],
      conv: {},
    };
  show(song);
  if (song.status === "ready") convert(song);
  else if (!(known && song.status === "lyrics")) loadLyrics(song); // new, or not found last time: LRCLIB may have it now
}

function show(song) {
  songs.set(song.key, song);
  state.song = song;
  state.follow = true;
  render();
  scrollTo({ top: 0 });
}

// ---- Lyrics ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lrclib(params) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://lrclib.net/api/search?" + new URLSearchParams(params), { headers: LRCLIB_HEADERS });
    if (res.ok) return res.json();
    if (attempt === 3 || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`LRCLIB ${res.status}`);
    await sleep(1500 * 2 ** attempt); // it is busy in short bursts: wait 1.5, 3, then 6 seconds
  }
}

async function findLyrics(song) {
  const title = cleanTitle(song.title);
  const seconds = song.duration / 1000;
  for (const params of [{ track_name: song.title, artist_name: song.artist1 }, { q: `${title} ${song.artist1}` }, { q: title }]) {
    const best = pickLyrics(await lrclib(params), seconds);
    if (best) return best;
  }
  return null;
}

async function loadLyrics(song) {
  song.status = "lyrics";
  if (state.song === song) render();
  try {
    const found = await findLyrics(song);
    if (found) {
      const { lines, unique } = numberLines(parseLyrics(found.syncedLyrics, found.plainLyrics));
      Object.assign(song, { status: "ready", source: "lrclib", synced: lines[0]?.t != null, lines, unique, conv: {} });
    } else song.status = "nolyrics";
    saveSong(song);
  } catch {
    song.status = "lyricsError";
  }
  if (state.song === song) render();
  if (song.status === "ready") convert(song);
}

// ---- Pronunciation (Gemini) ----
class GeminiError extends Error {
  constructor(status, reason, message, model) {
    super(message);
    Object.assign(this, { status, reason, model, retryable: [429, 500, 503].includes(status) });
  }
}

async function askGemini(model, key, system, input, onObject) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ model, system_instruction: system, input, generation_config: { thinking_level: "low" }, stream: true, store: false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const err = (Array.isArray(body) ? body[0] : body)?.error || {};
    const reason = err.details?.find((d) => d.reason)?.reason || err.status || "";
    throw new GeminiError(res.status, reason, err.message || res.statusText, model);
  }
  const stream = createGeminiStream(onObject);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stream.push(value);
  }
  const status = stream.end();
  if (status && status !== "completed") throw new GeminiError(0, status, `The answer ended early (${status}).`, model);
}

function geminiMessage(e) {
  if (!(e instanceof GeminiError)) return "Couldn't reach Gemini. Check your connection and try again.";
  if (e.reason === "API_KEY_INVALID" || e.status === 401 || e.status === 403) return "Gemini didn't accept your key. Check it in Settings.";
  if (e.status === 429) return "Gemini's free requests are used up for now. Try again later.";
  if (e.status === 404) return `Gemini no longer offers ${e.model}. Update MODELS in app.js.`;
  if (e.status >= 500) return "Gemini is busy right now. Try again in a minute.";
  if (e.status === 0) return "Gemini stopped before the end of the song. Try again for the rest.";
  return `Gemini error: ${e.message}`;
}

// Converts the lines of `song` that have no pronunciation yet. Results stream in line by line and are saved as they come.
async function convert(song) {
  const key = store.get("gemini:key");
  const todo = (song.unique || []).filter((u) => !song.conv[u.n]);
  if (!key || !todo.length || song.converting) {
    if (state.song === song) renderNotice();
    return;
  }
  song.converting = true;
  song.error = null;
  showProgress(song);
  const wanted = new Set(todo.map((u) => u.n));
  const onObject = (o) => {
    const result = readResult(o, wanted);
    if (!result) return;
    wanted.delete(result.n);
    song.conv[result.n] = result;
    saveSong(song);
    if (state.song !== song) return;
    for (const li of state.lineEls) if (li.line?.n === result.n) fillLine(li, result);
    showProgress(song);
  };
  const { system, input } = buildPrompt(song, todo);
  try {
    for (const [i, model] of MODELS.entries()) {
      try {
        await askGemini(model, key, system, input, onObject);
        break;
      } catch (e) {
        const canFallBack = e.retryable && i < MODELS.length - 1 && wanted.size === todo.length;
        if (!canFallBack) throw e;
      }
    }
    if (wanted.size) song.error = `${wanted.size} ${wanted.size === 1 ? "line" : "lines"} came back without a pronunciation.`;
  } catch (e) {
    song.error = geminiMessage(e);
  } finally {
    song.converting = false;
    saveSong(song);
    showProgress(song);
  }
}

function showProgress(song) {
  if (state.song !== song) return;
  renderHeader();
  renderNotice();
  el.content.querySelector(".lines")?.classList.toggle("converting", !!song.converting);
}

// ---- Pasted lyrics ----
const hash = (s) => {
  let x = 2166136261;
  for (const c of s) x = Math.imul(x ^ c.codePointAt(0), 16777619);
  return (x >>> 0).toString(16);
};

function openPaste() {
  el.settings.close();
  el.paste.showModal();
}

$("pasteGo").addEventListener("click", () => {
  const text = el.pasteText.value.trim();
  if (!text) return el.pasteText.focus();
  const { lines, unique } = numberLines(parseLyrics(null, text));
  // Lyrics pasted for a playing song that LRCLIB lacks are saved for that song; anything else stands alone.
  const attach = ["nolyrics", "lyricsError"].includes(state.song?.status) && state.playback?.key === state.song.key;
  const key = attach ? state.song.key : "paste:" + hash(text);
  const song = attach ? state.song : songs.get(key) || store.get("song:" + key) || { key, title: unique[0].text.slice(0, 80), artist: "" };
  if (!song.lines?.length) Object.assign(song, { status: "ready", source: "paste", synced: false, lines, unique, conv: {} }); // else: pasted before
  el.pasteText.value = "";
  el.paste.close();
  saveSong(song);
  show(song);
  convert(song);
});

// ---- Settings ----
function openSettings() {
  syncSettings();
  el.paste.close();
  el.settings.showModal();
}

function syncSettings() {
  const key = store.get("gemini:key");
  const connected = !!store.get("spotify:tokens");
  el.geminiKey.value = key || "";
  el.keyState.textContent = key ? "Saved on this device." : "Not set yet.";
  el.spotifyBtn.textContent = connected ? "Disconnect Spotify" : "Connect Spotify";
  el.spotifyBtn.disabled = !SPOTIFY_CLIENT_ID;
  el.spotifyState.textContent = !SPOTIFY_CLIENT_ID
    ? "This copy of the app has no Spotify Client ID yet (see README)."
    : connected
      ? "Connected on this device."
      : "Not connected yet.";
}

function saveKey() {
  const value = el.geminiKey.value.trim();
  if (value) store.set("gemini:key", value);
  else store.remove("gemini:key");
  syncSettings();
  if (state.song) {
    renderNotice();
    convert(state.song);
  } else render();
}

$("saveKey").addEventListener("click", saveKey);
el.geminiKey.addEventListener("keydown", (e) => e.key === "Enter" && saveKey());
el.spotifyBtn.addEventListener("click", () => {
  if (!store.get("spotify:tokens")) return connectSpotify();
  store.remove("spotify:tokens");
  state.playback = null;
  syncSettings();
  render();
});
$("settingsBtn").addEventListener("click", openSettings);
$("settingsPaste").addEventListener("click", openPaste);
$("soundsBtn").addEventListener("click", () => el.sounds.showModal());
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", (e) => e.target === d && d.close()); // click outside

// ---- Start ----
const last = store.get("song:" + (store.get("songs") || []).at(-1));
if (last) {
  songs.set(last.key, last);
  state.song = last;
}
render();
await finishSpotifyLogin();
render();
if (state.song) convert(state.song); // finish lines left over from last time
poll();
setInterval(poll, POLL_MS);
setInterval(tick, 250);
document.addEventListener("visibilitychange", () => document.hidden || poll());
