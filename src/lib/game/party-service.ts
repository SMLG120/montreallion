import "server-only";
import { createHash, randomInt } from "node:crypto";
import { getBank } from "./bank";
import { advance, CODE_ALPHABET, createRoom, join, leave, needsTouch, PartyError, start, submit, tick, touch, view, type RoomState } from "./party";
import { defaultPartyStore } from "./party-store";
import type { CategoryId } from "./types";

const now = () => Date.now();
const secureRand = () => randomInt(0, 2 ** 31) / 2 ** 31;

function newCode(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return s;
}

export async function createParty(playerId: string, name: string, settings: RoomState["settings"]): Promise<string> {
  const store = await defaultPartyStore();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    if (await store.create(createRoom(code, playerId, name, settings, now()))) return code;
  }
  throw new Error("could not allocate a room code");
}

/** Read path for polling: writes only when a transition is due or the caller's presence needs refreshing. */
export async function getPartyView(code: string, playerId: string | null) {
  const store = await defaultPartyStore();
  const bank = await getBank();
  let s = await store.get(code);
  if (!s) throw new PartyError("not_found");
  const t = now();
  const probe = structuredClone(s);
  if (tick(probe, t) || (playerId && needsTouch(s, playerId, t))) {
    const out = await store.mutate(code, (st) => {
      tick(st, t);
      if (playerId) touch(st, playerId, t);
    });
    if (!out) throw new PartyError("not_found");
    s = out.state;
  }
  return view(s, bank, playerId ?? "", t);
}

/** Stable hash of a view for ETag/304 polling. */
export function viewTag(v: unknown): string {
  return `"${createHash("sha1").update(JSON.stringify(v)).digest("base64url").slice(0, 20)}"`;
}

type Action =
  | { action: "join"; name: string }
  | { action: "start" }
  | { action: "answer"; round: number; answer: string }
  | { action: "next" }
  | { action: "leave" };

export async function actOnParty(code: string, playerId: string, a: Action) {
  const store = await defaultPartyStore();
  const bank = await getBank();
  const t = now();
  const out = await store.mutate(code, (s) => {
    tick(s, t);
    if (a.action !== "join" && a.action !== "leave") touch(s, playerId, t);
    switch (a.action) {
      case "join":
        return join(s, playerId, a.name, t);
      case "start":
        return start(s, playerId, bank, secureRand, t);
      case "answer":
        return submit(s, playerId, bank, a.round, a.answer, t);
      case "next":
        return advance(s, playerId, t);
      case "leave":
        return leave(s, playerId, t);
    }
  });
  if (!out) throw new PartyError("not_found");
  return { result: out.result ?? null, view: view(out.state, bank, playerId, t) };
}

export type { CategoryId };
