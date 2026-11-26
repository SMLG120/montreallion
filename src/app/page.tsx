import { getBank } from "@/lib/game/bank";
import { dateKey } from "@/lib/game/daily";
import { MIN_CATEGORY_QUESTIONS } from "@/lib/game/engine";
import { CATEGORY_IDS } from "@/lib/game/types";
import { HomeView } from "@/components/pages/home-view";

export default async function Home() {
  const bank = await getBank();
  const categories = CATEGORY_IDS.map((id) => ({ id, count: bank.questions.filter((q) => q.category === id).length })).filter(
    (c) => c.count >= MIN_CATEGORY_QUESTIONS,
  );
  // Difficulty counts come from the stored difficulty of the live reviewed bank; levels below the minimum are hidden.
  const difficulties = (["easy", "medium", "hard"] as const)
    .map((id) => ({ id, count: bank.questions.filter((q) => q.difficulty === id).length }))
    .filter((d) => d.count >= MIN_CATEGORY_QUESTIONS);
  return <HomeView questionCount={bank.questions.length} today={dateKey()} categories={categories} difficulties={difficulties} />;
}
