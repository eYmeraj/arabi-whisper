import { test, expect, song, wordIn } from "./fakes.js";

test("a verb's card opens its tables from Wiktionary, in the app's spelling, and other words have none", async ({ device }) => {
  const page = await device({ songs: [song()] });
  await page.setViewportSize({ width: 375, height: 812 });
  await wordIn(page, 1, "اللي").click();
  await expect(page.locator(".card")).toBeVisible();
  await expect(page.getByText("Conjugation")).toHaveCount(0);

  await wordIn(page, 3, "بتسيبني").click();
  await page.getByText("Conjugation").click();
  await expect(page.getByRole("table", { name: "Past" })).toContainText("sibt");
  await expect(page.getByRole("table", { name: "Now · be-" })).toContainText("beyseeb");
  await expect(page.getByRole("link", { name: "Wiktionary" })).toHaveAttribute("href", /wiktionary\.org\/wiki\/.*#Egyptian_Arabic$/);
  expect(await page.locator("html").evaluate((html) => html.scrollWidth)).toBeLessThanOrEqual(375);
});

test("a verb Wiktionary doesn't have comes from lisaanmasry.org, credited", async ({ device }) => {
  const page = await device({ songs: [song()] });
  await wordIn(page, 1, "حصل").click();
  await page.getByText("Conjugation").click();
  await expect(page.getByRole("table", { name: "Perfect", exact: true })).toContainText("hiya Hasalit");
  await expect(page.getByRole("link", { name: "lisaanmasry.org" })).toHaveAttribute("href", "https://www.lisaanmasry.org/online/verb.php?ui=en&id=1");
  await expect(page.locator(".card")).toContainText("© 2007-2020 Mike Green");
});
