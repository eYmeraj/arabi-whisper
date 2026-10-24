// Arabi Whisper: follows what Spotify is playing, fetches the lyrics from LRCLIB and asks Gemini how each line
// is pronounced, what it means and what every word means. Everything runs in the browser; the only server is the
// optional sync database (worker/).
import {
  hasArabic,
  parseLyrics,
  numberLines,
  pickLyrics,
  cleanTitle,
  activeIndex,
  lineEnd,
  clock,
  buildPrompt,
  readResult,
  lineWords,
  createGeminiStream,
  quotaReset,
  review,
  mergeCards,
  bare,
  wordKey,
  refreshCard,
} from "./lib.js";

// ---- Configuration ----
const SPOTIFY_CLIENT_ID = "545a023e91a7461cb5409aed0569ca8f"; // public by design: identifies the Spotify developer app (see README)
// see what's playing; play, pause, skip, seek; list devices, to wake an idle one
const SPOTIFY_SCOPE = "user-read-currently-playing user-modify-playback-state user-read-playback-state";
// Tried in order: the second one takes over when the first is out of free requests or overloaded.
const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash"]; // no Flash-Lite: its translations and spelling are too often wrong
// Stamped on every converted line. Raise it when better models or prompts make earlier results worth redoing: lines
// with an older stamp are converted again when their song is opened (2: Flash-Lite dropped).
const CONVERSION = 2;
// The Cloudflare Worker that keeps converted songs for all your devices (worker/, see README). "" turns syncing off.
const SYNC_URL = "https://arabi-whisper-sync.eycode.workers.dev";
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
const songData = ({ converting, waiting, error, ...data }) => data;

// Saves `value` under `key`. When storage is full, drops the least recently opened songs until it fits (they can be
// fetched or converted again). Returns the song keys still kept.
function fit(key, value) {
  const index = (store.get("songs") || []).filter((k) => "song:" + k !== key);
  while (!store.set(key, value) && index.length) store.remove("song:" + index.shift());
  return index;
}

function saveSong(song) {
  store.set("songs", [...fit("song:" + song.key, songData(song)), song.key]);
}

// ---- State ----
const state = {
  song: null, // the song on screen
  trackKey: null, // the Spotify track last opened
  playback: null, // {key, playing, progress, at} from the last Spotify poll
  lineEls: [], // <li> per lyric line of the song on screen
  active: -1, // index of the line being sung
  follow: true, // scroll along with the music
  loop: null, // {i, start, end}: the line being repeated
  loopSeeking: false, // a jump back to the loop's start is on its way to Spotify
  notice: null, // a Spotify or login problem to show
  card: null, // the <li> whose word card is open
  tab: "lyrics", // or "flashcards"
  practice: null, // {queue: [card keys], flipped, all}: the flashcard session
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
  syncStep: $("syncStep"),
  syncToken: $("syncToken"),
  syncState: $("syncState"),
  spotifyBtn: $("spotifyBtn"),
  spotifyState: $("spotifyState"),
  player: $("player"),
  playBtn: $("playBtn"),
  prevBtn: $("prevBtn"),
  nextBtn: $("nextBtn"),
  loopBtn: $("loopBtn"),
  track: $("track"),
  trackFill: $("trackFill"),
  trackDot: $("trackDot"),
  trackLoop: $("trackLoop"),
  trackAt: $("trackAt"),
  trackLen: $("trackLen"),
  tabLyrics: $("tabLyrics"),
  tabFlash: $("tabFlash"),
  dueCount: $("dueCount"),
  flashcards: $("flashcards"),
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
  el.progress.firstElementChild.style.width = `${total ? (100 * fresh(song)) / total : 0}%`;
  renderPlayer();
}

function renderNotice() {
  const n = state.notice || songNotice(state.song);
  el.notice.hidden = !n;
  if (!n) return;
  el.notice.className = "notice" + (n.warn ? " warn" : "");
  if (n.wait) el.notice.dataset.wait = n.wait; // the dot: what we're waiting for
  else delete el.notice.dataset.wait;
  el.notice.replaceChildren(
    h("span", { class: "notice-text", text: n.text }),
    ...(n.actions || []).map(([label, fn]) => h("button", { class: "btn-ghost sm", type: "button", onclick: fn, text: label })),
  );
}

function songNotice(song) {
  if (!song) return null;
  if (song.status === "lyrics") return { text: "Finding the lyrics…" };
  const total = song.unique?.length || 0;
  const done = fresh(song);
  if (!total || done === total) return null;
  if (song.waiting === "db") return { wait: "db", text: "Checking your saved songs…" };
  if (song.converting) return { wait: song.waiting, text: `Writing the pronunciation… ${done} of ${total} ${total === 1 ? "line" : "lines"}` };
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
  const spotify = !!SPOTIFY_CLIENT_ID; // without it, this copy works with pasted lyrics only
  const start = spotify ? "Play a song on Spotify. Arabi Whisper finds the lyrics, spells" : "Paste the lyrics of an Egyptian song. Arabi Whisper spells";
  const paste = (cls) => h("button", { class: cls, type: "button", onclick: openPaste, text: "Paste lyrics" });
  return h(
    "section",
    { class: "welcome" },
    h("h1", { class: "display", text: "Read Egyptian songs the way they're sung" }),
    h("p", { class: "lede", text: `${start} out how every line sounds in English letters, translates it and explains each word.` }),
    h("figure", { class: "example" }, h("figcaption", { class: "eyebrow", text: "Example · tap a word" }), h("ol", { class: "lines" }, lineItem(EXAMPLE.line, EXAMPLE.conv))),
    h(
      "div",
      { class: "actions" },
      !spotify && store.get("gemini:key")
        ? paste("btn")
        : [h("button", { class: "btn", type: "button", onclick: openSettings, text: spotify ? "Set up in 2 steps" : "Add free Gemini key" }), paste("btn-ghost")],
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
  if (state.loop) state.lineEls[state.loop.i]?.classList.add("looping");
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
  const words = (li.words = lineWords(conv, li.line.text));
  const arabic = conv?.ar || (hasArabic(li.line.text) ? li.line.text : "");
  const rows = [];
  if (words?.some((w) => w.ar)) rows.push(h("p", { class: "ar", dir: "rtl", lang: "ar" }, wordButtons(words, "ar")));
  else if (arabic) rows.push(h("p", { class: "ar", dir: "rtl", lang: "ar", text: arabic }));
  if (conv) {
    // non-breaking hyphens keep "we-" with its word when the line wraps (word buttons never break)
    rows.push(h("p", { class: "rom" }, words ? wordButtons(words, "rom") : conv.rom.replaceAll("-", "\u2011")));
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
  const w = li.words[i];
  const ar = bare(w.ar);
  for (const b of li.querySelectorAll(".w")) b.setAttribute("aria-pressed", String(Number(b.dataset.w) === i));
  li.dataset.sel = i;
  li.append(
    h(
      "div",
      { class: "card" },
      ar && h("span", { class: "c-ar", lang: "ar", dir: "rtl", text: ar }),
      h("span", { class: "c-rom", text: bare(w.rom) || w.rom }),
      w.en && h("span", { class: "c-en", text: w.en }),
      w.note && h("span", { class: "c-note", text: w.note }),
      ar && state.song && flashButton(li, i), // not on the welcome screen's example
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
  if (!b) {
    // Like Spotify's own lyrics view: tap a line to play the song from there. While looping, that line becomes the loop.
    const li = e.target.closest("li.line");
    if (li?.line?.t == null || !isLive() || e.target.closest(".card")) return;
    if (state.loop) setLoop(state.lineEls.indexOf(li));
    seek(li.line.t);
    return;
  }
  const li = b.closest("li");
  const i = Number(b.dataset.w);
  if (state.card === li && li.dataset.sel === String(i)) closeCard();
  else openCard(li, i);
  stopFollow(); // studying a word: stay here instead of scrolling with the music
});

// ---- Flashcards: one per word, gathering the lines it was saved from; kept here and in the sync database ----
const flashcards = () => store.get("flashcards") || {};
const liveCards = () => Object.values(flashcards()).filter((c) => !c.deleted);
const PLUS = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.7v12.6a.9.9 0 0 0 1.4.8l9.6-6.3a.9.9 0 0 0 0-1.6L9.4 4.9A.9.9 0 0 0 8 5.7Z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// The line of the open word card, as a flashcard keeps it.
function useOf(li, i) {
  const conv = state.song.conv[li.line.n];
  const w = li.words[i];
  const { key, title } = state.song;
  return { song: key, title, t: li.line.t, line: conv.ar || li.line.text, lineRom: conv.rom, lineEn: conv.en, en: w.en, note: w.note };
}

const sendFlashcard = (card) =>
  syncFetch("/flashcards/" + encodeURIComponent(card.key), { method: "PUT", body: JSON.stringify(card) }).catch(() => {}); // the next sync sends it again

function saveFlashcard(card) {
  store.set("songs", fit("flashcards", { ...flashcards(), [card.key]: card }));
  sendFlashcard(card);
  renderTabs();
}

// "+" in a word card: adds the word, with this line, to the flashcards; "✓" (the word is a card, from any line) removes it.
function flashButton(li, i) {
  const w = li.words[i];
  const card = liveCards().find((c) => wordKey(c.key) === wordKey(w.ar));
  const label = card ? "Remove from flashcards" : "Add to flashcards";
  const toggle = () => {
    const now = Date.now();
    saveFlashcard(
      card
        ? { ...card, deleted: true, updated: now }
        : { key: wordKey(w.ar), ar: bare(w.ar), rom: bare(w.rom) || w.rom, uses: [useOf(li, i)], box: 0, due: now, updated: now },
    );
    openCard(li, i);
    li.querySelector(".c-add")?.focus();
  };
  const b = h("button", { class: "c-add" + (card ? " on" : ""), type: "button", "aria-label": label, title: label, onclick: toggle });
  b.innerHTML = card ? CHECK : PLUS;
  return b;
}

// A flashcard's song from the card's line: Spotify plays it there and the lyrics follow as usual. Pasted lyrics
// just open; without Spotify connected, the song opens in Spotify.
function playUse(use) {
  if (use.song.startsWith("paste:")) {
    const song = songs.get(use.song) || store.get("song:" + use.song);
    showTab("lyrics");
    show(song);
    return convert(song);
  }
  if (!store.get("spotify:tokens")) return location.assign("https://open.spotify.com/track/" + use.song);
  showTab("lyrics");
  // trackKey: the next poll opens the song even when Spotify was already on this track
  control("PUT", "play", () => (state.trackKey = null), { uris: ["spotify:track:" + use.song], position_ms: use.t || 0 });
}

// The button under a flashcard's lyric line that plays its song; none for pasted lyrics no longer on this device.
function songButton(use) {
  const known = songs.get(use.song) || store.get("song:" + use.song);
  if (use.song.startsWith("paste:") && !known) return null;
  const b = h("button", { class: "fc-song", type: "button", onclick: () => playUse(use) }, use.title || known?.title || "Play the song");
  b.insertAdjacentHTML("afterbegin", PLAY);
  return b;
}

// After `song` is converted (again), its flashcards take the new pronunciation and meanings.
function refreshFlashcards(song) {
  const now = Date.now();
  for (const card of liveCards()) {
    const next = refreshCard(card, song);
    if (next !== card) saveFlashcard({ ...next, updated: now });
  }
}

// Fetches the database's flashcards and merges them with this device's. True when anything changed here.
async function syncFlashcards() {
  try {
    const res = await syncFetch("/flashcards");
    if (!res?.ok) return false;
    const local = flashcards();
    const { cards, toPush } = mergeCards(local, Object.fromEntries((await res.json()).map((c) => [c.key, c])));
    store.set("songs", fit("flashcards", cards));
    toPush.forEach(sendFlashcard);
    renderTabs();
    return JSON.stringify(cards) !== JSON.stringify(local);
  } catch {
    return false; // offline or the database is down: practise with this device's cards
  }
}

function renderTabs() {
  const now = Date.now();
  const due = liveCards().filter((c) => c.due <= now).length;
  el.dueCount.hidden = !due;
  el.dueCount.textContent = due;
  el.tabFlash.setAttribute("aria-label", due ? `Flashcards, ${due} due` : "Flashcards");
  el.tabLyrics.setAttribute("aria-selected", String(state.tab === "lyrics"));
  el.tabFlash.setAttribute("aria-selected", String(state.tab === "flashcards"));
  el.content.hidden = state.tab !== "lyrics";
  el.flashcards.hidden = state.tab !== "flashcards";
}

async function showTab(tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  store.set("tab", tab);
  closeCard();
  renderTabs();
  if (tab === "lyrics") {
    const li = state.lineEls[state.active];
    if (li && state.follow && isLive()) li.scrollIntoView({ block: "center" });
    else scrollTo({ top: 0 });
    return;
  }
  state.practice = null;
  renderFlashcards();
  scrollTo({ top: 0 });
  // cards added or practised on another device: start over with them, unless practice has begun
  if ((await syncFlashcards()) && state.tab === "flashcards" && !state.practice?.started) {
    state.practice = null;
    renderFlashcards();
  }
}

// Due cards, the longest overdue first; or every card, shuffled.
function startPractice(all) {
  const now = Date.now();
  const cards = liveCards().filter((c) => all || c.due <= now);
  if (all) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
  } else cards.sort((a, b) => a.due - b.due);
  state.practice = { queue: cards.map((c) => c.key), flipped: false, all, started: false };
}

function renderFlashcards() {
  if (state.tab !== "flashcards") return;
  if (!state.practice) startPractice(false);
  const all = flashcards();
  state.practice.queue = state.practice.queue.filter((k) => all[k] && !all[k].deleted);
  // cards that came due meanwhile (from another device, say): practise them too instead of saying "all done"
  if (!state.practice.queue.length && !state.practice.all && liveCards().some((c) => c.due <= Date.now())) startPractice(false);
  const p = state.practice;
  const card = all[p.queue[0]];
  el.flashcards.replaceChildren(liveCards().length ? (card ? practiceView(card) : doneView()) : noCardsView());
  if (p.flipped) el.flashcards.querySelector(".fc-actions .btn")?.focus({ preventScroll: true });
}

function noCardsView() {
  return h(
    "section",
    { class: "empty" },
    h("h1", { class: "display", text: "No flashcards yet" }),
    h("p", { text: "Tap a word in the lyrics, then + to add it here. Practise them any time, even with no song playing." }),
    h("div", { class: "actions" }, h("button", { class: "btn-ghost", type: "button", onclick: () => showTab("lyrics"), text: "Go to the lyrics" })),
  );
}

function doneView() {
  const cards = liveCards();
  const next = Math.min(...cards.map((c) => c.due));
  const days = Math.max(1, Math.round((new Date(next).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000));
  const when = new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(days, "day");
  return h(
    "section",
    { class: "empty" },
    h("h1", { class: "display", text: state.practice.all ? "That's every card" : "All done for today" }),
    h("p", { text: `Next card due ${when}. You have ${cards.length} ${cards.length === 1 ? "card" : "cards"}.` }),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn-ghost", type: "button", onclick: () => (startPractice(true), renderFlashcards()), text: "Practise all anyway" }),
    ),
  );
}

// The card's word, marked in a lyric line.
const marked = (line, key) => line.split(/(\s+)/).map((part) => (wordKey(part) === wordKey(key) ? h("mark", { text: part }) : part));

function practiceView(card) {
  const p = state.practice;
  const flip = () => {
    p.flipped = p.started = true;
    renderFlashcards();
  };
  const unique = (field) => [...new Set(card.uses.map((u) => u[field]).filter(Boolean))];
  const face = p.flipped
    ? [
        h("p", { class: "fc-en", text: unique("en").join(" · ") || "No meaning given" }),
        ...unique("note").map((note) => h("p", { class: "fc-note", text: note })),
        h(
          "ul",
          { class: "fc-uses" },
          card.uses.map((u) =>
            h(
              "li",
              {},
              h("p", { class: "fc-line", lang: "ar", dir: "rtl" }, marked(u.line, card.key)),
              h("p", { class: "fc-line-rom", text: u.lineRom }),
              u.lineEn && h("p", { class: "fc-line-en", text: u.lineEn }),
              songButton(u),
            ),
          ),
        ),
      ]
    : [h("p", { class: "fc-ar", lang: "ar", dir: "rtl", text: card.ar }), h("p", { class: "fc-rom", text: card.rom })];
  const rate = (gotIt) => {
    const key = p.queue.shift();
    saveFlashcard({ ...card, ...review(card, gotIt), updated: Date.now() });
    if (!gotIt) p.queue.push(key); // comes back later in this session
    p.flipped = false;
    renderFlashcards();
  };
  const remove = () => {
    p.queue.shift();
    saveFlashcard({ ...card, deleted: true, updated: Date.now() });
    p.flipped = false;
    renderFlashcards();
  };
  return h(
    "section",
    { class: "practice" },
    h("p", { class: "eyebrow", text: `${p.queue.length} to go${p.all ? " · all cards" : ""}` }),
    h("div", { class: "fc" + (p.flipped ? " back" : ""), onclick: p.flipped ? null : flip }, face),
    p.flipped
      ? h(
          "div",
          { class: "fc-actions" },
          h("button", { class: "btn-ghost", type: "button", onclick: () => rate(false), text: "Again" }),
          h("button", { class: "btn", type: "button", onclick: () => rate(true), text: "Got it" }),
          h("button", { class: "fc-remove", type: "button", onclick: remove, text: "Remove card" }),
        )
      : h("div", { class: "fc-actions" }, h("button", { class: "btn-ghost", type: "button", onclick: flip, text: "Show answer" })),
  );
}

el.tabLyrics.addEventListener("click", () => showTab("lyrics"));
el.tabFlash.addEventListener("click", () => showTab("flashcards"));

// ---- Following the music ----
function isLive() {
  const { song, playback } = state;
  return !!(song?.synced && state.lineEls.length && playback?.key === song.key);
}

// Where the song is now: the last position Spotify reported plus the time since.
function position() {
  const { progress, at, playing } = state.playback;
  return progress + (playing ? performance.now() - at : 0);
}

// How far into the song: a bar and "1:25 … 2:31", while the song on screen is the one playing on Spotify.
function renderTrack() {
  const { song, playback } = state;
  const show = !!(playback && song?.key === playback.key && song.duration);
  if (el.track.hidden === show) {
    el.track.hidden = !show;
    document.body.classList.toggle("has-track", show);
  }
  if (!show) return;
  const at = Math.min(position(), song.duration);
  const pct = (100 * at) / song.duration;
  el.trackFill.style.width = el.trackDot.style.left = pct + "%";
  el.trackAt.textContent = clock(at);
  el.trackLen.textContent = clock(song.duration);
  const loop = state.loop; // the repeated line's stretch of the song
  el.trackLoop.hidden = !loop;
  if (loop) {
    el.trackLoop.style.left = (100 * loop.start) / song.duration + "%";
    el.trackLoop.style.width = (100 * (loop.end - loop.start)) / song.duration + "%";
  }
}

function tick() {
  renderTrack();
  const live = isLive();
  const playing = live && state.playback.playing;
  document.body.classList.toggle("live", playing && state.follow);
  document.body.classList.toggle("can-seek", live && canControl());
  el.follow.hidden = !(playing && !state.follow && state.tab === "lyrics");
  el.loopBtn.classList.toggle("off", !live); // hidden but keeps its space, so the main buttons stay centered
  if (!live) return;
  const now = position();
  if (state.loop && playing && !state.loopSeeking && now >= state.loop.end - 150) {
    state.loopSeeking = true;
    seek(state.loop.start).finally(() => (state.loopSeeking = false));
  }
  // While looping, the loop's line stays lit; otherwise light the line just as it starts.
  const i = state.loop ? state.loop.i : activeIndex(state.song.lines, now + 300);
  if (i === state.active) return;
  state.lineEls[state.active]?.classList.remove("on");
  state.active = i;
  const li = state.lineEls[i];
  li?.classList.add("on");
  if (li && playing && state.follow && state.tab === "lyrics") li.scrollIntoView({ block: "center", behavior: motion() });
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
        scope: SPOTIFY_SCOPE,
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
    state.notice = { from: "login", warn: true, text: "Spotify login didn't finish. Try connecting again.", actions: [["Open settings", openSettings]] };
    return;
  }
  try {
    await spotifyToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIRECT_URI, client_id: SPOTIFY_CLIENT_ID, code_verifier: pkce.verifier });
  } catch {
    state.notice = { from: "login", warn: true, text: "Spotify login failed. Try connecting again.", actions: [["Open settings", openSettings]] };
  }
}

// iOS freezes the page when you leave the app, and a request in flight then may never answer, which would block
// every later poll and button. So Spotify requests give up after 10 s, and those still open are dropped when the
// page comes back (see the visibilitychange handler).
let away = new AbortController();
const spotifySignal = () => AbortSignal.any?.([away.signal, AbortSignal.timeout(10000)]) ?? AbortSignal.timeout(10000);

async function spotifyToken(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    signal: spotifySignal(),
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
  store.set("spotify:tokens", {
    access: j.access_token,
    refresh: j.refresh_token || old.refresh,
    expires: Date.now() + (j.expires_in - 60) * 1000,
    scope: j.scope ?? old.scope ?? "",
  });
}

// One renewal at a time: a second one would send the refresh token the first just used up, fail, and log Spotify out.
let refreshing = null;
const refresh = () =>
  (refreshing ??= spotifyToken({ grant_type: "refresh_token", refresh_token: store.get("spotify:tokens").refresh, client_id: SPOTIFY_CLIENT_ID }).finally(
    () => (refreshing = null),
  ));

async function spotifyFetch(url, init = {}) {
  if (Date.now() > store.get("spotify:tokens").expires) await refresh();
  const send = () => fetch(url, { ...init, signal: spotifySignal(), headers: { ...init.headers, authorization: "Bearer " + store.get("spotify:tokens").access } });
  let res = await send();
  if (res.status === 401) {
    await refresh();
    res = await send();
  }
  return res;
}

let polling = false;
let pollPausedUntil = 0;
async function poll() {
  if (polling || document.hidden || Date.now() < pollPausedUntil || !SPOTIFY_CLIENT_ID || !store.get("spotify:tokens")) return;
  polling = true;
  try {
    const res = await spotifyFetch("https://api.spotify.com/v1/me/player/currently-playing");
    if (res.status === 429) {
      pollPausedUntil = Date.now() + (Number(res.headers.get("retry-after")) || 30) * 1000;
    } else if (res.status === 401) {
      store.remove("spotify:tokens"); // still refused after a fresh token
      disconnected();
    } else if (res.status === 403) {
      setNotice({ from: "poll", warn: true, text: "Spotify refused access. In your Spotify developer app, add your account under User Management and check that Premium is active." });
    } else if (res.ok) {
      if (["poll", "login"].includes(state.notice?.from)) setNotice(null); // keep a playback message until it is dealt with
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
  setNotice({ from: "poll", warn: true, text: "Spotify disconnected. Connect it again in Settings.", actions: [["Open settings", openSettings]] });
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
  if (state.notice?.from === "control") setNotice(null); // about the last song: make room for this one's status
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
  state.loop = null;
  render();
  scrollTo({ top: 0 });
}

// ---- Playback controls (Spotify Premium) ----
const canControl = () => !!store.get("spotify:tokens")?.scope?.includes("user-modify-playback-state");

// A playback message answers one tap, so it clears itself; otherwise it would hide the song's status for good.
let controlTimer;
function controlNotice(text, actions) {
  setNotice({ from: "control", warn: true, text, actions });
  clearTimeout(controlTimer);
  controlTimer = setTimeout(() => state.notice?.from === "control" && setNotice(null), actions ? 15000 : 8000); // time to tap its button
}

// Logins from before the playback buttons existed lack the permission: ask to connect again.
function needPermission() {
  if (canControl()) return false;
  controlNotice("Connect Spotify once more to use the playback buttons.", [["Connect", connectSpotify]]);
  return true;
}

const canWake = () => !!store.get("spotify:tokens")?.scope?.includes("user-read-playback-state");

// Spotify goes idle when its app has been paused or in the background for a while: then no device is "active" and
// a plain command gets 404, but a device Spotify still lists can be named and woken. Its id, or null.
async function idleDevice() {
  if (!canWake()) return null;
  const res = await spotifyFetch("https://api.spotify.com/v1/me/player/devices");
  const usable = res.ok ? ((await res.json()).devices || []).filter((d) => !d.is_restricted) : [];
  return (usable.find((d) => d.is_active) || usable[0])?.id || null;
}

// Opens the song in the Spotify app (iOS asks first), which makes that phone a device again.
const openSpotify = () => location.assign(state.playback?.key ? "spotify:track:" + state.playback.key : "spotify:");

// Sends one player command, with an optional JSON body. `then` updates the screen at once; a poll shortly after
// confirms what Spotify did.
async function control(method, command, then, body) {
  if (needPermission()) return;
  const url = "https://api.spotify.com/v1/me/player/" + command;
  const init = { method, ...(body && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) };
  try {
    let res = await spotifyFetch(url, init);
    if (res.status === 404) {
      const device = await idleDevice();
      if (device) res = await spotifyFetch(url + (url.includes("?") ? "&" : "?") + "device_id=" + encodeURIComponent(device), init);
    }
    if (res.ok) {
      if (state.notice?.from === "control") setNotice(null);
      then?.();
      setTimeout(poll, 700);
    } else if (res.status === 404 && !canWake()) {
      controlNotice("Spotify has gone idle. Connect Spotify once more, and the app can wake it on your phone or computer.", [["Connect", connectSpotify]]);
    } else if (res.status === 404) {
      controlNotice("Spotify isn't open on any of your devices. Open it, then tap Play again.", [["Open Spotify", openSpotify]]);
    } else if (res.status !== 429) {
      const reason = (await res.json().catch(() => null))?.error?.reason;
      const text = reason === "PREMIUM_REQUIRED" ? "Spotify only allows playback control with Premium." : "Spotify didn't take that command. Try it in the Spotify app.";
      controlNotice(text);
    }
  } catch {
    // offline: the next poll shows what is really playing
  }
}

function seek(ms) {
  return control("PUT", `seek?position_ms=${Math.max(0, Math.round(ms))}`, () => {
    if (state.playback) Object.assign(state.playback, { progress: ms, at: performance.now() });
    state.follow = true;
  });
}

// Repeats lyric line i until stopped (null stops it): each time the line ends, tick() jumps back to its start.
function setLoop(i) {
  const lines = state.song.lines;
  state.loop = i == null || i < 0 ? null : { i, start: lines[i].t, end: lineEnd(lines, i, state.song.duration) };
  state.lineEls.forEach((li, k) => li.classList.toggle("looping", k === state.loop?.i));
  renderPlayer();
}

el.loopBtn.addEventListener("click", () => {
  if (state.loop) return setLoop(null);
  if (needPermission()) return;
  // The line being sung; during an instrumental break, the line just before it.
  const lines = state.song.lines;
  let i = Math.max(state.active, 0);
  while (i > 0 && !lines[i].text) i--;
  setLoop(lines[i].text ? i : lines.findIndex((l) => l.text));
});

function renderPlayer() {
  const show = !!(SPOTIFY_CLIENT_ID && store.get("spotify:tokens"));
  el.player.hidden = !show;
  document.body.classList.toggle("has-player", show);
  const playing = !!state.playback?.playing;
  el.playBtn.classList.toggle("playing", playing);
  el.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  el.loopBtn.setAttribute("aria-pressed", String(!!state.loop));
  el.loopBtn.title = state.loop ? "Stop repeating this line" : "Repeat this line";
  el.loopBtn.setAttribute("aria-label", el.loopBtn.title);
}

el.playBtn.addEventListener("click", () => {
  const playing = !!state.playback?.playing;
  control("PUT", playing ? "pause" : "play", () => {
    if (state.playback) Object.assign(state.playback, { progress: position(), at: performance.now(), playing: !playing });
    renderHeader();
  });
});
el.prevBtn.addEventListener("click", () => control("POST", "previous"));
el.nextBtn.addEventListener("click", () => control("POST", "next"));

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
// Lines converted with the current CONVERSION; older ones stay on screen until they are redone.
const fresh = (song) => (song.unique || []).filter((u) => song.conv?.[u.n]?.v === CONVERSION).length;

class GeminiError extends Error {
  constructor(status, reason, message, model, daily = false) {
    super(message);
    Object.assign(this, { status, reason, model, daily, retryable: [0, 429, 500, 503].includes(status) }); // 0: the answer stopped early
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
    // a 429 names the limit it hit: requests per minute, or per day
    throw new GeminiError(res.status, reason, err.message || res.statusText, model, /PerDay/i.test(JSON.stringify(body)));
  }
  const stream = createGeminiStream(onObject);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stream.push(value);
  }
  const status = stream.end();
  // no status: the connection closed mid-answer (Gemini does this when overloaded)
  if (status !== "completed") throw new GeminiError(0, status || "cut off", `The answer ended early (${status || "cut off"}).`, model);
}

function geminiMessage(e) {
  if (!(e instanceof GeminiError)) return "Couldn't reach Gemini. Check your connection and try again.";
  if (e.reason === "API_KEY_INVALID" || e.status === 401 || e.status === 403) return "Gemini didn't accept your key. Check it in Settings.";
  if (e.status === 429 && e.daily) {
    const at = quotaReset().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `Gemini's free requests for today are used up. They come back at ${at}.`;
  }
  if (e.status === 429) return "Gemini got too many requests at once. Try again in a minute.";
  if (e.status === 404) return `Gemini no longer offers ${e.model}. Update MODELS in app.js.`;
  if (e.status >= 500) return "Gemini is busy right now. Try again in a minute.";
  if (e.status === 0) return "Gemini stopped before the end of the song. Try again for the rest.";
  return `Gemini error: ${e.message}`;
}

// ---- Sync (optional): converted songs are kept in your database too, so every device converts a song only once ----
async function syncFetch(path, init = {}) {
  const token = store.get("sync:token");
  if (!SYNC_URL || !token) return null;
  return fetch(SYNC_URL + path, { ...init, headers: { ...init.headers, authorization: "Bearer " + token } });
}

// Takes the database's copy of `song` when it has more lines converted with the current CONVERSION, or as many but
// more lines in all. True when it did.
async function pull(song) {
  try {
    const res = await syncFetch("/songs/" + encodeURIComponent(song.key));
    if (!res?.ok) return false;
    const remote = await res.json();
    const count = (s) => Object.keys(s.conv || {}).length;
    if ((fresh(remote) - fresh(song) || count(remote) - count(song)) <= 0) return false;
    Object.assign(song, remote, { uploaded: true });
    saveSong(song);
    return true;
  } catch {
    return false; // offline or the database is down: Gemini still works
  }
}

// Sends the song to the database. Until that works, `uploaded` stays false and opening the song tries again.
async function push(song) {
  try {
    const res = await syncFetch("/songs/" + encodeURIComponent(song.key), { method: "PUT", body: JSON.stringify(songData(song)) });
    if (!res?.ok) return;
    song.uploaded = true;
    saveSong(song);
  } catch {
    // offline or the database is down: the song stays saved on this device
  }
}

// Converts the lines of `song` that have no pronunciation yet, or one from an older CONVERSION, after checking the
// database for them. Results stream in line by line and are saved as they come.
async function convert(song) {
  const missing = () => (song.unique || []).filter((u) => song.conv[u.n]?.v !== CONVERSION);
  if (!missing().length || song.converting) {
    if (state.song === song) renderNotice();
    if (!song.converting && !song.uploaded && song.unique?.length) push(song); // converted, but not in the database yet
    return;
  }
  song.converting = true;
  song.waiting = "db";
  song.error = null;
  showProgress(song);
  const pulled = await pull(song);
  song.waiting = null;
  if (pulled) refreshFlashcards(song);
  if (pulled && state.song === song) render();
  const key = store.get("gemini:key");
  const todo = missing();
  if (!key || !todo.length) {
    song.converting = false;
    showProgress(song);
    return;
  }
  const wanted = new Set(todo.map((u) => u.n));
  const onObject = (o) => {
    const result = readResult(o, wanted);
    if (!result) return;
    wanted.delete(result.n);
    song.conv[result.n] = { ...result, v: CONVERSION };
    saveSong(song);
    if (state.song !== song) return;
    for (const li of state.lineEls) if (li.line?.n === result.n) fillLine(li, result);
    showProgress(song);
  };
  const { system, input } = buildPrompt(song, todo);
  song.waiting = "gemini";
  showProgress(song);
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
    song.waiting = null;
    if (wanted.size < todo.length) {
      song.uploaded = false;
      refreshFlashcards(song);
    }
    saveSong(song);
    showProgress(song);
    if (!song.uploaded) push(song);
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
  el.syncStep.hidden = !SYNC_URL;
  el.syncToken.value = store.get("sync:token") || "";
  el.syncState.textContent = store.get("sync:token") ? "Saved on this device." : "Not set yet.";
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

// Checks the token with the database before keeping it, then fetches the song on screen if the database has it.
async function saveSync() {
  const value = el.syncToken.value.trim();
  if (!value) {
    store.remove("sync:token");
    return syncSettings();
  }
  el.syncState.textContent = "Checking…";
  let status = 0;
  try {
    status = (await fetch(SYNC_URL + "/", { headers: { authorization: "Bearer " + value } })).status;
  } catch {
    // offline, or the address in SYNC_URL is wrong
  }
  if (status !== 204) {
    el.syncState.textContent = status === 401 ? "The database didn't accept this token." : "Couldn't reach the database. Try again.";
    return;
  }
  store.set("sync:token", value);
  el.syncState.textContent = "Connected on this device.";
  if (state.song) convert(state.song);
}

$("saveKey").addEventListener("click", saveKey);
$("saveSync").addEventListener("click", saveSync);
el.syncToken.addEventListener("keydown", (e) => e.key === "Enter" && saveSync());
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
renderTabs();
if (store.get("tab") === "flashcards") showTab("flashcards");
else syncFlashcards();
await finishSpotifyLogin();
render();
if (state.song) convert(state.song); // finish lines left over from last time
poll();
setInterval(poll, POLL_MS);
setInterval(tick, 250);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  away.abort(); // requests left from before the page was frozen
  away = new AbortController();
  setTimeout(poll); // once the dropped check has let go
  renderTabs(); // cards may have come due while the page was away
});
