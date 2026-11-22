import "server-only";
import { dateKey } from "./daily";
import { defaultStore } from "./store";

export const BOARD_LIMIT = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD no later than today (Montréal time); otherwise today. */
export function boardDate(raw: string | null | undefined, now = new Date()): string {
  const today = dateKey(now);
  if (!raw || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T12:00:00Z`)) || raw > today) return today;
  return raw;
}

export async function getBoard(date: string, playerId: string | null) {
  const store = await defaultStore();
  const [board, name] = await Promise.all([store.leaderboard(date, playerId, BOARD_LIMIT), playerId ? store.getDisplayName(playerId) : null]);
  return { ...board, today: dateKey(new Date()), yourName: name };
}
