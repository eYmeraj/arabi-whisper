import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { readVerbPage } from "./index.js";

// A stand-in for D1 that supports the statements the worker runs, one Map per table.
function fakeDB() {
  const tables = { songs: new Map(), flashcards: new Map(), verbs: new Map() };
  const table = (sql) => tables[sql.match(/(?:FROM|INTO) (\w+)/)[1]];
  return {
    rows: tables.songs,
    tables,
    prepare: (sql) => ({
      all: async () => ({ results: [...table(sql).values()].map((data) => ({ data })) }),
      bind: (...args) => ({
        first: async () => (table(sql).has(args[0]) ? { data: table(sql).get(args[0]) } : null),
        run: async () => {
          assert.match(sql, /^INSERT/);
          table(sql).set(args[0], args[1]);
        },
      }),
    }),
  };
}

const env = { SYNC_TOKEN: "secret", DB: fakeDB() };
const call = (method, path, { token = "secret", body } = {}) =>
  worker.fetch(
    new Request("https://sync.example" + path, {
      method,
      body,
      headers: { origin: "http://127.0.0.1:8000", ...(token ? { authorization: "Bearer " + token } : {}) },
    }),
    env,
  );

test("sync worker keeps one row per song, only for the token's owner", async () => {
  assert.equal((await call("GET", "/", { token: "wrong" })).status, 401);
  assert.equal((await call("GET", "/songs/abc", { token: "" })).status, 401);
  assert.equal((await call("GET", "/")).status, 204);

  assert.equal((await call("GET", "/songs/abc")).status, 404);
  assert.equal((await call("PUT", "/songs/abc", { body: '{"key":"other"}' })).status, 400);
  assert.equal((await call("PUT", "/songs/abc", { body: "not json" })).status, 400);
  assert.equal((await call("PUT", "/songs/abc", { body: '{"key":"abc","conv":{}}' })).status, 204);
  assert.equal((await call("PUT", "/songs/abc", { body: '{"key":"abc","conv":{"1":{}}}' })).status, 204);
  assert.equal(env.DB.rows.size, 1);

  const res = await call("GET", "/songs/abc");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:8000");
  assert.deepEqual(await res.json(), { key: "abc", conv: { 1: {} } });

  // pasted songs have keys like "paste:1a2b"
  assert.equal((await call("PUT", "/songs/paste%3A1a2b", { body: '{"key":"paste:1a2b"}' })).status, 204);
  assert.equal((await call("GET", "/songs/paste%3A1a2b")).status, 200);
});

test("sync worker keeps flashcards in their own table, and lists them all", async () => {
  assert.equal((await call("GET", "/flashcards", { token: "wrong" })).status, 401);
  assert.deepEqual(await (await call("GET", "/flashcards")).json(), []);
  const card = (key) => JSON.stringify({ key, box: 0, updated: 1 });
  assert.equal((await call("PUT", "/flashcards/" + encodeURIComponent("حبيبي"), { body: card("حبيبي") })).status, 204);
  assert.equal((await call("PUT", "/flashcards/" + encodeURIComponent("قلبي"), { body: card("قلبي") })).status, 204);
  assert.equal((await call("PUT", "/flashcards/x", { body: card("y") })).status, 400);
  const all = await (await call("GET", "/flashcards")).json();
  assert.deepEqual(all.map((c) => c.key), ["حبيبي", "قلبي"]);
  assert.equal(env.DB.tables.flashcards.size, 2);
  assert.equal((await call("GET", "/songs/" + encodeURIComponent("حبيبي"))).status, 404); // songs untouched
  assert.equal((await call("GET", "/other/x")).status, 404);
});

// A made-up verb page in lisaanmasry.org's layout: two tenses, two rows each.
const row = (en, pr, ar) => `<tr class='treven'><td>${en}</td><td><span class='pr'>${pr}</span><span class='tr'>x</span></td><td class='ar' style='text-align:right'> ${ar}</td></tr>`;
const VERB_PAGE =
  "<h1>Verb details</h1><table><tr class='trhead'><td align=right>Word:</td><td><big><b><a href='word.php?id=1'><span class='pr'><u>ka</u>tab</span><span class='tr'>katab</span></a></b></big>&nbsp;<td align='right'><big><b> كـَتـَب </b></big></td></tr>" +
  "<tr class='trhead'><td align=right>Meaning:</td><td><big><b><a href='word.php?id=2'><span class='pr'>write</span></a></b></big>&nbsp;<td align='right'></td></tr></table>" +
  "<h1>Perfect</h1><p>past</p><table><tr class='trtitle'><td>English</td><td colspan=2>Egyptian</td></tr>" +
  row("I wrote", "<u>'a</u>na <u>ka</u>tabt", "أنا َ كـَتـَبت") + row("He wrote", "<u>huwa</u> <u>ka</u>tab", "هـُو َ كـَتـَب") +
  "</table><h1>Imperative</h1><table>" + row("You(m) write!", "<u>'ik</u>tib", "ا ِكتـِب") + "</table>";

test("reads a verb page: the verb, its meaning and each tense's rows, with the Arabic drawn together", () => {
  assert.deepEqual(readVerbPage(VERB_PAGE), {
    ar: "كَتَب",
    rom: "katab",
    en: "write",
    tenses: [
      { name: "Perfect", rows: [{ en: "I wrote", rom: "'ana katabt", ar: "أناَ كَتَبت" }, { en: "He wrote", rom: "huwa katab", ar: "هُوَ كَتَب" }] },
      { name: "Imperative", rows: [{ en: "You(m) write!", rom: "'iktib", ar: "اِكتِب" }] },
    ],
  });
  assert.equal(readVerbPage("<h1>Search</h1>no verb here"), null);
});

test("looks a verb up on lisaanmasry once, then serves it from the database", async (t) => {
  const asked = [];
  let down = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(String(url));
    if (down) throw new TypeError("fetch failed");
    if (String(url).includes("search.php")) return new Response("<a href='verb.php?ui=en&id=7&cn=2'>other</a> <a href='verb.php?ui=en&id=9&cn=2'>katab</a>");
    return new Response(String(url).endsWith("id=9") ? VERB_PAGE : VERB_PAGE.replace("كـَتـَب </b>", "قـَر َا </b>"));
  });
  assert.equal((await call("GET", "/verbs/" + encodeURIComponent("كتب"), { token: "wrong" })).status, 401);
  assert.equal(asked.length, 0);

  const res = await call("GET", "/verbs/" + encodeURIComponent("كتب"));
  assert.equal(res.status, 200);
  const v = await res.json();
  assert.equal(v.url, "https://www.lisaanmasry.org/online/verb.php?ui=en&id=9"); // the one whose verb matches, not the first
  assert.equal(v.tenses[0].rows[1].rom, "huwa katab");
  assert.equal(asked.length, 3);
  assert.equal((await call("GET", "/verbs/" + encodeURIComponent("كتب"))).status, 200);
  assert.equal(asked.length, 3); // from the database

  down = true;
  assert.equal((await call("GET", "/verbs/" + encodeURIComponent("نسي"))).status, 502);
  assert.equal(env.DB.tables.verbs.has("نسي"), false); // tried again next time
  down = false;
  assert.deepEqual(await (await call("GET", "/verbs/" + encodeURIComponent("نسي"))).json(), { key: "نسي", none: true });
});
