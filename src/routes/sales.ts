import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { D1SalesStore, SalesService, resolveConfig } from '../sales';
import { hasAnthropic } from '../sales/anthropic';

/**
 * Sales Coaching API routes, mounted at /api/sales (protected by Cloudflare
 * Access). Persistence uses the SALES_DB (D1) binding; when it isn't
 * configured the routes return a clear, actionable error.
 */
const sales = new Hono<AppEnv>();

// Defense-in-depth: require Cloudflare Access on every sales route (matches
// the admin API), in addition to the app-level auth in index.ts.
sales.use('*', createAccessMiddleware({ type: 'json' }));

const NOT_CONFIGURED = {
  error: 'Sales database not configured',
  message:
    'The SALES_DB (Cloudflare D1) binding is required. Create it with `wrangler d1 create moltbot-sales` and add the binding to wrangler.jsonc, then redeploy.',
} as const;

/** Build a ready-to-use service, initializing the D1 schema on first use. */
async function getService(c: Context<AppEnv>): Promise<SalesService | null> {
  const db = c.env.SALES_DB;
  if (!db) return null;
  const store = new D1SalesStore(db);
  await store.init();
  return new SalesService(store, c.env, resolveConfig(c.env));
}

// GET /api/sales/status - report whether the module is ready to use.
sales.get('/status', (c) => {
  const config = resolveConfig(c.env);
  return c.json({
    configured: !!c.env.SALES_DB,
    aiCoaching: hasAnthropic(c.env),
    crmProvider: config.crmProvider,
    thresholds: config.thresholds,
    pip: config.pip,
    message: c.env.SALES_DB
      ? 'Sales coaching is configured.'
      : NOT_CONFIGURED.message,
  });
});

// GET /api/sales/overview - owner dashboard: all reps summarized.
sales.get('/overview', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  try {
    return c.json({ reps: await svc.getOverview() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// GET /api/sales/reps - list reps (overview rows).
sales.get('/reps', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  return c.json({ reps: await svc.getOverview() });
});

// POST /api/sales/reps - create or update a rep.
sales.post('/reps', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'name is required' }, 400);
  }
  const quota = Number(body.weeklyQuota);
  const rep = await svc.saveRep({
    id: typeof body.id === 'string' ? body.id : undefined,
    name: body.name.trim(),
    email: typeof body.email === 'string' ? body.email : undefined,
    crmId: typeof body.crmId === 'string' ? body.crmId : undefined,
    startDate: typeof body.startDate === 'string' ? body.startDate : undefined,
    active: typeof body.active === 'boolean' ? body.active : undefined,
    // Only set when a valid number is provided so omitting it preserves the current value.
    ...(body.weeklyQuota !== undefined && Number.isFinite(quota) ? { weeklyQuota: quota } : {}),
  });
  return c.json({ rep });
});

// POST /api/sales/sync - pull recent weeks from the CRM and reconcile PIPs.
sales.post('/sync', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  const body = await c.req.json().catch(() => ({}));
  const weeks = Number(body?.weeks);
  const count = Number.isFinite(weeks) && weeks > 0 ? Math.min(52, Math.round(weeks)) : 6;
  try {
    const result = await svc.sync(count);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Sync failed' }, 500);
  }
});

// GET /api/sales/reps/:id - full dashboard for one rep.
sales.get('/reps/:id', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  const dashboard = await svc.getRepDashboard(c.req.param('id'));
  if (!dashboard) return c.json({ error: 'Rep not found' }, 404);
  return c.json(dashboard);
});

// GET /api/sales/reps/:id/coaching - latest (or ?weekOf=) coaching plan.
sales.get('/reps/:id/coaching', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  const dashboard = await svc.getRepDashboard(c.req.param('id'));
  if (!dashboard) return c.json({ error: 'Rep not found' }, 404);
  return c.json({ plan: dashboard.latestCoaching });
});

// POST /api/sales/reps/:id/coaching - generate a coaching plan (AI + rules).
sales.post('/reps/:id/coaching', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  const body = await c.req.json().catch(() => ({}));
  try {
    const plan = await svc.generateCoaching(
      c.req.param('id'),
      typeof body?.weekOf === 'string' ? body.weekOf : undefined,
    );
    return c.json({ plan });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to generate coaching' }, 400);
  }
});

// POST /api/sales/reps/:id/pip - open a PIP for a rep (generates the doc).
sales.post('/reps/:id/pip', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  const body = await c.req.json().catch(() => ({}));
  try {
    const pip = await svc.openPip(
      c.req.param('id'),
      typeof body?.reason === 'string' ? body.reason : undefined,
    );
    return c.json({ pip });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to open PIP' }, 400);
  }
});

// GET /api/sales/pips - list all PIPs.
sales.get('/pips', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  return c.json({ pips: await svc.listPips() });
});

// POST /api/sales/pips/:id/refresh - re-evaluate an active PIP.
sales.post('/pips/:id/refresh', async (c) => {
  const svc = await getService(c);
  if (!svc) return c.json(NOT_CONFIGURED, 503);
  try {
    const pip = await svc.refreshPip(c.req.param('id'));
    return c.json({ pip });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to refresh PIP' }, 400);
  }
});

export { sales };
