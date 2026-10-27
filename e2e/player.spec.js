import { test, expect, song, card, SONG_KEY, appLinks } from "./fakes.js";

test("with Spotify asleep on a device it still lists, Play wakes it there", async ({ device, world }) => {
  world.spotify.list = [SONG_KEY];
  const page = await device({ songs: [song()] });
  await expect.poll(() => world.calls).toEqual(["GET /devices"]); // the check while nothing plays
  await page.locator("#playBtn").click();
  await expect(page.locator("#chip")).toHaveText("Live");
  expect(world.calls.slice(1, 4)).toEqual(["PUT /play", "GET /devices", "PUT /play?device_id=phone"]);
});

test.describe("with Spotify open nowhere, the song opens in the Spotify app, which plays it", () => {
  test("from Play", async ({ device, world }) => {
    world.spotify.devices = [];
    const page = await device({ songs: [song()] });
    const links = await appLinks(page);
    await expect.poll(() => world.calls).toEqual(["GET /devices"]);
    await page.locator("#playBtn").click();
    await expect.poll(() => links).toEqual(["spotify:track:" + SONG_KEY]);
    expect(world.calls).not.toContain("PUT /play");
    await expect(page.locator("#notice")).toBeHidden();
  });

  test("from a card's song", async ({ device, world }) => {
    world.spotify.devices = [];
    const page = await device({ songs: [{ ...song(), key: "OtherSong" }], cards: [card("ليه", 4)] });
    const links = await appLinks(page);
    await expect.poll(() => world.calls).toEqual(["GET /devices"]);
    await page.locator("#tabFlash").click();
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.locator(".fc-song").click();
    await expect.poll(() => links).toEqual(["spotify:track:" + SONG_KEY]); // the card's song, not the one on screen
  });
});
