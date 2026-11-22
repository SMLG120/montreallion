import { normalizeAnswer } from "./normalize";

export const NAME_MIN = 2;
export const NAME_MAX = 20;

// Impersonation + a short list of common slurs/profanity (EN/FR). Matched on normalized substrings.
const BLOCKED = [
  "admin", "moderat", "montreallion", "official", "officiel", "staff", "support",
  "fuck", "shit", "cunt", "nigg", "fagg", "retard", "whore", "slut", "nazi", "hitler",
  "tabarnak", "tabarnac", "calisse", "ostie", "putain", "salope", "connard", "encule",
];

export type NameCheck = { ok: true; name: string } | { ok: false; error: "length" | "chars" | "blocked" };

/** Validates a public leaderboard name. Unicode letters/digits plus space . ' ’ _ - ; no links. */
export function checkDisplayName(raw: string): NameCheck {
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if ([...name].length < NAME_MIN || [...name].length > NAME_MAX) return { ok: false, error: "length" };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’_-]*$/u.test(name)) return { ok: false, error: "chars" };
  const key = normalizeAnswer(name.replace(/[0-9]/g, (d) => "oizeasgtbg"[Number(d)]));
  const plain = normalizeAnswer(name);
  if (/www|http|\.com|\.ca/i.test(name) || BLOCKED.some((b) => key.includes(b) || plain.includes(b))) return { ok: false, error: "blocked" };
  return { ok: true, name };
}
