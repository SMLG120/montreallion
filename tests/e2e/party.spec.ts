import { expect, test, type Page } from "@playwright/test";
import seed from "../../data/seed/questions.json";

const answerFor = new Map<string, string>();
for (const q of seed.questions) for (const p of [q.prompt.en, q.prompt.fr]) answerFor.set(p, q.answers[0].en);

async function answer(page: Page, right: boolean) {
  await expect(page.getByTestId("prompt")).toBeVisible();
  const prompt = (await page.getByTestId("prompt").textContent())!.trim();
  // A wrong answer unique to this spec (other specs may accept theirs as an alias in a shared DB).
  await page.getByTestId("answer-input").fill(right ? answerFor.get(prompt)! : "Party Wrong Answer Xyzzy");
  await page.getByTestId("answer-submit").click();
}

test("two players: create, join by code, play 3 live rounds, see each other's answers and final standings", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await host.goto("/party");
  await host.getByTestId("party-name").fill("Hôte");
  await host.getByTestId("party-rounds").selectOption("3");
  await host.getByTestId("party-create").click();
  await expect(host).toHaveURL(/\/party\/[A-Z2-9]{5}$/);
  const code = (await host.getByTestId("party-code-display").textContent())!.trim();

  // Guest joins via the home form with the code; a clashing name is refused.
  await guest.goto("/party");
  await guest.getByTestId("party-name").fill("hote");
  await guest.getByTestId("party-code").fill(code);
  await guest.getByTestId("party-join").click();
  await expect(guest.getByTestId("party-error")).toBeVisible();
  await guest.getByTestId("party-name").fill("Invitée");
  await guest.getByTestId("party-join").click();
  await expect(guest).toHaveURL(new RegExp(`/party/${code}$`));
  await expect(guest.getByTestId("party-waiting-host")).toContainText("Hôte");
  await expect(host.getByTestId("party-members")).toContainText("Invitée"); // via polling

  await host.getByTestId("party-start").click();
  for (let r = 0; r < 3; r++) {
    await answer(host, true);
    await expect(host.getByTestId("party-locked")).toBeVisible();
    // The host's answer must not leak to the guest before the round closes.
    await expect(guest.getByTestId("party-reveal")).toHaveCount(0);
    await answer(guest, r !== 1);
    for (const p of [host, guest]) {
      await expect(p.getByTestId("party-reveal")).toBeVisible();
      await expect(p.getByTestId("reveal-answer")).toHaveCount(2);
    }
    await host.getByTestId("party-next").click();
  }
  for (const p of [host, guest]) {
    await expect(p.getByTestId("party-finished")).toBeVisible();
    await expect(p.getByTestId("party-members")).toContainText("Hôte");
    await expect(p.getByTestId("party-members")).toContainText("Invitée");
  }
  // Host answered all 3 correctly, guest missed one: host leads.
  await expect(host.getByTestId("party-members").locator("li").first()).toContainText("Hôte");

  // A late visitor can't join a started game.
  const late = await (await browser.newContext()).newPage();
  await late.goto(`/party/${code}`);
  await expect(late.getByText(/already started|déjà commencée/)).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});

test("unknown room codes show a friendly message", async ({ page }) => {
  await page.goto("/party/ZZZZ2");
  await expect(page.getByTestId("party-missing")).toBeVisible();
});
