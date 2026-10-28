import { test, expect } from "./fakes.js";

const TOPICS = ["Sounds and letters", "Nouns", "Adjectives", "Pronouns", "Possessives", "Determiners", "Roots and patterns", "Verbs", "Irregular verbs", "Participles", "Pseudo-verbs", "Negation", "Imperatives", "Questions", "Prepositions", "Conjunctions", "Relative clauses", "Adverbs", "Numbers", "Time and dates", "Quantities", "Courtesies"];
// the pages' hyphens don't break a line (U+2011), so a name matches either hyphen
const topic = (page, name) => page.getByRole("button", { name: new RegExp("^" + name.replaceAll("-", "[-\u2011]") + " ") });

test("a topic opens from the grammar tab and goes back, and the tab stays open after a reload", async ({ device }) => {
  const page = await device();
  await page.getByRole("tab", { name: "Grammar" }).click();
  await topic(page, "Possessives").click();
  await expect(page.getByRole("heading", { name: "Possessives" })).toBeFocused();
  await expect(page.getByRole("table", { name: "The endings" })).toContainText("alami");

  await page.getByRole("button", { name: "All grammar topics" }).click();
  await expect(topic(page, "Possessives")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Possessives" })).toBeHidden();

  await page.reload();
  await expect(page.getByRole("tab", { name: "Grammar" })).toHaveAttribute("aria-selected", "true");
  await expect(topic(page, "Verbs")).toBeVisible();
});

test("every topic fits a phone, with all its rows open", async ({ device }) => {
  const page = await device();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("tab", { name: "Grammar" }).click();
  for (const name of TOPICS) {
    await topic(page, name).click();
    await page.locator(`#grammar .topic:not([hidden]) details`).evaluateAll((all) => all.forEach((d) => (d.open = true)));
    expect(await page.locator("html").evaluate((html) => html.scrollWidth), name).toBeLessThanOrEqual(375);
    await page.getByRole("button", { name: "All grammar topics" }).click();
  }
});
