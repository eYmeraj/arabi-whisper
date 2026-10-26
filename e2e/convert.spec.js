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
