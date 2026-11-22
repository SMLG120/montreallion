import { boardDate, getBoard } from "@/lib/game/board";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

/** GET /api/leaderboard?date=YYYY-MM-DD — finished daily rides, ranked. Never exposes player ids. */
export async function GET(req: Request) {
  if (!(await rateLimit("board", 60))) return tooMany();
  try {
    const date = boardDate(new URL(req.url).searchParams.get("date"));
    return json(await getBoard(date, await getPlayerId(false)));
  } catch (e) {
    return errorResponse(e);
  }
}
