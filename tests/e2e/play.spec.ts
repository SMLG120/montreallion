import { expect, test, type Page } from "@playwright/test";
import { answerFor } from "./oracle";

async function answerCurrent(page: Page, mode: "right" | "wrong") {
  const prompt = (await page.getByTestId("prompt").textContent())!.trim();
  const value = mode === "right" ? answerFor.get(prompt) : "definitely not a real answer";
  expect(value, `no oracle answer for "${prompt}"`).toBeTruthy();
  await page.getByTestId("answer-input").fill(value!);
  await page.getByTestId("answer-input").press("Enter");
  await expect(page.getByTestId("reveal")).toBeVisible();
}

test("plays a full daily game: 7 stops, server scoring, results and resume lock", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("play-daily").click();
  for (let i = 0; i < 7; i++) {
    await expect(page.getByTestId("prompt")).toBeVisible();
    await answerCurrent(page, i === 3 ? "wrong" : "right");
    await expect(page.getByTestId("reveal")).toHaveAttribute("data-status", i === 3 ? "incorrect" : "correct");
    await page.getByTestId("next-stop").click();
  }
  await expect(page).toHaveURL(/\/results\//);
  const score = Number((await page.getByTestId("final-score").textContent())!.split("/")[0].trim());
  expect(score).toBeGreaterThanOrEqual(60); // 6 correct answers × ≥10
  expect(score).toBeLessThanOrEqual(600);

  // Replaying today's daily goes straight back to the same results.
  const url = page.url();
  await page.goto("/play/daily");
  await expect(page).toHaveURL(url);
});

test("daily results link to the leaderboard, where a player can set a name", async ({ page }) => {
  await page.goto("/play/daily");
  for (let i = 0; i < 7; i++) {
    await expect(page.getByTestId("prompt")).toBeVisible();
    await answerCurrent(page, "right");
    await expect(page.getByTestId("rarity-basis").first()).toBeVisible();
    await page.getByTestId("next-stop").click();
  }
  await expect(page).toHaveURL(/\/results\//);
  await expect(page.getByTestId("today-count")).toHaveCount(7);
  await page.getByTestId("daily-rank").click();
  await expect(page).toHaveURL(/\/leaderboard\?date=/);
  const you = page.getByTestId("board-you");
  await expect(you).toBeVisible();
  await expect(you).toContainText(/Anonymous #\d{4}/);

  await page.getByTestId("display-name").fill("Admin");
  await page.getByTestId("save-name").click();
  await expect(page.getByTestId("name-msg")).toContainText("another name");

  const name = `Rider ${test.info().project.name.slice(0, 6)}`;
  await page.getByTestId("display-name").fill(name);
  await page.getByTestId("save-name").click();
  await expect(you).toContainText(name);
  await page.reload();
  await expect(page.getByTestId("board-you")).toContainText(name);
  await expect(page.getByTestId("display-name")).toHaveValue(name);
});

test("switching EN/FR mid-question keeps the game state", async ({ page }) => {
  await page.goto("/play/unlimited");
  await answerCurrent(page, "right");
  await page.getByTestId("next-stop").click();
  const enPrompt = await page.getByTestId("prompt").textContent();
  await page.getByTestId("answer-input").fill("brouillon");
  await page.getByTestId("lang-switch").click();
  const frPrompt = await page.getByTestId("prompt").textContent();
  expect(frPrompt).not.toBe(enPrompt);
  expect(answerFor.get(frPrompt!.trim())).toBe(answerFor.get(enPrompt!.trim()));
  await expect(page.getByTestId("answer-input")).toHaveValue("brouillon");
  await expect(page.getByText("Station 2 sur 7")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr-CA");
});

test("accent-insensitive and typo-tolerant matching through the UI", async ({ page }) => {
  await page.goto("/play/unlimited");
  const prompt = (await page.getByTestId("prompt").textContent())!.trim();
  const plain = answerFor.get(prompt)!.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  await page.getByTestId("answer-input").fill(plain);
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("reveal")).toHaveAttribute("data-status", "correct");
});

test("static pages render in both languages", async ({ page }) => {
  await page.goto("/how-to-play");
  await expect(page.getByRole("heading", { name: "How to play" })).toBeVisible();
  await page.getByTestId("lang-switch").click();
  await expect(page.getByRole("heading", { name: "Comment jouer" })).toBeVisible();
  await page.goto("/leaderboard");
  await expect(page.getByRole("heading", { name: "Classement" })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
});
