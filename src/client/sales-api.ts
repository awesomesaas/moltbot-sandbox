// API client for the Sales Coaching endpoints (/api/sales/*).
// Auth is handled by Cloudflare Access (JWT in cookies), same as the admin API.
//
// Domain types are imported (type-only) from the server module so the client
// and server never drift.

import type {
  CoachingPlan,
  MetricKey,
  Pip,
  Rep,
  RepDashboard,
  RepOverview,
  Thresholds,
} from '../sales/types'

export type {
  CoachingActivity,
  CoachingPlan,
  HealthStatus,
  MetricEvaluation,
  MetricKey,
  MetricStatus,
  Pip,
  PipMilestone,
  PipStatus,
  Rep,
  RepDashboard,
  RepOverview,
  WeekEvaluation,
} from '../sales/types'

const API_BASE = '/api/sales'

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

async function apiRequest<T>(path: string, options: globalThis.RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  } as globalThis.RequestInit)

  if (response.status === 401) {
    throw new AuthError('Unauthorized - please log in via Cloudflare Access')
  }

  const data = (await response.json()) as T & { error?: string; message?: string }
  if (!response.ok) {
    throw new Error(data.error || data.message || `API error: ${response.status}`)
  }
  return data
}

export interface SalesStatus {
  configured: boolean
  aiCoaching: boolean
  crmProvider: string
  thresholds: Thresholds
  pip: { pipAfterWeeks: number; pipDurationWeeks: number; recoveryWeeksToPass: number }
  message: string
}

export interface SyncResult {
  weeksSynced: string[]
  repsUpdated: number
  pipsOpened: number
  pipsResolved: number
}

export function getStatus(): Promise<SalesStatus> {
  return apiRequest<SalesStatus>('/status')
}

export function getOverview(): Promise<{ reps: RepOverview[] }> {
  return apiRequest<{ reps: RepOverview[] }>('/overview')
}

export function getRepDashboard(id: string): Promise<RepDashboard> {
  return apiRequest<RepDashboard>(`/reps/${id}`)
}

export function syncCrm(weeks?: number): Promise<SyncResult> {
  return apiRequest<SyncResult>('/sync', {
    method: 'POST',
    body: JSON.stringify(weeks ? { weeks } : {}),
  })
}

export interface SeedResult extends SyncResult {
  coached: number
  failed: number
}

export function seedDemo(weeks?: number): Promise<SeedResult> {
  return apiRequest<SeedResult>('/seed', {
    method: 'POST',
    body: JSON.stringify(weeks ? { weeks } : {}),
  })
}

export function generateCoaching(repId: string, weekOf?: string): Promise<{ plan: CoachingPlan }> {
  return apiRequest<{ plan: CoachingPlan }>(`/reps/${repId}/coaching`, {
    method: 'POST',
    body: JSON.stringify(weekOf ? { weekOf } : {}),
  })
}

export function openPip(repId: string): Promise<{ pip: Pip }> {
  return apiRequest<{ pip: Pip }>(`/reps/${repId}/pip`, { method: 'POST', body: '{}' })
}

export function refreshPip(pipId: string): Promise<{ pip: Pip }> {
  return apiRequest<{ pip: Pip }>(`/pips/${pipId}/refresh`, { method: 'POST', body: '{}' })
}

export function createRep(rep: Partial<Rep> & { name: string }): Promise<{ rep: Rep }> {
  return apiRequest<{ rep: Rep }>('/reps', { method: 'POST', body: JSON.stringify(rep) })
}

// --- Display helpers (client-side formatting) ---

const METRIC_KIND: Record<MetricKey, 'percent' | 'ratio' | 'count'> = {
  quotaAttainment: 'percent',
  pipelineCoverage: 'ratio',
  closeRate: 'percent',
  proposalsSent: 'count',
  profitMargin: 'percent',
}

export const METRIC_LABEL: Record<MetricKey, string> = {
  quotaAttainment: 'Quota attainment',
  pipelineCoverage: 'Pipeline coverage',
  closeRate: 'Close rate',
  proposalsSent: 'Proposals sent',
  profitMargin: 'Profit margin',
}

export function formatMetric(key: MetricKey, value: number): string {
  switch (METRIC_KIND[key]) {
    case 'percent':
      return `${Math.round(value * 100)}%`
    case 'ratio':
      return `${value.toFixed(1)}x`
    case 'count':
      return `${Math.round(value)}`
  }
}

export function formatDelta(deltaPct: number | null): string {
  if (deltaPct === null) return '—'
  const pct = Math.round(deltaPct * 100)
  return `${pct > 0 ? '+' : ''}${pct}%`
}
