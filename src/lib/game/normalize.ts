/**
 * Builds a comparison key that ignores case, accents, punctuation, spacing,
 * and common filler words, so "Berri-UQAM", "berri uqam" and "BERRI–UQÀM" collide.
 */
const FILLER_PREFIX = /^(the|le|la|les|l|station|metro|pont|parc|park|ville de|city of)\s+/;
const FILLER_SUFFIX = /\s+(station|metro|bridge|park)$/;

export function normalizeAnswer(raw: string): string {
  return normalizeWords(raw).replace(/\s+/g, "");
}

/** Same pipeline as `normalizeAnswer` but keeps word boundaries (single spaces). */
export function normalizeWords(raw: string): string {
  let s = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/&/g, " and ")
    .replace(/['’`´]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  s = s.replace(/\bsainte\b/g, "ste").replace(/\bsaint\b/g, "st").replace(/\bmount\b/g, "mont");
  // Common abbreviations: "av. du Parc", "boul. St-Laurent", "Mt Royal", "Mtl".
  s = s.replace(/\b(av|ave)\b/g, "avenue").replace(/\b(boul|blvd|bd)\b/g, "boulevard").replace(/\bmt\b/g, "mont").replace(/\bmtl\b/g, "montreal");

  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(FILLER_PREFIX, "").replace(FILLER_SUFFIX, "");
    if (s === before) break;
  }
  return s.replace(/\s+/g, " ");
}

/** Optimal string alignment (Damerau-Levenshtein with adjacent transpositions), early-exit at `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const r = new Array<number>(cols).fill(0);
    r[0] = i;
    return r;
  });
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2][j - 2] + 1);
      }
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[rows - 1][cols - 1];
}

/** Conservative typo budget by key length: short keys must match exactly. */
export function typoBudget(len: number): number {
  if (len < 5) return 0;
  if (len < 9) return 1;
  return 2;
}
