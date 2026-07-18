import { useCallback, useEffect, useState } from 'react'
import {
  AuthError,
  createRep,
  formatDelta,
  formatMetric,
  generateCoaching,
  getOverview,
  getRepDashboard,
  getStatus,
  METRIC_LABEL,
  openPip,
  refreshPip,
  seedDemo,
  syncCrm,
  type HealthStatus,
  type MetricStatus,
  type PipStatus,
  type RepDashboard,
  type RepOverview,
  type SalesStatus,
} from '../sales-api'
import './SalesPage.css'

const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At risk',
}

const PIP_LABEL: Record<PipStatus, string> = {
  none: 'On track',
  coaching: 'Coaching',
  at_risk: 'At risk',
  pip_active: 'PIP active',
  pip_passed: 'PIP passed',
  pip_failed: 'PIP failed',
}

function Spinner() {
  return <span className="sc-spinner" aria-hidden />
}

function HealthChip({ health, score }: { health: HealthStatus; score: number }) {
  return (
    <span className={`sc-chip sc-health-${health}`} title={`Health score ${score}/100`}>
      {HEALTH_LABEL[health]} · {score}
    </span>
  )
}

function PipBadge({ status }: { status: PipStatus }) {
  return <span className={`sc-badge sc-pip-${status}`}>{PIP_LABEL[status]}</span>
}

function StatusDot({ status }: { status: MetricStatus }) {
  return <span className={`sc-dot sc-dot-${status}`} title={status.replace('_', ' ')} />
}

function TrendArrow({ trend }: { trend: 'up' | 'down' | 'flat' }) {
  const glyph = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '—'
  return <span className={`sc-trend sc-trend-${trend}`}>{glyph}</span>
}

/** Inline SVG sparkline of weekly talk ratios (0..1) with a threshold line. */
function TalkSparkline({ points, threshold }: { points: number[]; threshold: number }) {
  const w = 200
  const h = 44
  const pad = 5
  const n = points.length
  const x = (i: number) => (n <= 1 ? pad : pad + (i / (n - 1)) * (w - 2 * pad))
  const y = (v: number) => h - pad - Math.max(0, Math.min(1, v)) * (h - 2 * pad)
  const line = points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const thY = y(threshold).toFixed(1)
  const last = points[n - 1]
  return (
    <svg
      className="sc-spark"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Weekly talk-ratio trend, latest ${Math.round(last * 100)}%`}
    >
      <line x1={pad} x2={w - pad} y1={thY} y2={thY} className="sc-spark-threshold" />
      <polyline points={line} className="sc-spark-line" />
      {points.map((v, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(v)}
          r={i === n - 1 ? 3.5 : 2}
          className={v >= threshold ? 'sc-spark-dot-warn' : 'sc-spark-dot'}
        />
      ))}
    </svg>
  )
}

export default function SalesPage() {
  const [status, setStatus] = useState<SalesStatus | null>(null)
  const [reps, setReps] = useState<RepOverview[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<RepDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showPipDoc, setShowPipDoc] = useState(false)

  const loadOverview = useCallback(async () => {
    try {
      setError(null)
      const [st, ov] = await Promise.all([getStatus(), getOverview().catch(() => ({ reps: [] }))])
      setStatus(st)
      setReps(ov.reps)
    } catch (err) {
      if (err instanceof AuthError) setError('Authentication required. Log in via Cloudflare Access.')
      else setError(err instanceof Error ? err.message : 'Failed to load sales data')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDashboard = useCallback(async (id: string) => {
    setDetailLoading(true)
    setShowPipDoc(false)
    try {
      setDashboard(await getRepDashboard(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rep')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOverview()
  }, [loadOverview])

  useEffect(() => {
    if (selectedId) loadDashboard(selectedId)
    else setDashboard(null)
  }, [selectedId, loadDashboard])

  const runSync = async () => {
    setBusy('sync')
    setError(null)
    try {
      const result = await syncCrm()
      await loadOverview()
      if (selectedId) await loadDashboard(selectedId)
      const bits = [`${result.repsUpdated} reps`, `${result.weeksSynced.length} weeks`]
      if (result.pipsOpened) bits.push(`${result.pipsOpened} PIP(s) opened`)
      if (result.pipsResolved) bits.push(`${result.pipsResolved} PIP(s) resolved`)
      setError(`Synced: ${bits.join(', ')}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setBusy(null)
    }
  }

  const runSeed = async () => {
    setBusy('seed')
    setError(null)
    try {
      const result = await seedDemo()
      await loadOverview()
      if (selectedId) await loadDashboard(selectedId)
      setError(
        `Demo data loaded: ${result.repsUpdated} reps, ${result.weeksSynced.length} weeks, ` +
          `${result.coached} coaching plan(s)${result.pipsOpened ? `, ${result.pipsOpened} PIP(s) opened` : ''}.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load demo data')
    } finally {
      setBusy(null)
    }
  }

  const runCoaching = async () => {
    if (!selectedId) return
    setBusy('coaching')
    try {
      await generateCoaching(selectedId)
      await loadDashboard(selectedId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate coaching')
    } finally {
      setBusy(null)
    }
  }

  const runOpenPip = async () => {
    if (!selectedId) return
    setBusy('pip')
    try {
      await openPip(selectedId)
      await loadDashboard(selectedId)
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open PIP')
    } finally {
      setBusy(null)
    }
  }

  const runRefreshPip = async (pipId: string) => {
    setBusy('refresh')
    try {
      await refreshPip(pipId)
      await loadDashboard(selectedId!)
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh PIP')
    } finally {
      setBusy(null)
    }
  }

  const setQuota = async () => {
    if (!dashboard) return
    const current = dashboard.rep.weeklyQuota ? String(dashboard.rep.weeklyQuota) : ''
    const input = window.prompt(`Weekly quota ($) for ${dashboard.rep.name}:`, current)
    if (input === null) return
    const value = Number(input)
    if (!Number.isFinite(value) || value < 0) {
      setError('Quota must be a non-negative number')
      return
    }
    setBusy('quota')
    try {
      await createRep({ id: dashboard.rep.id, name: dashboard.rep.name, weeklyQuota: value })
      await syncCrm() // re-apply the new quota to recent weeks
      await loadDashboard(dashboard.rep.id)
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set quota')
    } finally {
      setBusy(null)
    }
  }

  const setNotes = async () => {
    if (!dashboard) return
    const current = dashboard.rep.notes ?? ''
    const input = window.prompt(
      `Observed challenges for ${dashboard.rep.name}\n(e.g. "talks too much on calls", "not reaching decision-makers" — used to target coaching):`,
      current,
    )
    if (input === null) return
    setBusy('notes')
    try {
      await createRep({ id: dashboard.rep.id, name: dashboard.rep.name, notes: input })
      await loadDashboard(dashboard.rep.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save notes')
    } finally {
      setBusy(null)
    }
  }

  const addRep = async () => {
    const name = window.prompt('New rep name?')
    if (!name || !name.trim()) return
    setBusy('addrep')
    try {
      await createRep({ name: name.trim() })
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add rep')
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="sc-loading">
        <Spinner /> Loading sales coaching…
      </div>
    )
  }

  if (status && !status.configured) {
    return (
      <div className="sc-setup">
        <h2>Sales Coaching setup</h2>
        <p>{status.message}</p>
        <ol>
          <li>
            Create the database: <code>npx wrangler d1 create moltbot-sales</code>
          </li>
          <li>
            Uncomment the <code>SALES_DB</code> binding in <code>wrangler.jsonc</code> and paste the returned{' '}
            <code>database_id</code>.
          </li>
          <li>
            Redeploy: <code>npm run deploy</code>
          </li>
        </ol>
        <p className="sc-muted">
          The mock CRM works out of the box. Point at a real CRM with <code>SALES_CRM_PROVIDER=hubspot</code> and{' '}
          <code>HUBSPOT_ACCESS_TOKEN</code>.
        </p>
      </div>
    )
  }

  return (
    <div className="sc-page">
      <div className="sc-toolbar">
        <div className="sc-toolbar-info">
          {status && (
            <>
              <span className="sc-muted">CRM: {status.crmProvider}</span>
              {status.callProvider !== 'none' && (
                <span className="sc-muted">Calls: {status.callProvider}</span>
              )}
              <span className={`sc-badge ${status.aiCoaching ? 'sc-ai-on' : 'sc-ai-off'}`}>
                {status.aiCoaching ? 'AI coaching on' : 'Rule-based coaching'}
              </span>
            </>
          )}
        </div>
        <div className="sc-toolbar-actions">
          <button className="sc-btn-secondary" onClick={addRep} disabled={!!busy}>
            Add rep
          </button>
          <button className="sc-btn-secondary" onClick={runSync} disabled={!!busy}>
            {busy === 'sync' ? <Spinner /> : null} Sync from CRM
          </button>
          <button className="sc-btn-primary" onClick={runSeed} disabled={!!busy}>
            {busy === 'seed' ? <Spinner /> : null} Load demo data
          </button>
        </div>
      </div>

      {error && <div className="sc-notice">{error}</div>}

      {reps.length === 0 ? (
        <div className="sc-empty">
          No reps yet. Click <strong>Load demo data</strong> to populate a sample roster with weekly figures and
          coaching plans, or <strong>Sync from CRM</strong> to pull real figures.
        </div>
      ) : (
        <table className="sc-table">
          <thead>
            <tr>
              <th>Rep</th>
              <th>Health</th>
              <th>Quota</th>
              <th>Pipeline</th>
              <th>Close</th>
              <th>Talk</th>
              <th>Status</th>
              <th>Focus this week</th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => {
              const q = r.evaluation?.metrics.find((m) => m.key === 'quotaAttainment')
              const p = r.evaluation?.metrics.find((m) => m.key === 'pipelineCoverage')
              const c = r.evaluation?.metrics.find((m) => m.key === 'closeRate')
              return (
                <tr
                  key={r.rep.id}
                  className={selectedId === r.rep.id ? 'sc-row-selected' : ''}
                  onClick={() => setSelectedId(r.rep.id)}
                >
                  <td>
                    <strong>{r.rep.name}</strong>
                    {r.atRiskStreak > 0 && <div className="sc-muted sc-sub">{r.atRiskStreak}w at risk</div>}
                  </td>
                  <td>{r.evaluation ? <HealthChip health={r.evaluation.health} score={r.evaluation.score} /> : '—'}</td>
                  <td>{q ? formatMetric('quotaAttainment', q.value) : '—'}</td>
                  <td>{p ? formatMetric('pipelineCoverage', p.value) : '—'}</td>
                  <td>{c ? formatMetric('closeRate', c.value) : '—'}</td>
                  <td>
                    {r.callWeek ? (
                      <span
                        className={r.opportunity ? 'sc-talk-warn' : undefined}
                        title={
                          r.opportunity
                            ? r.opportunity.evidence
                            : `${r.callWeek.callsAnalyzed} call(s) analyzed`
                        }
                      >
                        {Math.round(r.callWeek.avgTalkRatio * 100)}%{r.opportunity ? ' ⚠' : ''}
                      </span>
                    ) : (
                      <span className="sc-muted">—</span>
                    )}
                  </td>
                  <td>
                    <PipBadge status={r.pipStatus} />
                  </td>
                  <td>{r.topFocus ? METRIC_LABEL[r.topFocus] : <span className="sc-muted">—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {selectedId && (
        <div className="sc-detail">
          {detailLoading || !dashboard ? (
            <div className="sc-loading">
              <Spinner /> Loading rep…
            </div>
          ) : (
            <RepDetail
              dashboard={dashboard}
              busy={busy}
              onCoaching={runCoaching}
              onOpenPip={runOpenPip}
              onRefreshPip={runRefreshPip}
              onSetQuota={setQuota}
              onSetNotes={setNotes}
              talkRatioThreshold={status?.talkRatioThreshold ?? 0.65}
              showPipDoc={showPipDoc}
              onTogglePipDoc={() => setShowPipDoc((v) => !v)}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function RepDetail({
  dashboard,
  busy,
  onCoaching,
  onOpenPip,
  onRefreshPip,
  onSetQuota,
  onSetNotes,
  talkRatioThreshold,
  showPipDoc,
  onTogglePipDoc,
  onClose,
}: {
  dashboard: RepDashboard
  busy: string | null
  onCoaching: () => void
  onOpenPip: () => void
  onRefreshPip: (pipId: string) => void
  onSetQuota: () => void
  onSetNotes: () => void
  talkRatioThreshold: number
  showPipDoc: boolean
  onTogglePipDoc: () => void
  onClose: () => void
}) {
  const { rep, latestEvaluation, activePip, latestCoaching, pipStatus } = dashboard
  const quotaLabel = rep.weeklyQuota
    ? `$${rep.weeklyQuota.toLocaleString()}/wk quota`
    : 'quota from CRM'

  return (
    <div className="sc-detail-inner">
      <div className="sc-detail-head">
        <div>
          <h2>{rep.name}</h2>
          <div className="sc-muted">
            {latestEvaluation ? `Week of ${latestEvaluation.weekOf}` : 'No data'} · <PipBadge status={pipStatus} />{' '}
            · <button className="sc-link" onClick={onSetQuota} disabled={!!busy}>
              {busy === 'quota' ? <Spinner /> : null} {quotaLabel}
            </button>
          </div>
        </div>
        <button className="sc-btn-ghost" onClick={onClose}>
          Close ✕
        </button>
      </div>

      {latestEvaluation && (
        <div className="sc-metrics-grid">
          {latestEvaluation.metrics.map((m) => (
            <div key={m.key} className={`sc-metric sc-metric-${m.status}`}>
              <div className="sc-metric-top">
                <StatusDot status={m.status} />
                <span className="sc-metric-label">{METRIC_LABEL[m.key]}</span>
              </div>
              <div className="sc-metric-value">{formatMetric(m.key, m.value)}</div>
              <div className="sc-metric-foot">
                <span className="sc-muted">target {formatMetric(m.key, m.target)}</span>
                <span>
                  <TrendArrow trend={m.trend} /> {formatDelta(m.deltaPct)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Call analytics (talk ratio + AI insights) */}
      {dashboard.callWeek && (
        <section className="sc-section">
          <h3>Call analytics</h3>
          {dashboard.opportunity && (
            <div className="sc-opportunity">
              <strong>⚠ Coaching opportunity:</strong> {dashboard.opportunity.evidence} This is factored into the
              coaching plan below.
            </div>
          )}
          <div className="sc-call-summary">
            <span>
              <strong>{Math.round(dashboard.callWeek.avgTalkRatio * 100)}%</strong> avg talk ratio
            </span>
            <span>{dashboard.callWeek.callsAnalyzed} call(s) analyzed</span>
            {dashboard.callWeek.avgQuestionsAsked !== undefined && (
              <span>{dashboard.callWeek.avgQuestionsAsked.toFixed(1)} avg questions</span>
            )}
            {dashboard.callWeek.nextStepRate !== undefined && (
              <span>{Math.round(dashboard.callWeek.nextStepRate * 100)}% secured a next step</span>
            )}
          </div>
          {dashboard.callTrend.length >= 2 && (
            <div className="sc-spark-wrap">
              <TalkSparkline
                points={dashboard.callTrend.map((c) => c.avgTalkRatio)}
                threshold={talkRatioThreshold}
              />
              <span className="sc-muted">
                talk ratio · last {dashboard.callTrend.length} weeks (dashed ={' '}
                {Math.round(talkRatioThreshold * 100)}% threshold)
              </span>
            </div>
          )}
          {dashboard.latestCalls.length > 0 && (
            <table className="sc-calls">
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Date</th>
                  <th>Talk</th>
                  <th>Insights</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.latestCalls.map((call) => (
                  <tr key={call.id}>
                    <td>{call.title ?? 'Call'}</td>
                    <td>{call.date}</td>
                    <td className={call.talkRatio >= talkRatioThreshold ? 'sc-talk-warn' : undefined}>
                      {Math.round(call.talkRatio * 100)}%
                    </td>
                    <td>
                      {call.insights ? (
                        <span className="sc-muted">
                          {call.insights.questionsAsked} Qs · {Math.round(call.insights.longestMonologueSec / 60)}m max
                          monologue · {call.insights.nextStepSecured ? 'next step ✅' : 'no next step'}
                        </span>
                      ) : (
                        <span className="sc-muted">talk ratio only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Observed challenges (owner notes that steer coaching) */}
      <section className="sc-section">
        <div className="sc-section-head">
          <h3>Observed challenges</h3>
          <button className="sc-btn-secondary" onClick={onSetNotes} disabled={!!busy}>
            {busy === 'notes' ? <Spinner /> : null} {rep.notes ? 'Edit' : 'Add'}
          </button>
        </div>
        {rep.notes ? (
          <p className="sc-notes">{rep.notes}</p>
        ) : (
          <p className="sc-muted">
            No notes yet. Add a behavioral observation (e.g. &quot;talks too much on calls&quot;) and it will be
            factored into the coaching plan — useful for issues the metrics can&apos;t reveal.
          </p>
        )}
      </section>

      {/* Coaching */}
      <section className="sc-section">
        <div className="sc-section-head">
          <h3>This week&apos;s coaching</h3>
          <button className="sc-btn-primary" onClick={onCoaching} disabled={!!busy}>
            {busy === 'coaching' ? <Spinner /> : null} {latestCoaching ? 'Regenerate' : 'Generate'} plan
          </button>
        </div>
        {latestCoaching ? (
          <>
            <p className="sc-summary">
              {latestCoaching.summary}{' '}
              <span className="sc-muted">({latestCoaching.source === 'ai' ? 'AI' : 'rules'})</span>
            </p>
            <div className="sc-activities">
              {latestCoaching.activities.map((a, i) => (
                <div key={i} className={`sc-activity sc-prio-${a.priority}`}>
                  <div className="sc-activity-head">
                    <span className="sc-activity-title">{a.title}</span>
                    <span className={`sc-tag sc-prio-tag-${a.priority}`}>{a.priority}</span>
                  </div>
                  <p>{a.description}</p>
                  {a.rationale && <p className="sc-muted sc-rationale">{a.rationale}</p>}
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="sc-muted">No coaching plan yet — generate one to get this week&apos;s focus activities.</p>
        )}
      </section>

      {/* PIP */}
      <section className="sc-section">
        <div className="sc-section-head">
          <h3>Performance Improvement Plan</h3>
          {!activePip && (
            <button className="sc-btn-danger" onClick={onOpenPip} disabled={!!busy}>
              {busy === 'pip' ? <Spinner /> : null} Open PIP
            </button>
          )}
        </div>
        {activePip ? (
          <div className="sc-pip">
            <div className="sc-pip-meta">
              <span>
                <strong>Started</strong> {activePip.startedWeek}
              </span>
              <span>
                <strong>Target end</strong> {activePip.targetEndWeek}
              </span>
              <span>
                <strong>Recovery</strong> {activePip.recoveryWeeksToPass} healthy weeks
              </span>
              <button className="sc-btn-secondary" onClick={() => onRefreshPip(activePip.id)} disabled={!!busy}>
                {busy === 'refresh' ? <Spinner /> : null} Refresh
              </button>
            </div>
            <p className="sc-muted">{activePip.reason}</p>
            <table className="sc-milestones">
              <thead>
                <tr>
                  <th>Milestone</th>
                  <th>Target</th>
                  <th>Due</th>
                  <th>Met</th>
                </tr>
              </thead>
              <tbody>
                {activePip.milestones.map((ms) => (
                  <tr key={ms.metric}>
                    <td>{ms.label}</td>
                    <td>{formatMetric(ms.metric, ms.target)}</td>
                    <td>{ms.dueWeek}</td>
                    <td>{ms.met ? '✅' : '⬜'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="sc-btn-ghost" onClick={onTogglePipDoc}>
              {showPipDoc ? 'Hide' : 'View'} PIP document
            </button>
            {showPipDoc && <pre className="sc-pip-doc">{activePip.document}</pre>}
          </div>
        ) : (
          <p className="sc-muted">
            No active PIP. One is opened automatically after {'≥'}3 consecutive at-risk weeks, or open one manually
            above.
          </p>
        )}
      </section>

      {/* History */}
      {dashboard.evaluations.length > 1 && (
        <section className="sc-section">
          <h3>Recent weeks</h3>
          <div className="sc-history">
            {dashboard.evaluations.slice(-8).map((e) => (
              <div key={e.weekOf} className="sc-history-bar" title={`${e.weekOf}: ${e.health} (${e.score})`}>
                <div className={`sc-history-fill sc-health-${e.health}`} style={{ height: `${Math.max(6, e.score)}%` }} />
                <span className="sc-history-label">{e.weekOf.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
