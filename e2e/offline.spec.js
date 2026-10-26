import { test, expect, song, card, savedCards, goOffline } from "./fakes.js";

const LIVE = ["api.spotify.com", "arabi-whisper-sync.eycode.workers.dev"]; // services that only work online

// Opens the page twice, as the copy for offline use takes in the page's files when it starts, and the fonts on the
// next load.
async function used(device, options) {
  const page = await device(options);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.reload();
  return page;
}

test("flashcards work with no connection, and the progress syncs once back online", async ({ device, world }) => {
  const page = await used(device, { songs: [song()], cards: [card("ليه", 1, { reverse: { box: 0, due: Date.now() + 86400e3 } })] });
  await expect.poll(() => world.db.flashcards["ليه"]?.box).toBe(0);

  await goOffline(page, world);
  const failed = [];
  page.on("requestfailed", (r) => failed.push(new URL(r.url()).hostname));
  await page.reload();
  await expect(page.locator(".lines li.line").first()).toContainText("ليه يا حبيبي");
  await page.locator("#tabFlash").click();
  await page.getByRole("button", { name: "Show answer" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("heading", { name: "All done for today" })).toBeVisible();
  expect((await savedCards(page))["ليه"].box).toBe(1);
  expect(world.db.flashcards["ليه"].box).toBe(0);
  expect(failed.filter((host) => !LIVE.includes(host))).toEqual([]); // the page, its scripts, styles and fonts all opened

  await goOffline(page, world, false);
  await expect.poll(() => world.db.flashcards["ليه"].box).toBe(1);
});

test("on a weak signal, the saved copy opens the page", async ({ device }) => {
  const page = await used(device, { songs: [song()] });
  await page.context().route("http://127.0.0.1:8000/**", (r) => new Promise((ok) => setTimeout(ok, 20000)).then(() => r.continue()));
  const start = Date.now();
  await page.reload();
  await expect(page.locator(".lines li.line").first()).toContainText("ليه يا حبيبي");
  expect(Date.now() - start).toBeLessThan(6000); // one wait of 3 s, not one per file
});
