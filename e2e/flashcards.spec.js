import { test, expect, song, card, SONG_KEY, savedCards, wordIn } from "./fakes.js";

test("a word is one card, whichever line or spelling it is added from", async ({ device }) => {
  const page = await device({ songs: [song()] });
  await wordIn(page, 0, "ليه").click();
  await page.getByRole("button", { name: "Add to flashcards" }).click();
  await wordIn(page, 3, "ليه").click();
  await expect(page.getByRole("button", { name: "Remove from flashcards" })).toBeVisible();

  await wordIn(page, 1, "أيه").click();
  await page.getByRole("button", { name: "Add to flashcards" }).click();
  await wordIn(page, 2, "ايه").click();
  await page.getByRole("button", { name: "Remove from flashcards" }).click();
  await expect(page.getByRole("button", { name: "Add to flashcards" })).toBeVisible();

  const cards = await savedCards(page);
  expect(Object.keys(cards)).toEqual(["ليه", "ايه"]);
  expect(cards["ايه"].deleted).toBe(true);
  await expect(page.locator("#dueCount")).toHaveText("2"); // ليه, both ways
});

test("a card is practised both ways, each on its own schedule", async ({ device, world }) => {
  const page = await device({ songs: [song()] });
  await wordIn(page, 0, "ليه").click();
  await page.getByRole("button", { name: "Add to flashcards" }).click();
  await page.locator("#tabFlash").click();
  const fc = page.locator(".fc");

  // from the Arabic to the meaning
  await expect(fc.locator(".fc-ar")).toHaveText("ليه");
  await expect(fc.locator(".fc-en")).toHaveCount(0);
  await page.getByRole("button", { name: "Show answer" }).click();
  await expect(fc.locator(".fc-en")).toHaveText("why");
  await page.getByRole("button", { name: "Got it" }).click();

  // from the meaning to the Arabic
  await expect(fc.locator(".fc-en")).toHaveText("why");
  await expect(fc.locator(".fc-ar")).toHaveCount(0);
  await page.getByRole("button", { name: "Show answer" }).click();
  await expect(fc.locator(".fc-word")).toHaveText("ليهleih");
  await page.getByRole("button", { name: "Again" }).click();
  await expect(fc.locator(".fc-en")).toHaveText("why"); // back in the same session
  await page.getByRole("button", { name: "Show answer" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("heading", { name: "All done for today" })).toBeVisible();
  await expect(page.locator("#dueCount")).toBeHidden();

  const saved = (await savedCards(page))["ليه"];
  expect(saved).toMatchObject({ box: 1, reverse: { box: 1 } });
  expect(saved.reverse.due).toBeGreaterThan(Date.now());
  await expect.poll(() => world.db.flashcards["ليه"]).toEqual(saved);
});

test("cards made before there were two sides are practised from the meaning too", async ({ device }) => {
  const page = await device({ songs: [song()], cards: [card("ليه", 1, { box: 1, due: Date.now() + 86400e3 })] });
  await expect(page.locator("#dueCount")).toHaveText("1");
  await page.locator("#tabFlash").click();
  await expect(page.locator(".fc .fc-en")).toHaveText("why");
});

test.describe("a card's song plays from the card's line", () => {
  const playCard = async (page) => {
    await page.locator("#tabFlash").click();
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.locator(".fc-song").click();
  };

  test("while a playlist plays, which carries on after it", async ({ device, world }) => {
    Object.assign(world.spotify, { idle: false, playing: true, list: ["other1", "other2"] });
    const page = await device({ songs: [song()], cards: [card("ليه", 4)] });
    await expect(page.locator("#songTitle")).toHaveText("Another song");
    await playCard(page);
    await expect(page.locator(".lines li.line.on")).toContainText("ليه بتسيبني");
    expect(world.calls).toEqual(["POST /queue?uri=spotify%3Atrack%3A" + SONG_KEY, "POST /next", "PUT /seek?position_ms=12000"]);

    await page.locator("#nextBtn").click();
    await expect(page.locator("#songTitle")).toHaveText("Another song");
    expect(world.spotify.list.slice(world.spotify.i)).toEqual(["other2"]);
  });

  test("when it is the song paused", async ({ device, world }) => {
    Object.assign(world.spotify, { idle: false, playing: false, list: [SONG_KEY], ms: 20000 });
    const page = await device({ songs: [song()], cards: [card("ليه", 4)] });
    await expect(page.locator("#chip")).toHaveText("Paused");
    await playCard(page);
    await expect.poll(() => world.calls).toEqual(["PUT /seek?position_ms=12000", "PUT /play"]);
    await expect(page.locator(".lines li.line.on")).toContainText("ليه بتسيبني");
  });

  test("when nothing plays", async ({ device, world }) => {
    const page = await device({ songs: [song()], cards: [card("ليه", 4)] });
    await playCard(page);
    await expect(page.locator(".lines li.line.on")).toContainText("ليه بتسيبني");
    expect(world.spotify).toMatchObject({ list: [SONG_KEY], ms: 12000, playing: true });
  });

  test("in Spotify, without Spotify connected", async ({ device }) => {
    const page = await device({ songs: [song()], cards: [card("ليه", 4)], spotify: false });
    await playCard(page);
    await expect(page).toHaveURL("https://open.spotify.com/track/" + SONG_KEY);
  });
});
