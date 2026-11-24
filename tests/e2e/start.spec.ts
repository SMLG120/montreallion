import { expect, test } from "@playwright/test";
import { answerFor } from "./oracle";
import { checkAndConfirm, startGame } from "./answer";

// Its own client address: the suite already starts close to 20 games/min (the per-IP start limit) per project.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.7" } });

test("pre-game screen: no ride and no clock until Start game; the clock starts once and survives refresh", async ({ page }) => {
  test.setTimeout(60_000);
  const starts: string[] = [];
  const serves: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (/\/api\/game$/.test(r.url())) starts.push(r.url());
    if (/\/next$/.test(r.url())) serves.push(r.url());
  });
  await page.goto("/play/unlimited");
  await expect(page.getByTestId("lobby")).toBeVisible();
  await expect(page.getByTestId("start-game")).toBeFocused();
  await page.waitForTimeout(1500);
  expect(starts).toHaveLength(0);
  expect(serves).toHaveLength(0);
  await expect(page.getByTestId("timer")).toHaveCount(0);

  // A double click creates one ride.
  await page.getByTestId("start-game").dblclick();
  await expect(page.getByTestId("prompt")).toBeVisible();
  expect(starts.length).toBeLessThanOrEqual(1);
  expect(serves).toHaveLength(1);
  await page.waitForTimeout(3000);
  const before = Number(await page.getByTestId("timer").textContent());
  expect(before).toBeLessThanOrEqual(23);

  // Refresh: the live question resumes directly with its clock still running (not reset to 25).
  const prompt = await page.getByTestId("prompt").textContent();
  await page.reload();
  await expect(page.getByTestId("prompt")).toHaveText(prompt!);
  expect(Number(await page.getByTestId("timer").textContent())).toBeLessThanOrEqual(before);
});

test("refresh between questions returns to the pre-game screen with Continue, not a running clock", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/play/unlimited");
  await startGame(page);
  const prompt = (await page.getByTestId("prompt").textContent())!.trim();
  await checkAndConfirm(page, answerFor.get(prompt)!);
  const score = await page.getByTestId("running-score").textContent();
  await page.reload();
  await expect(page.getByTestId("lobby")).toBeVisible();
  await expect(page.getByTestId("start-game")).toContainText(/stop 2 of 7/i);
  await expect(page.getByTestId("climb")).toHaveAttribute("data-steps", score!); // progress restored
  await startGame(page);
  await expect(page.getByTestId("running-score")).toHaveText(score!);
  await expect(page.getByText("Stop 2 of 7")).toBeVisible();
});

test("API: peek never creates a ride; repeated Start with one requestId is one ride", async ({ request }) => {
  const peek = await request.get("/api/game?mode=daily");
  expect(peek.ok()).toBe(true);
  const requestId = crypto.randomUUID();
  const first = await request.post("/api/game", { data: { mode: "unlimited", requestId } }); // sets the player cookie
  expect((await first.json()).sessionId).toBe(requestId);
  const [a, b] = await Promise.all([
    request.post("/api/game", { data: { mode: "unlimited", requestId } }),
    request.post("/api/game", { data: { mode: "unlimited", requestId } }),
  ]);
  const [ja, jb] = [await a.json(), await b.json()];
  expect(ja.sessionId).toBe(requestId);
  expect(jb.sessionId).toBe(requestId);
  const state = await (await request.get(`/api/game?session=${requestId}`)).json();
  expect(state.ride).toMatchObject({ index: 0, live: false, finished: false });
});
