// A small stand in for Cloudflare D1 on Node's own SQLite, for tests that need real SQL.
import { DatabaseSync } from "node:sqlite";

export function memoryD1(schema: string[] = []): D1Database {
	const db = new DatabaseSync(":memory:");
	for (const s of schema) db.exec(s);
	const stmt = (sql: string, args: unknown[] = []): any => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		run: async () => {
			const r = db.prepare(sql).run(...(args as any[]));
			return { success: true, meta: { changes: Number(r.changes) } };
		},
		first: async (col?: string) => {
			const row = db.prepare(sql).get(...(args as any[])) as any;
			return row ? (col ? row[col] : { ...row }) : null;
		},
		all: async () => ({ results: (db.prepare(sql).all(...(args as any[])) as any[]).map((r) => ({ ...r })) }),
	});
	return { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())), exec: async (s: string) => db.exec(s) } as unknown as D1Database;
}
