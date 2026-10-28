import { test, expect, song, card, CONVERSION, OLD_ANSWERS, SONG_KEY, savedCards } from "./fakes.js";

test("a song from an older conversion is redone once for all devices, and its flashcards take the new results", async ({ device, world }) => {
  const old = { songs: [song({ answers: OLD_ANSWERS, v: null })], cards: [card("ليه", 1, { box: 2 }, OLD_ANSWERS)] };
  const rom = (page) => page.locator(".lines li.line").first().locator(".rom");

  const a = await device(old);
  await expect(rom(a)).toHaveText("leih ya habeebi");
  expect(world.geminiCalls).toBe(1);
  await expect.poll(async () => (await savedCards(a))["ليه"]).toMatchObject({ rom: "leih", box: 2, uses: [{ lineRom: "leih ya habeebi" }] });
  await expect.poll(() => Object.values(world.db.songs[SONG_KEY]?.conv || {}).filter((c) => c.v === CONVERSION).length).toBe(4);

  // another device with the same old copies takes the database's instead of asking Gemini
  const b = await device(old);
  await expect(rom(b)).toHaveText("leih ya habeebi");
  await expect.poll(async () => (await savedCards(b))["ليه"].rom).toBe("leih");
  expect(world.geminiCalls).toBe(1);
});

test("a Gemini model that stops answering is given up on, and the next one converts the song", async ({ device, world }) => {
  world.stuck = ["gemini-3.8-flash"];
  const page = await device({ songs: [song({ answers: OLD_ANSWERS, v: null })], clock: true });
  await expect(page.locator(".rom").first()).toContainText("leeh"); // the old conversion, while the new one runs
  await page.clock.runFor(90_000);
  await expect(page.locator(".rom").first()).toContainText("leih");
  expect(world.geminiCalls).toBe(2);
});

test("lyrics with no Arabic script aren't sent to Gemini unless asked, for Arabic written in English letters", async ({ device, world }) => {
  const lines = [{ t: 0, text: "Walking home in the rain", n: 1 }, { t: 4000, text: "Nobody waiting for me", n: 2 }];
  const english = { ...song(), lines, unique: lines.map(({ n, text }) => ({ n, text })), conv: {} };
  world.answers = { 1: { n: 1, rom: lines[0].text, en: lines[0].text, words: [] }, 2: { n: 2, rom: lines[1].text, en: lines[1].text, words: [] } };
  const page = await device({ songs: [english] });
  await expect(page.getByText("These lyrics aren't in Arabic script.")).toBeVisible();
  expect(world.geminiCalls).toBe(0);

  await page.getByRole("button", { name: "Convert anyway" }).click();
  await expect(page.getByText("These lyrics aren't in Arabic script.")).toBeHidden();
  expect(world.geminiCalls).toBe(1);
  await page.reload();
  await expect(page.locator(".rom").first()).toHaveText("Walking home in the rain");
  expect(world.geminiCalls).toBe(1); // converted once, kept
});
