// Regenerates data/normalize-fixtures.json from the TypeScript normalizer (the source of truth).
import { writeFileSync } from "node:fs";
import { normalizeAnswer } from "../src/lib/game/normalize.ts";

const inputs = [
  "Berri–UQAM", "berri uqam", "BERRI-UQÀM", "Lucien-L'Allier", "Lucien L’Allier", "Côte-Sainte-Catherine",
  "Saint-Laurent", "Sainte-Anne-de-Bellevue", "Mount Royal", "Mont-Royal", "Station Crémazie", "Crémazie station",
  "Parc La Fontaine", "La Fontaine Park", "the Plateau", "Le Plateau-Mont-Royal", "L'Île-Dorval", "Pie-IX",
  "Jolicœur", "Œuvre & co", "Square-Victoria–OACI", "  spaced   out  ", "!!!", "", "Pont Jacques-Cartier",
  "Jacques Cartier Bridge", "Ville de Montréal", "City of Montreal", "Montréal-Nord", "Parc-nature du Bois-de-Liesse",
  "Île-des-Soeurs", "Île-des-Sœurs", "D'Iberville", "Guy–Concordia", "école", "ÉTS", "metro metro", "Parc parc",
];
const out = inputs.map((input) => ({ input, key: normalizeAnswer(input) }));
writeFileSync(new URL("../data/normalize-fixtures.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} fixtures`);
