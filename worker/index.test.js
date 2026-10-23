import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

// A stand-in for D1 that supports the two statements the worker runs.
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => (rows.has(args[0]) ? { data: rows.get(args[0]) } : null),
        run: async () => {
          assert.match(sql, /^INSERT/);
          rows.set(args[0], args[1]);
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
