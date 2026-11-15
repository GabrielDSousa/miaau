/**
 * D1 falso, apoiado em `node:sqlite`.
 *
 * Prova de propósito: o SQL dos handlers roda contra o **schema real** em
 * memória. Se o `db/schema.sql` e a query divergirem, o teste quebra — que é o
 * tipo de erro que um mock de SQL nunca pegaria.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Like, D1StatementLike } from "../../ingest.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");

export class FakeStatement implements D1StatementLike {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1StatementLike {
    return new FakeStatement(this.db, this.sql, values);
  }

  async run(): Promise<unknown> {
    const res = this.db.prepare(this.sql).run(...(this.params as never[]));
    return { changes: Number(res.changes) };
  }

  async all(): Promise<{ results?: unknown[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.params as never[])) };
  }
}

export class FakeD1 implements D1Like {
  readonly db: DatabaseSync;

  constructor(schema = SCHEMA) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(schema);
  }

  prepare(sql: string): D1StatementLike {
    return new FakeStatement(this.db, sql);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }

  /** Atalho para asserção em teste: uma linha. */
  one<T>(sql: string, ...params: unknown[]): T {
    return this.db.prepare(sql).get(...(params as never[])) as T;
  }

  /** Atalho: todas as linhas. */
  many<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
