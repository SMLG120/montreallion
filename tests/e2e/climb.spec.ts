import { expect, test } from "@playwright/test";
import { answerFor } from "./oracle";
import { checkAndConfirm, startGame } from "./answer";

test("climber: climbs by the score, holds on a miss, keeps its look after reload", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByTestId("play-daily").click();
  await startGame(page);
  const climb = page.getByTestId("climb");
  await expect(climb).toHaveAttribute("data-steps", "0");

  // Customize, then reload: the appearance persists on this device.
  await page.getByTestId("climb-customize").click();
  await page.getByTestId("look-jacket-j2").click();
  await expect(page.getByTestId("look-jacket-j2")).toHaveAttribute("aria-pressed", "true");

  for (let i = 0; i < 3; i++) {
    await expect(page.getByTestId("prompt")).toBeVisible();
    const before = Number(await climb.getAttribute("data-steps"));
    const prompt = (await page.getByTestId("prompt").textContent())!.trim();
    await checkAndConfirm(page, i === 1 ? "definitely not a real answer" : answerFor.get(prompt)!);
    await expect(page.getByTestId("reveal")).toBeVisible();
    const running = Number(await page.getByTestId("running-score").textContent());
    await expect(climb).toHaveAttribute("data-steps", String(running)); // steps == score, exactly
    if (i === 1) expect(Number(await climb.getAttribute("data-steps"))).toBe(before); // a miss: no climb, no fall
    await page.getByTestId("next-stop").click();
  }

  const steps = await climb.getAttribute("data-steps");
  await page.reload();
  await expect(page.getByTestId("climb")).toHaveAttribute("data-steps", steps!); // progress restored with the ride
  await page.getByTestId("climb-customize").click();
  await expect(page.getByTestId("look-jacket-j2")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("climb scene renders with an accessible description", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("play-daily").click();
    await startGame(page);
    await expect(page.getByTestId("climb").getByRole("img")).toHaveAttribute("aria-label", /\d+ of 350|\d+ marches sur 350/);
  });
});
