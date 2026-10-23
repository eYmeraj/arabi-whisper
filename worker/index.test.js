import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

// A stand-in for D1 that supports the statements the worker runs, one Map per table.
function fakeDB() {
  const tables = { songs: new Map(), flashcards: new Map() };
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
