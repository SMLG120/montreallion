import { expect as baseExpect, test, type Page } from "@playwright/test";
import { answerFor } from "./oracle";

test.describe.configure({ mode: "serial" });
// Software WebGL (no GPU) renders a frame in ~100 ms, so UI waits here are longer than in the 2D specs.
test.use({ actionTimeout: 20_000 });
const expect = baseExpect.configure({ timeout: 20_000 });

async function startGame(page: Page) {
  await expect(page.getByTestId("lobby")).toBeVisible();
  await page.getByTestId("start-game").click();
  await expect(page.getByTestId("prompt")).toBeVisible();
}
/** Same double-check flow as answer.ts, with this spec's longer waits. */
async function checkAndConfirm(page: Page, value: string) {
  const input = page.getByTestId("answer-input");
  await input.fill(value);
  await input.press("Enter");
  await expect(page.getByTestId("submit-answer")).toHaveAttribute("data-action", "confirm");
  await input.press("Enter");
  await expect(page.getByTestId("reveal")).toBeVisible();
}

const stage = (page: Page) => page.getByTestId("climb-stage");
const canvas = (page: Page) => page.locator('[data-testid="climb-stage"] canvas');

async function settledS(page: Page) {
  await expect(canvas(page)).toHaveAttribute("data-s", /\d/, { timeout: 15_000 });
  return Number(await canvas(page).getAttribute("data-s"));
}

test("3D: full-viewport scene from the pre-game screen; the climber travels only after a confirmed answer", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/play/unlimited");
  await expect(page.getByTestId("lobby")).toBeVisible();
  await expect(stage(page)).toHaveAttribute("data-mode", "3d");
  await expect(canvas(page)).toBeVisible();
  // The canvas fills the viewport.
  const vp = page.viewportSize()!;
  await expect.poll(async () => (await canvas(page).boundingBox())?.width).toBeGreaterThanOrEqual(vp.width - 1);
  await expect.poll(async () => (await canvas(page).boundingBox())?.height).toBeGreaterThanOrEqual(vp.height - 1);
  expect(await settledS(page)).toBe(0);

  await startGame(page);
  // A double-check never moves the climber.
  const prompt = (await page.getByTestId("prompt").textContent())!.trim();
  const input = page.getByTestId("answer-input");
  await input.fill(answerFor.get(prompt)!);
  await input.press("Enter");
  await expect(page.getByTestId("check-panel")).toBeVisible();
  await page.waitForTimeout(800);
  expect(Number(await canvas(page).getAttribute("data-s"))).toBe(0);
  await input.press("Enter");
  await expect(page.getByTestId("reveal")).toHaveAttribute("data-status", "correct");
  const steps = Number(await page.getByTestId("climb").getAttribute("data-steps"));
  expect(steps).toBeGreaterThan(0);
  // It walks there (several frames), then settles exactly where the server score puts it.
  await expect(async () => expect(Number(await canvas(page).getAttribute("data-s"))).toBeGreaterThan(0)).toPass({ timeout: 20_000 });
  const s1 = await settledS(page);

  // A miss: no elevation gain.
  await page.getByTestId("next-stop").click();
  await checkAndConfirm(page, "Zzyzx Qwerty Plonk Three");
  await expect(page.getByTestId("reveal")).toHaveAttribute("data-status", "incorrect");
  await page.waitForTimeout(1500);
  expect(Number(await canvas(page).getAttribute("data-s"))).toBe(s1);

  // Reset camera is available; reload restores progress in place (no replayed climb).
  await page.getByTestId("reset-camera").click();
  await page.reload();
  await expect(page.getByTestId("lobby")).toBeVisible();
  await expect(async () => expect(Number(await canvas(page).getAttribute("data-s"))).toBe(s1)).toPass({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test("3D: settings switch to the simple view and back; GPU memory doesn't grow across rounds", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/play/unlimited");
  await startGame(page);
  await settledS(page);
  const geo0 = Number(await canvas(page).getAttribute("data-geometries"));
  for (let i = 0; i < 3; i++) {
    const prompt = (await page.getByTestId("prompt").textContent())!.trim();
    await checkAndConfirm(page, answerFor.get(prompt)!);
    await page.waitForTimeout(500);
    await page.getByTestId("next-stop").click();
    await expect(page.getByTestId("prompt")).toBeVisible();
  }
  await expect(async () => expect(Number(await canvas(page).getAttribute("data-geometries"))).toBeLessThanOrEqual(geo0 + 2)).toPass({ timeout: 20_000 });

  await page.getByTestId("scene-settings").click();
  await page.getByTestId("gfx-2d").check();
  await expect(stage(page)).toHaveAttribute("data-mode", "2d");
  await expect(canvas(page)).toHaveCount(0);
  await expect(page.getByTestId("climb")).toBeVisible(); // the simple climb takes over
  await page.getByTestId("gfx-auto").check();
  await expect(stage(page)).toHaveAttribute("data-mode", "3d");
  await expect(canvas(page)).toBeVisible();
});
