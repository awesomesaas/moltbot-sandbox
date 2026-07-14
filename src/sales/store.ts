/**
 * Persistence for the Sales Coaching module.
 *
 * The service depends only on the `SalesStore` interface. Two
 * implementations are provided:
 *   - `D1SalesStore`   — Cloudflare D1 (SQLite), for production.
 *   - `MemorySalesStore` — in-process, for unit tests.
 *
 * The D1 schema is self-initializing via `CREATE TABLE IF NOT EXISTS`, so
 * no migration tooling is required.
 */

import type { CoachingPlan, Pip, Rep, RepWeek } from './types';

export interface SalesStore {
  /** Ensure the backing schema exists. Safe to call repeatedly. */
  init(): Promise<void>;

  listReps(): Promise<Rep[]>;
  getRep(id: string): Promise<Rep | null>;
  upsertRep(rep: Rep): Promise<Rep>;

  /** Weeks for a rep, oldest-first. */
  getWeeks(repId: string): Promise<RepWeek[]>;
  getWeek(repId: string, weekOf: string): Promise<RepWeek | null>;
  saveWeek(week: RepWeek): Promise<void>;

  saveCoachingPlan(plan: CoachingPlan): Promise<void>;
  getCoachingPlan(repId: string, weekOf: string): Promise<CoachingPlan | null>;
  getLatestCoachingPlan(repId: string): Promise<CoachingPlan | null>;

  getPip(id: string): Promise<Pip | null>;
  getActivePip(repId: string): Promise<Pip | null>;
  listPips(repId?: string): Promise<Pip[]>;
  savePip(pip: Pip): Promise<Pip>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + ephemeral fallback)
// ---------------------------------------------------------------------------

export class MemorySalesStore implements SalesStore {
  private reps = new Map<string, Rep>();
  private weeks = new Map<string, RepWeek>(); // key: repId|weekOf
  private plans = new Map<string, CoachingPlan>(); // key: repId|weekOf
  private pips = new Map<string, Pip>();

  private static wkey(repId: string, weekOf: string): string {
    return `${repId}|${weekOf}`;
  }

  async init(): Promise<void> {
    /* no-op */
  }

  async listReps(): Promise<Rep[]> {
    return [...this.reps.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRep(id: string): Promise<Rep | null> {
    return this.reps.get(id) ?? null;
  }

  async upsertRep(rep: Rep): Promise<Rep> {
    this.reps.set(rep.id, { ...rep });
    return rep;
  }

  async getWeeks(repId: string): Promise<RepWeek[]> {
    return [...this.weeks.values()]
      .filter((w) => w.repId === repId)
      .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
  }

  async getWeek(repId: string, weekOf: string): Promise<RepWeek | null> {
    return this.weeks.get(MemorySalesStore.wkey(repId, weekOf)) ?? null;
  }

  async saveWeek(week: RepWeek): Promise<void> {
    this.weeks.set(MemorySalesStore.wkey(week.repId, week.weekOf), { ...week });
  }

  async saveCoachingPlan(plan: CoachingPlan): Promise<void> {
    this.plans.set(MemorySalesStore.wkey(plan.repId, plan.weekOf), { ...plan });
  }

  async getCoachingPlan(repId: string, weekOf: string): Promise<CoachingPlan | null> {
    return this.plans.get(MemorySalesStore.wkey(repId, weekOf)) ?? null;
  }

  async getLatestCoachingPlan(repId: string): Promise<CoachingPlan | null> {
    const plans = [...this.plans.values()]
      .filter((p) => p.repId === repId)
      .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
    return plans.length > 0 ? plans[plans.length - 1] : null;
  }

  async getPip(id: string): Promise<Pip | null> {
    return this.pips.get(id) ?? null;
  }

  async getActivePip(repId: string): Promise<Pip | null> {
    const active = [...this.pips.values()].filter(
      (p) => p.repId === repId && p.status === 'pip_active',
    );
    active.sort((a, b) => a.startedWeek.localeCompare(b.startedWeek));
    return active.length > 0 ? active[active.length - 1] : null;
  }

  async listPips(repId?: string): Promise<Pip[]> {
    return [...this.pips.values()]
      .filter((p) => (repId ? p.repId === repId : true))
      .sort((a, b) => b.startedWeek.localeCompare(a.startedWeek));
  }

  async savePip(pip: Pip): Promise<Pip> {
    this.pips.set(pip.id, { ...pip });
    return pip;
  }
}

// ---------------------------------------------------------------------------
// D1 implementation
// ---------------------------------------------------------------------------

/** DDL for the D1 schema (exported for tests / documentation). */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS sales_reps (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT,
     crm_id TEXT,
     start_date TEXT,
     weekly_quota REAL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sales_rep_weeks (
     rep_id TEXT NOT NULL,
     week_of TEXT NOT NULL,
     metrics TEXT NOT NULL,
     source TEXT NOT NULL,
     ingested_at TEXT NOT NULL,
     PRIMARY KEY (rep_id, week_of)
   )`,
  `CREATE TABLE IF NOT EXISTS sales_coaching_plans (
     rep_id TEXT NOT NULL,
     week_of TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (rep_id, week_of)
   )`,
  `CREATE TABLE IF NOT EXISTS sales_pips (
     id TEXT PRIMARY KEY,
     rep_id TEXT NOT NULL,
     status TEXT NOT NULL,
     started_week TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

interface RepRow {
  id: string;
  name: string;
  email: string | null;
  crm_id: string | null;
  start_date: string | null;
  weekly_quota: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function rowToRep(r: RepRow): Rep {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? undefined,
    crmId: r.crm_id ?? undefined,
    startDate: r.start_date ?? undefined,
    weeklyQuota: r.weekly_quota ?? undefined,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Columns added after the initial schema shipped, applied idempotently. */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'sales_reps', column: 'weekly_quota', ddl: 'ALTER TABLE sales_reps ADD COLUMN weekly_quota REAL' },
];

export class D1SalesStore implements SalesStore {
  constructor(private db: D1Database) {}

  async init(): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) {
      await this.db.prepare(stmt).run();
    }
    // Apply additive column migrations for databases created before they existed.
    // SQLite has no "ADD COLUMN IF NOT EXISTS"; a duplicate-column error is expected and ignored.
    for (const m of COLUMN_MIGRATIONS) {
      try {
        await this.db.prepare(m.ddl).run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column/i.test(msg)) throw err;
      }
    }
  }

  async listReps(): Promise<Rep[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM sales_reps ORDER BY name ASC')
      .all<RepRow>();
    return (results ?? []).map(rowToRep);
  }

  async getRep(id: string): Promise<Rep | null> {
    const row = await this.db.prepare('SELECT * FROM sales_reps WHERE id = ?').bind(id).first<RepRow>();
    return row ? rowToRep(row) : null;
  }

  async upsertRep(rep: Rep): Promise<Rep> {
    await this.db
      .prepare(
        `INSERT INTO sales_reps (id, name, email, crm_id, start_date, weekly_quota, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           crm_id = excluded.crm_id,
           start_date = excluded.start_date,
           weekly_quota = excluded.weekly_quota,
           active = excluded.active,
           updated_at = excluded.updated_at`,
      )
      .bind(
        rep.id,
        rep.name,
        rep.email ?? null,
        rep.crmId ?? null,
        rep.startDate ?? null,
        rep.weeklyQuota ?? null,
        rep.active ? 1 : 0,
        rep.createdAt,
        rep.updatedAt,
      )
      .run();
    return rep;
  }

  async getWeeks(repId: string): Promise<RepWeek[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM sales_rep_weeks WHERE rep_id = ? ORDER BY week_of ASC')
      .bind(repId)
      .all<{ rep_id: string; week_of: string; metrics: string; source: string; ingested_at: string }>();
    return (results ?? []).map((r) => ({
      repId: r.rep_id,
      weekOf: r.week_of,
      metrics: JSON.parse(r.metrics),
      source: r.source,
      ingestedAt: r.ingested_at,
    }));
  }

  async getWeek(repId: string, weekOf: string): Promise<RepWeek | null> {
    const r = await this.db
      .prepare('SELECT * FROM sales_rep_weeks WHERE rep_id = ? AND week_of = ?')
      .bind(repId, weekOf)
      .first<{ rep_id: string; week_of: string; metrics: string; source: string; ingested_at: string }>();
    return r
      ? { repId: r.rep_id, weekOf: r.week_of, metrics: JSON.parse(r.metrics), source: r.source, ingestedAt: r.ingested_at }
      : null;
  }

  async saveWeek(week: RepWeek): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sales_rep_weeks (rep_id, week_of, metrics, source, ingested_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(rep_id, week_of) DO UPDATE SET
           metrics = excluded.metrics,
           source = excluded.source,
           ingested_at = excluded.ingested_at`,
      )
      .bind(week.repId, week.weekOf, JSON.stringify(week.metrics), week.source, week.ingestedAt)
      .run();
  }

  async saveCoachingPlan(plan: CoachingPlan): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sales_coaching_plans (rep_id, week_of, data, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(rep_id, week_of) DO UPDATE SET
           data = excluded.data,
           created_at = excluded.created_at`,
      )
      .bind(plan.repId, plan.weekOf, JSON.stringify(plan), plan.createdAt)
      .run();
  }

  async getCoachingPlan(repId: string, weekOf: string): Promise<CoachingPlan | null> {
    const r = await this.db
      .prepare('SELECT data FROM sales_coaching_plans WHERE rep_id = ? AND week_of = ?')
      .bind(repId, weekOf)
      .first<{ data: string }>();
    return r ? (JSON.parse(r.data) as CoachingPlan) : null;
  }

  async getLatestCoachingPlan(repId: string): Promise<CoachingPlan | null> {
    const r = await this.db
      .prepare('SELECT data FROM sales_coaching_plans WHERE rep_id = ? ORDER BY week_of DESC LIMIT 1')
      .bind(repId)
      .first<{ data: string }>();
    return r ? (JSON.parse(r.data) as CoachingPlan) : null;
  }

  async getPip(id: string): Promise<Pip | null> {
    const r = await this.db.prepare('SELECT data FROM sales_pips WHERE id = ?').bind(id).first<{ data: string }>();
    return r ? (JSON.parse(r.data) as Pip) : null;
  }

  async getActivePip(repId: string): Promise<Pip | null> {
    const r = await this.db
      .prepare(
        `SELECT data FROM sales_pips WHERE rep_id = ? AND status = 'pip_active'
         ORDER BY started_week DESC LIMIT 1`,
      )
      .bind(repId)
      .first<{ data: string }>();
    return r ? (JSON.parse(r.data) as Pip) : null;
  }

  async listPips(repId?: string): Promise<Pip[]> {
    const query = repId
      ? this.db.prepare('SELECT data FROM sales_pips WHERE rep_id = ? ORDER BY started_week DESC').bind(repId)
      : this.db.prepare('SELECT data FROM sales_pips ORDER BY started_week DESC');
    const { results } = await query.all<{ data: string }>();
    return (results ?? []).map((r) => JSON.parse(r.data) as Pip);
  }

  async savePip(pip: Pip): Promise<Pip> {
    await this.db
      .prepare(
        `INSERT INTO sales_pips (id, rep_id, status, started_week, data, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           started_week = excluded.started_week,
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .bind(pip.id, pip.repId, pip.status, pip.startedWeek, JSON.stringify(pip), pip.updatedAt)
      .run();
    return pip;
  }
}
