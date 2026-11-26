export type Locale = "en" | "fr";
export type Localized = { en: string; fr: string };

export const CATEGORY_IDS = ["transit", "boroughs", "parks", "food", "history", "festivals", "sports", "universities", "winter", "slang"] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** city = City of Montréal; island/agglomeration = whole island; greater = CMM region; province = Québec. */
export type GeoScope = "city" | "island" | "agglomeration" | "greater" | "province";

export type AnswerDef = {
  id: string;
  en: string;
  fr?: string;
  aliases: string[];
  /** ESTIMATE of relative familiarity (1-100): editor-entered (seed) or data-derived (ETL). Not measured play data. */
  est: number;
  /** Provenance ids, e.g. "wikidata:Q123", "gtfs:STATION_M146". */
  refs?: string[];
};

export type QuestionDef = {
  id: string;
  category: CategoryId;
  scope: GeoScope;
  prompt: Localized;
  eligibility: Localized;
  verification: "source-checked" | "editor-curated";
  reviewStatus: "draft" | "in_review" | "approved" | "rejected";
  /** Editorial difficulty (Phase H); independent of answer rarity. */
  difficulty?: "easy" | "medium" | "hard";
  sources: { title: string; url: string; license: string; retrieved: string }[];
  /** Inputs that could refer to several answers; the player is asked to be more specific. */
  ambiguous?: string[];
  answers: AnswerDef[];
  estBasis?: string;
  generator?: { template: string; concept: string; contentHash: string };
};

export type Tier = "legend" | "gem" | "expert" | "regular" | "tourist";

export type AnswerOutcome =
  | { status: "correct"; answerId: string; matchedBy: "exact" | "fuzzy"; score: number; tier: Tier; share: number }
  | { status: "incorrect" | "expired"; score: 0 };

/** Public, answer-free view of a question sent to clients before answering. */
export type PublicQuestion = {
  id: string;
  index: number;
  category: CategoryId;
  scope: GeoScope;
  prompt: Localized;
  eligibility: Localized;
  answerCount: number;
  verification: QuestionDef["verification"];
};
