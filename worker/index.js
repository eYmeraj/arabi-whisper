// Arabi Whisper sync: keeps converted songs and flashcards in a D1 database, one row each, so all of the owner's
// devices share them. Only requests carrying the owner's token (the SYNC_TOKEN secret) get in.
const ORIGINS = ["https://eymeraj.github.io", "http://127.0.0.1:8000"];
const MAX_BYTES = 1_000_000; // a long song with word cards is well under 100 KB

const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s || "")));
// compares hashes, so the time taken says nothing about the token
const sameSecret = async (a, b) => String(await digest(a)) === String(await digest(b));

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
