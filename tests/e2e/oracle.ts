import seed from "../../data/seed/questions.json";
import generated from "../../data/generated/questions.generated.json";

/** Test oracle built from the bundled bank files (the browser never receives answer lists). */
export const bankQuestions = [...seed.questions, ...generated.questions] as {
  category: string;
  prompt: { en: string; fr: string };
  answers: { en: string }[];
}[];

export const answerFor = new Map<string, string>();
for (const q of bankQuestions) for (const p of [q.prompt.en, q.prompt.fr]) answerFor.set(p, q.answers[0].en);
