import { expect, type Page } from "@playwright/test";

/** Double-check flow: Enter checks (nothing consumed), Enter again confirms / submits as typed. */
export async function checkAndConfirm(page: Page, value: string) {
  const input = page.getByTestId("answer-input");
  await input.fill(value);
  await input.press("Enter");
  await expect(page.getByTestId("check-panel")).toBeVisible();
  await expect(page.getByTestId("submit-answer")).toHaveAttribute("data-action", "confirm");
  await input.press("Enter");
  await expect(page.getByTestId("reveal")).toBeVisible();
}

/** Pre-game screen: nothing is timed until Start game is pressed. */
export async function startGame(page: Page) {
  await expect(page.getByTestId("lobby")).toBeVisible();
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("prompt")).toBeVisible();
}
