import { expect, test } from "@playwright/test";
import { answerFor } from "./oracle";
import { checkAndConfirm, startGame } from "./answer";

test("map: a finished ride shows its revealed answers; unknown rides reveal nothing", async ({ page, request }) => {
  test.setTimeout(90_000);
  const missing = await request.get("/api/game/00000000-0000-4000-8000-000000000000/map");
  expect(missing.status()).toBe(404);

  await page.goto("/");
  await page.getByTestId("play-daily").click();
  await startGame(page);
  for (let i = 0; i < 7; i++) {
    await expect(page.getByTestId("prompt")).toBeVisible();
    const prompt = (await page.getByTestId("prompt").textContent())!.trim();
    await checkAndConfirm(page, answerFor.get(prompt)!);
    await page.getByTestId("next-stop").click();
  }
  await expect(page).toHaveURL(/\/results\//);
  const id = page.url().split("/results/")[1];
  const res = await request.get(`/api/game/${id}/map`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.rounds).toHaveLength(7);
  for (const r of body.rounds) expect(body.pins.filter((p: { round: number }) => p.round === r.round).length).toBeLessThanOrEqual(6);
  for (const key of ["score", "est", "id", "aliases"]) expect(JSON.stringify(body)).not.toContain(`"${key}":`);

  await page.getByTestId("results-map").click();
  await expect(page).toHaveURL(new RegExp(`/map\\?game=${id}`));
  await expect(page.getByTestId("ride-panel")).toBeVisible();
  if (body.pins.length) await expect(page.getByTestId("ride-pin").first()).toBeVisible();
});
