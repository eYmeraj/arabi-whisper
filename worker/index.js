import { plainArabic } from "../lib.js";

// Arabi Whisper sync: keeps converted songs and flashcards in a D1 database, one row each, so all of the owner's
// devices share them. Only requests carrying the owner's token (the SYNC_TOKEN secret) get in.
const ORIGINS = ["https://eymeraj.github.io", "http://127.0.0.1:8000"];
const MAX_BYTES = 1_000_000; // a long song with word cards is well under 100 KB
const LISAANMASRY = "https://www.lisaanmasry.org/online/";

const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s || "")));
// compares hashes, so the time taken says nothing about the token
const sameSecret = async (a, b) => String(await digest(a)) === String(await digest(b));

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');
const text = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
// the site puts spaces and tatweels between letters and their vowel marks, to draw the marks apart
const arabic = (s) => text(s).replace(/\u0640/g, "").replace(/\s+(?=\p{M})/gu, "");
// stressed syllables are underlined mid-word (<u>'a</u>na), so tags here join letters instead of spacing words
const pronounced = (cell) => text((cell.match(/<span class='pr'>(.*?)<\/span>/s)?.[1] ?? cell).replace(/<\/?[ui]>/g, ""));

/**
 * A verb page of lisaanmasry.org as {ar, rom, en, tenses: [{name, rows: [{en, rom, ar}]}]}, or null when it isn't one.
 * The verb's preposition (عود على) is left out of ar, so ar is the verb itself.
 */
export function readVerbPage(html) {
  const [head, ...parts] = html.split("<h1>").slice(1);
  const word = head?.match(/Word:<\/td><td>(.*?)<td align='right'>(.*?)<\/td>/s);
  if (!word) return null;
  const tenses = parts.map((part) => ({
    name: text(part.slice(0, part.indexOf("</h1>"))),
    rows: [...part.matchAll(/<tr class='tr(?:even|odd)'>(.*?)<\/tr>/gs)].map(([, row]) => {
      const cells = [...row.matchAll(/<td([^>]*)>(.*?)<\/td>/gs)];
      return {
        en: text(cells[0]?.[2] ?? ""),
        rom: pronounced(cells.find(([, , c]) => c.includes("class='pr'"))?.[2] ?? ""),
        ar: arabic(cells.find(([, a]) => a.includes("ar"))?.[2] ?? ""),
      };
    }),
  }));
  return {
    ar: arabic(word[2].replace(/<i>.*?<\/i>/gs, "")),
    rom: pronounced(word[1]),
    en: pronounced(head.match(/Meaning:<\/td><td>(.*?)<td/s)?.[1] ?? ""),
    tenses: tenses.filter((t) => t.rows.length),
  };
}

// A verb's tables from lisaanmasry.org (© Mike Green, free for non-commercial use with credit), looked up the first
// time the owner asks for that verb and kept here, so the site sees one visit per verb. A verb the site doesn't have
// is kept as {none: true}; when the site doesn't answer, nothing is kept and the next ask tries again.
async function verb(env, ar) {
  const row = await env.DB.prepare("SELECT data FROM verbs WHERE key = ?").bind(ar).first();
  if (row) return row.data;
  const page = async (path) => {
    const res = await fetch(LISAANMASRY + path, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(res.status);
    return res.text();
  };
  let found = { key: ar, none: true };
  try {
    const results = await page("search.php?ui=en&language=EG&action=s&key=" + encodeURIComponent(ar));
    const ids = [...new Set([...results.matchAll(/verb\.php\?[^'"]*?\bid=(\d+)/g)].map((m) => m[1]))];
    for (const id of ids.slice(0, 3)) {
      const url = LISAANMASRY + "verb.php?ui=en&id=" + id;
      const v = readVerbPage(await page("verb.php?ui=en&id=" + id));
      if (v && plainArabic(v.ar) === plainArabic(ar)) {
        found = { key: ar, url, ...v };
        break;
      }
    }
  } catch {
    return null;
  }
  const data = JSON.stringify(found);
  await env.DB.prepare("INSERT INTO verbs (key, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET data = ?2, updated = ?3")
    .bind(ar, data, Date.now())
    .run();
  return data;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin");
    const cors = {
      "access-control-allow-origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "access-control-allow-methods": "GET, PUT",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400",
      vary: "origin",
    };
    const reply = (status, body = null) => new Response(body, { status, headers: { ...cors, "content-type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!env.SYNC_TOKEN || !(await sameSecret(req.headers.get("authorization"), "Bearer " + env.SYNC_TOKEN))) return reply(401);

    const path = new URL(req.url).pathname;
    if (path === "/") return reply(204); // lets the app check the token
    if (path === "/flashcards" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT data FROM flashcards").all();
      return reply(200, "[" + results.map((r) => r.data).join(",") + "]");
    }
    const v = path.match(/^\/verbs\/([^/]{1,200})$/);
    if (v && req.method === "GET") {
      const data = await verb(env, decodeURIComponent(v[1]));
      return data ? reply(200, data) : reply(502);
    }
    const m = path.match(/^\/(songs|flashcards)\/([^/]{1,300})$/); // only these two names can reach the SQL below
    if (!m) return reply(404);
    const table = m[1];
    const key = decodeURIComponent(m[2]);

    if (req.method === "GET") {
      const row = await env.DB.prepare(`SELECT data FROM ${table} WHERE key = ?`).bind(key).first();
      return row ? reply(200, row.data) : reply(404);
    }
    if (req.method === "PUT") {
      const data = await req.text();
      if (data.length > MAX_BYTES) return reply(413);
      try {
        if (JSON.parse(data)?.key !== key) return reply(400);
      } catch {
        return reply(400);
      }
      await env.DB.prepare(`INSERT INTO ${table} (key, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET data = ?2, updated = ?3`)
        .bind(key, data, Date.now())
        .run();
      return reply(204);
    }
    return reply(405);
  },
};
