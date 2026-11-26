import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../../playwright.config";
import { answerFor, bankQuestions } from "./oracle";
import { checkAndConfirm, startGame } from "./answer";

const transitPrompts = new Set(bankQuestions.filter((q) => q.category === "transit").map((q) => q.prompt.en));

async function answer(page: Page, right: boolean) {
  await expect(page.getByTestId("prompt")).toBeVisible();
  const prompt = (await page.getByTestId("prompt").textContent())!.trim();
  await checkAndConfirm(page, right ? answerFor.get(prompt)! : "Zzyzx Qwerty Plonk");
  await page.getByTestId("next-stop").click();
  return prompt;
}

test.describe("French browser", () => {
  test.use({ locale: "fr-CA" });
  test("first visit follows Accept-Language; the toggle still wins", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr-CA");
    await expect(page.getByTestId("play-daily")).toContainText("Embarquer");
    await expect(page).toHaveTitle("Montréallion");
    await page.goto("/how-to-play");
    await expect(page).toHaveTitle("Comment jouer · Montréallion");
    await page.getByTestId("lang-switch").click();
    await page.reload();
    await expect(page.getByRole("heading", { name: "How to play" })).toBeVisible();
  });
});

test("Unlimited can be limited to one category line", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("category-transit").click();
  await startGame(page);
  await expect(page).toHaveURL(/category=transit/);
  const first = await answer(page, true);
  expect(transitPrompts.has(first)).toBe(true);
  const second = await answer(page, true);
  expect(transitPrompts.has(second)).toBe(true);
  expect(second).not.toBe(first);
});

test("Unlimited can be limited to one difficulty, counted from the stored difficulty", async ({ page }) => {
  // Only approved questions are playable (the oracle also lists in-review ones).
  const hard = (bankQuestions as { difficulty?: string; reviewStatus?: string; prompt: { en: string } }[]).filter(
    (q) => q.difficulty === "hard" && q.reviewStatus === "approved",
  );
  const hardPrompts = new Set(hard.map((q) => q.prompt.en));
  await page.goto("/");
  await expect(page.getByTestId("difficulty-hard")).toContainText(String(hard.length));
  await page.getByTestId("difficulty-hard").click();
  await expect(page).toHaveURL(/difficulty=hard/);
  await expect(page.getByTestId("lobby-difficulty")).toContainText("Hard");
  await startGame(page);
  const first = await answer(page, true);
  expect(hardPrompts.has(first)).toBe(true);
  const second = await answer(page, true);
  expect(hardPrompts.has(second)).toBe(true);
});

test.describe("admin console (Postgres only)", () => {
  test.skip(!process.env.DATABASE_URL, "needs DATABASE_URL");
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "shared DB state: desktop only"));

  test("login, review a queued question, appeal a rejected answer and resolve it", async ({ page, browser }) => {
    test.setTimeout(90_000); // admin steps + a full daily (7 × check + confirm)
    await page.goto("/admin/questions");
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.getByTestId("admin-reviewer").fill("E2E");
    await page.getByTestId("admin-token").fill("wrong-token-wrong-token-wrong");
    await page.getByTestId("admin-login").click();
    await expect(page.getByTestId("admin-msg")).toBeVisible();
    await page.getByTestId("admin-reviewer").fill("E2E");
    await page.getByTestId("admin-token").fill(E2E_ADMIN_TOKEN);
    await page.getByTestId("admin-login").click();
    await expect(page.getByTestId("count-in_review")).toBeVisible();

    // Review: send a queued generated question "back to review" (keeps the playable bank unchanged).
    await page.goto("/admin/questions?status=in_review");
    await page.getByTestId("question-row").first().click();
    await page.getByTestId("review-note").fill("looked at sources");
    await page.getByRole("button", { name: "Back to review" }).click();
    await expect(page.getByTestId("admin-msg")).toHaveText("Saved.");
    await expect(page.getByText("looked at sources")).toBeVisible();

    // A player appeals a rejected answer from their daily results.
    const player = await browser.newPage();
    await player.goto("/play/daily");
    await startGame(player);
    for (let i = 0; i < 7; i++) await answer(player, i !== 0);
    await expect(player).toHaveURL(/\/results\//);
    await player.getByTestId("appeal-open").click();
    await player.getByTestId("appeal-note").fill("e2e appeal");
    await player.getByTestId("appeal-send").click();
    await expect(player.getByTestId("appeal-status")).toHaveAttribute("data-status", "open");

    // The admin rejects it; the player sees the outcome.
    await page.goto("/admin/appeals");
    const row = page.getByTestId("appeal-row").filter({ hasText: "e2e appeal" }).last();
    await expect(row.getByTestId("appeal-input")).toContainText("Zzyzx Qwerty Plonk");
    await row.getByTestId("appeal-reject").click();
    await expect(page.getByTestId("admin-msg")).toHaveText("Saved.");
    await player.reload();
    await expect(player.getByTestId("appeal-status")).toHaveAttribute("data-status", "rejected");

    await page.getByTestId("admin-logout").click();
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
