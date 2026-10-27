// Keeps a copy of the page's own files and fonts, so it opens with no connection: the flashcards and the songs already
// converted live in the browser. The network answers first, so a new version shows on the next load; the copy answers
// when the network fails, or is so slow (a weak signal) that the copy is better.
const CACHE = "arabi-whisper";
const FILES = ["./", "app.js", "lib.js", "style.css", "verbs.json", "icon.svg", "apple-touch-icon.png"];
const FONTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const SLOW_MS = 3000;
let weakUntil = 0; // after the network was that slow, the copy answers at once for a while: not 3 s for every file

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || (url.origin !== location.origin && !FONTS.includes(url.hostname))) return; // Spotify, Gemini, lyrics, sync: always live
  e.respondWith(networkFirst(e.request, e.request.mode === "navigate" ? "./" : e.request)); // the page, whatever its ?query (Spotify's login adds one)
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") cache.put(key, res.clone()); // opaque: the fonts' stylesheet
    return res;
  });
  const slow = new Promise((ok) => setTimeout(ok, Date.now() < weakUntil ? 0 : SLOW_MS))
    .then(() => cache.match(key))
    .then((saved) => (saved ? ((weakUntil = Date.now() + 10000), saved) : network));
  try {
    return await Promise.race([network, slow]);
  } catch {
    return (await cache.match(key)) || Response.error();
  }
}
