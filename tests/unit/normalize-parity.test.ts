import { describe, expect, it } from "vitest";
import fixtures from "../../data/normalize-fixtures.json";
import { normalizeAnswer } from "@/lib/game/normalize";

// The Python ETL (etl/montreallion_etl/normalize.py) is tested against the same file.
describe("normalizer fixtures (shared with the Python ETL)", () => {
  it.each(fixtures)("$input", ({ input, key }) => {
    expect(normalizeAnswer(input)).toBe(key);
  });
});
