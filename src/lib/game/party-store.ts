import "server-only";
import type { Sql } from "@/lib/server/db";
import { isExpired, ROOM_TTL_MS, type RoomState } from "./party";

export interface PartyStore {
  readonly kind: "memory" | "postgres";
  /** Inserts a new room; false if the code is taken by a live room. */
  create(s: RoomState): Promise<boolean>;
  get(code: string): Promise<RoomState | null>;
  /** Runs `fn` on the latest state with exclusive access and saves it atomically (a throw saves nothing). */
  mutate<T>(code: string, fn: (s: RoomState) => T): Promise<{ state: RoomState; result: T } | null>;
}

export function createMemoryPartyStore(now = () => Date.now()): PartyStore {
  const rooms = new Map<string, RoomState>();
  const locks = new Map<string, Promise<unknown>>();
  const withLock = <T>(k: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(k) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(k, tail);
    void tail.then(() => locks.get(k) === tail && locks.delete(k));
    return run;
  };
  const live = (code: string) => {
    const s = rooms.get(code);
    if (s && isExpired(s, now())) {
      rooms.delete(code);
      return undefined;
    }
    return s;
  };
  return {
    kind: "memory",
    create: (s) =>
      withLock(s.code, async () => {
        if (live(s.code)) return false;
        if (rooms.size > 2000) for (const k of [...rooms.keys()]) live(k);
        rooms.set(s.code, structuredClone(s));
        return true;
      }),
    async get(code) {
      const s = live(code);
      return s ? structuredClone(s) : null;
    },
    mutate: (code, fn) =>
      withLock(code, async () => {
        const cur = live(code);
        if (!cur) return null;
        const draft = structuredClone(cur);
        const result = fn(draft);
        draft.updatedAt = now();
        rooms.set(code, structuredClone(draft));
        return { state: draft, result };
      }),
  };
}

export function createPostgresPartyStore(sql: Sql, now = () => Date.now()): PartyStore {
  const ttl = `${Math.round(ROOM_TTL_MS / 1000)} seconds`;
  return {
    kind: "postgres",
    async create(s) {
      // Reuse a code only if its old room has expired.
      const rows = await sql`
        insert into party_rooms (code, state, status) values (${s.code}, ${sql.json(s as never)}, ${s.status})
        on conflict (code) do update set state = excluded.state, status = excluded.status, created_at = now(), updated_at = now()
          where party_rooms.updated_at < now() - ${ttl}::interval
        returning code`;
      // Opportunistic cleanup of long-dead rooms.
      if (Math.random() < 0.05) await sql`delete from party_rooms where updated_at < now() - interval '1 day'`;
      return rows.length === 1;
    },
    async get(code) {
      const [r] = await sql<{ state: RoomState }[]>`select state from party_rooms where code = ${code}`;
      return r && !isExpired(r.state, now()) ? r.state : null;
    },
    async mutate(code, fn) {
      return sql.begin(async (tx) => {
        const [r] = await tx<{ state: RoomState }[]>`select state from party_rooms where code = ${code} for update`;
        if (!r || isExpired(r.state, now())) return null;
        const s = r.state;
        const result = fn(s);
        s.updatedAt = now();
        await tx`update party_rooms set state = ${tx.json(s as never)}, status = ${s.status}, updated_at = now() where code = ${code}`;
        return { state: s, result };
      }) as Promise<{ state: RoomState; result: ReturnType<typeof fn> } | null>;
    },
  };
}

const g = globalThis as unknown as { __mlParty?: PartyStore };

export async function defaultPartyStore(): Promise<PartyStore> {
  if (g.__mlParty) return g.__mlParty;
  const { getSql } = await import("@/lib/server/db");
  const sql = getSql();
  g.__mlParty = sql ? createPostgresPartyStore(sql) : createMemoryPartyStore();
  return g.__mlParty;
}
