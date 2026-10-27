import { test, expect, song, wordIn } from "./fakes.js";

test("a verb's card opens its tables from lisaanmasry.org, credited, and other words have none", async ({ device }) => {
  const page = await device({ songs: [song()] });
  await page.setViewportSize({ width: 375, height: 812 });
  await wordIn(page, 1, "اللي").click();
  await expect(page.locator(".card")).toBeVisible();
  await expect(page.getByText("Conjugation")).toHaveCount(0);

  await wordIn(page, 1, "حصل").click();
  await page.getByText("Conjugation").click();
  await expect(page.getByRole("table", { name: "Perfect", exact: true })).toContainText("hiya Hasalit");
  await expect(page.getByRole("table", { name: "Bi-Imperfect" })).toContainText("biyiHSal");
  await expect(page.getByRole("link", { name: "lisaanmasry.org" })).toHaveAttribute("href", "https://www.lisaanmasry.org/online/verb.php?ui=en&id=1");
  await expect(page.locator(".card")).toContainText("© 2007-2020 Mike Green");
  expect(await page.locator("html").evaluate((html) => html.scrollWidth)).toBeLessThanOrEqual(375);
});
