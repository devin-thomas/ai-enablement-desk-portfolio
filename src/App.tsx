import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowUpRight, FileClock, Headphones, LockKeyhole, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Workflow, X } from 'lucide-react'
import { requestSubmissionSchema, type AnalysisRun, type ArtifactRecord, type AutomationAttempt, type ClarificationAnswerRecord, type ClarificationAnswerSubmission, type DecisionRecord, type HumanDecision, type RequestDetail, type RequestRecord, type RequestSubmission } from '@ai-enablement/contracts'
import { answerClarification, generateAudioBriefing, getHealth, getRequest, isRecruiterDemo, listAnalyses, listArtifacts, listAutomations, listDecisions, listRequests, recordDecision, resetDemo, retryAutomation, runAnalysis, submitRequest } from './api'

const blankForm: RequestSubmission = {
  title: '', requestType: 'ai_project', department: '', requesterName: '', requesterRole: '',
  businessProblem: '', desiredOutcome: '', currentProcess: '', intendedUsers: [], dataSources: [],
  syntheticDemoSafe: false,
}

function statusLabel(status: RequestRecord['status']): string {
  return status.split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function requestTypeLabel(requestType: RequestRecord['requestType']): string {
  return requestType === 'ai_project' ? 'AI project' : requestType === 'tool_access' ? 'Tool access' : requestType.replace('_', ' ')
}

function displayRequestId(id: string): string {
  const digits = id.replace(/\D/g, '')
  return digits.slice(-6).padStart(6, '0')
}

function App() {
  const [requests, setRequests] = useState<RequestRecord[]>([])
  const [selected, setSelected] = useState<RequestDetail | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<AnalysisRun[]>([])
  const [clarificationAnswers, setClarificationAnswers] = useState<ClarificationAnswerRecord[]>([])
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [decisions, setDecisions] = useState<DecisionRecord[]>([])
  const [geminiStatus, setGeminiStatus] = useState<'configured' | 'unavailable_key' | 'demo_fixture' | 'unavailable'>('unavailable')
  const [n8nStatus, setN8nStatus] = useState<'configured' | 'disabled' | 'unavailable_secret' | 'demo_evidence' | 'unavailable'>('unavailable')
  const [fishStatus, setFishStatus] = useState<'configured' | 'disabled' | 'unavailable_key' | 'unavailable'>('unavailable')
  const [automations, setAutomations] = useState<AutomationAttempt[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [audioBusy, setAudioBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [requestTypeFilter, setRequestTypeFilter] = useState<RequestRecord['requestType'] | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showNewRequest, setShowNewRequest] = useState(false)
  const [resetting, setResetting] = useState(false)

  const filteredRequests = useMemo(() => requests.filter((request) => {
    const matchesType = requestTypeFilter === 'all' || request.requestType === requestTypeFilter
    const matchesQuery = `${request.title} ${request.department} ${request.requesterName}`.toLowerCase().includes(query.toLowerCase())
    return matchesType && matchesQuery
  }), [requests, query, requestTypeFilter])

  async function loadQueue(preferredId?: string) {
    setLoading(true)
    setError(null)
    try {
      const records = await listRequests()
      setRequests(records)
      const nextId = preferredId ?? selectedId ?? records[0]?.id
      setSelectedId(nextId ?? null)
      if (nextId) {
        const [detail, history, decisionHistory, automationHistory, artifactHistory] = await Promise.all([getRequest(nextId), listAnalyses(nextId), listDecisions(nextId), listAutomations(nextId), listArtifacts(nextId)])
        setSelected(detail); setAnalyses(history.analyses); setClarificationAnswers(history.clarificationAnswers); setDecisions(decisionHistory); setAutomations(automationHistory); setArtifacts(artifactHistory)
      } else {
        setSelected(null); setAnalyses([]); setClarificationAnswers([]); setDecisions([]); setAutomations([]); setArtifacts([])
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load requests.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadQueue()
    void getHealth().then((health) => { setGeminiStatus(health.providers.gemini); setN8nStatus(health.providers.n8n); setFishStatus(health.providers.fishAudio) }).catch(() => { setGeminiStatus('unavailable'); setN8nStatus('unavailable'); setFishStatus('unavailable') })
  }, [])

  async function selectRequest(id: string) {
    setSelectedId(id)
    setError(null)
    try {
      const [detail, history, decisionHistory, automationHistory, artifactHistory] = await Promise.all([getRequest(id), listAnalyses(id), listDecisions(id), listAutomations(id), listArtifacts(id)])
      setSelected(detail); setAnalyses(history.analyses); setClarificationAnswers(history.clarificationAnswers); setDecisions(decisionHistory); setAutomations(automationHistory); setArtifacts(artifactHistory)
    }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load request.') }
  }

  async function handleReset() {
    setResetting(true)
    setError(null)
    try {
      const records = await resetDemo()
      setRequests(records)
      await selectRequest(records[0].id)
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Unable to reset demo data.')
    } finally { setResetting(false) }
  }

  async function handleSubmitted(request: RequestDetail) {
    setShowNewRequest(false)
    await loadQueue(request.id)
  }

  async function handleAnalysis() {
    if (!selected) return
    setAnalysisBusy(true); setError(null)
    try { await runAnalysis(selected.id) }
    catch (analysisError) { setError(analysisError instanceof Error ? analysisError.message : 'Analysis failed.') }
    finally { setAnalysisBusy(false); await loadQueue(selected.id) }
  }

  async function handleClarification(submission: ClarificationAnswerSubmission) {
    if (!selected) return
    setError(null)
    try { await answerClarification(selected.id, submission); await loadQueue(selected.id) }
    catch (answerError) { setError(answerError instanceof Error ? answerError.message : 'Unable to save clarification.') }
  }

  async function handleDecision(submission: HumanDecision) {
    if (!selected) return
    setError(null)
    try { await recordDecision(selected.id, submission); await loadQueue(selected.id) }
    catch (decisionError) { setError(decisionError instanceof Error ? decisionError.message : 'Unable to record decision.') }
  }

  async function handleAutomationRetry(attemptId: string) {
    if (!selected) return
    setError(null)
    try { await retryAutomation(selected.id, attemptId); await loadQueue(selected.id) }
    catch (retryError) { setError(retryError instanceof Error ? retryError.message : 'Unable to retry automation.') }
  }

  async function handleAudio() {
    if (!selected) return
    setAudioBusy(true); setError(null)
    try { await generateAudioBriefing(selected.id); await loadQueue(selected.id) }
    catch (audioError) { setError(audioError instanceof Error ? audioError.message : 'Audio briefing is unavailable; written analysis remains authoritative.') }
    finally { setAudioBusy(false) }
  }

  return <div className="app-shell">
    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs"><span>Operations</span><span>/</span><strong>Intake queue</strong></div><div className="topbar-links">{isRecruiterDemo && <><a href="https://devthomas.site">Portfolio</a><a href="https://github.com/devin-thomas/ai-enablement-desk-portfolio" target="_blank" rel="noreferrer">Source <ArrowUpRight size={13} /></a></>}<div className="system-status"><span className="pulse" />{isRecruiterDemo ? 'Private browser sandbox' : 'Persisted request service'}</div></div></header>
      {isRecruiterDemo && <section className="recruiter-guide"><div><span>RECRUITER SANDBOX</span><strong>Try the governed workflow in about 90 seconds.</strong><p>Your changes stay in this browser. No account, real employee data, paid AI call, or shared database is involved.</p></div><ol><li><b>1</b> Run analysis</li><li><b>2</b> Answer the clarification</li><li><b>3</b> Re-run and review</li></ol></section>}
      <div className="page-heading"><div><p className="eyebrow">{isRecruiterDemo ? 'Interactive portfolio workflow' : 'Restart-safe workflow'}</p><div className="portfolio-label"><span className="portfolio-dot" />Synthetic data only</div><h1>Intake queue</h1><p className="lede">{isRecruiterDemo ? 'Each visitor receives an isolated, resettable copy of the three synthetic scenarios.' : 'Submitted records and audit events are loaded from Postgres.'}</p></div><div className="heading-actions"><button className="secondary-button scenario-button" disabled={resetting} onClick={() => void handleReset()}><RefreshCw size={15} />{resetting ? 'Resetting…' : 'Reset demo'}</button><button className="primary-button" onClick={() => setShowNewRequest(true)}><Plus size={17} />New request</button></div></div>
      <section className="queue-strip"><div className="queue-stat"><span>{isRecruiterDemo ? 'Sandbox requests' : 'Persisted requests'}</span><strong>{requests.length}</strong><small>{isRecruiterDemo ? 'This browser only' : 'Current database'}</small></div><div className="queue-stat"><span>AI projects</span><strong>{requests.filter((r) => r.requestType === 'ai_project').length}</strong><small>Synthetic or submitted</small></div><div className="queue-stat"><span>Tool access</span><strong>{requests.filter((r) => r.requestType === 'tool_access').length}</strong><small>Synthetic or submitted</small></div><div className="queue-note"><Activity size={18} /><span><strong>Providers:</strong> analysis {geminiStatus.replace('_', ' ')}; automation {n8nStatus.replace('_', ' ')}; audio {fishStatus.replace('_', ' ')}.</span></div></section>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => void loadQueue()}><RefreshCw size={14} />Retry</button></div>}
      <div className="content-grid">
        <section className="request-list-panel"><div className="panel-heading"><div><h2>Requests</h2><span>{filteredRequests.length} visible</span></div><label className="search-box"><Search size={15} /><input aria-label="Search requests" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search queue" /></label></div>
          <div className="request-filters" aria-label="Filter requests by category">
            {(['all', 'ai_project', 'tool_access'] as const).map((filter) => {
              const count = filter === 'all' ? requests.length : requests.filter((request) => request.requestType === filter).length
              const label = filter === 'all' ? 'All requests' : requestTypeLabel(filter)
              return <button key={filter} className={requestTypeFilter === filter ? 'request-filter active' : 'request-filter'} aria-pressed={requestTypeFilter === filter} onClick={() => setRequestTypeFilter(filter)}>{label}<span>{count}</span></button>
            })}
          </div>
          {loading ? <PanelState title="Loading requests…" /> : filteredRequests.length === 0 ? <PanelState title={requests.length === 0 ? 'No requests yet' : 'No matching requests'} /> : <div className="request-list">{filteredRequests.map((request) => <button className={request.id === selectedId ? 'request-row selected' : 'request-row'} key={request.id} onClick={() => void selectRequest(request.id)}><div className="row-top"><span className="request-id">{displayRequestId(request.id)}</span><span className={`request-type-label ${request.requestType}`}>{requestTypeLabel(request.requestType)}</span><span className="status compact blue"><span />{statusLabel(request.status)}</span></div><strong>{request.title}</strong><span className="row-meta">{request.department} · {new Date(request.submittedAt).toLocaleString()}</span></button>)}</div>}
        </section>
        <section className="detail-panel">{selected ? <RequestDetailView request={selected} analyses={analyses} clarificationAnswers={clarificationAnswers} decisions={decisions} automations={automations} artifacts={artifacts} analysisBusy={analysisBusy} audioBusy={audioBusy} onAnalyze={handleAnalysis} onAnswer={handleClarification} onDecision={handleDecision} onAutomationRetry={handleAutomationRetry} onAudio={handleAudio} /> : <PanelState title={loading ? 'Loading request…' : 'Select or submit a request'} />}</section>
      </div>
      <section className="governance-note"><LockKeyhole size={18} /><div><strong>{isRecruiterDemo ? 'Recruiter-safe boundary' : 'Persistence boundary'}</strong><span>{isRecruiterDemo ? 'This hosted sandbox intentionally uses local browser storage and validated synthetic fixtures. The repository documents and tests the separate trusted server, Postgres, Gemini, n8n, and Fish boundaries.' : 'The browser holds only a view cache. Validation, durable IDs, records, and initial audit events are owned by the server and database.'}</span></div></section>
    </main>
    {showNewRequest && <RequestForm onClose={() => setShowNewRequest(false)} onSubmitted={handleSubmitted} />}
  </div>
}

function PanelState({ title }: { title: string }) { return <div className="panel-state" aria-live="polite">{title}</div> }

function RequestDetailView({ request, analyses, clarificationAnswers, decisions, automations, artifacts, analysisBusy, audioBusy, onAnalyze, onAnswer, onDecision, onAutomationRetry, onAudio }: { request: RequestDetail; analyses: AnalysisRun[]; clarificationAnswers: ClarificationAnswerRecord[]; decisions: DecisionRecord[]; automations: AutomationAttempt[]; artifacts: ArtifactRecord[]; analysisBusy: boolean; audioBusy: boolean; onAnalyze: () => Promise<void>; onAnswer: (submission: ClarificationAnswerSubmission) => Promise<void>; onDecision: (submission: HumanDecision) => Promise<void>; onAutomationRetry: (attemptId: string) => Promise<void>; onAudio: () => Promise<void> }) {
  const latest = analyses[0]
  const canAnalyze = ['submitted', 'needs_clarification', 'analysis_failed'].includes(request.status)
  return <>
    <div className="detail-header"><div><div className={`request-type-banner ${request.requestType}`}><span>Request category</span><strong>{requestTypeLabel(request.requestType)}</strong></div><div className="detail-id">{displayRequestId(request.id)} <span>·</span> {requestTypeLabel(request.requestType)}</div><h2>{request.title}</h2><p>Submitted by {request.requesterName} · {request.department}</p></div><button className="secondary-button" disabled={!canAnalyze || analysisBusy} onClick={() => void onAnalyze()}><Sparkles size={14} />{analysisBusy ? 'Analyzing…' : analyses.length ? 'Re-run analysis' : 'Run analysis'}</button></div>
    <div className="status-line"><span className="status blue"><span />{statusLabel(request.status)}</span><span className="status-copy">Updated {new Date(request.updatedAt).toLocaleString()}</span></div>
    <div className="advisory-note"><ShieldAlert size={16} /><strong>AI recommendations are advisory.</strong> // Deterministic rules and a named human reviewer own routing and decisions.</div>
    <div className="summary-block"><div className="summary-label"><Workflow size={15} />Business problem</div><p>{request.businessProblem}</p></div>
    <div className="field-grid"><DetailField label="Desired outcome" value={request.desiredOutcome} /><DetailField label="Requester role" value={request.requesterRole} /><DetailField label="Intended users" value={request.intendedUsers.join(', ')} /><DetailField label="Data sources" value={request.dataSources.join(', ')} /></div>
    {latest ? <AnalysisView run={latest} request={request} clarificationAnswers={clarificationAnswers} onAnswer={onAnswer} /> : <div className="analysis-empty"><Sparkles size={18} /><div><strong>No analysis history</strong><span>{isRecruiterDemo ? 'Run the schema-valid demo analysis to begin the guided workflow.' : 'Run advisory analysis when the server-side provider is configured.'}</span></div></div>}
    <ReviewerWorkspace request={request} analyses={analyses} decisions={decisions} onDecision={onDecision} />
    <AutomationEvidence request={request} analyses={analyses} automations={automations} artifacts={artifacts} audioBusy={audioBusy} onRetry={onAutomationRetry} onAudio={onAudio} />
    {analyses.length > 0 && <div className="analysis-history"><h3>Immutable analysis history</h3>{analyses.map((run, index) => <div className="analysis-history-row" key={run.id}><span>Run {analyses.length - index}</span><strong>{run.outcome.replaceAll('_', ' ')}</strong><small>{run.provider} / {run.model} · prompt {run.promptVersion} · {run.latencyMs} ms · {new Date(run.createdAt).toLocaleString()}</small></div>)}</div>}
    <div className="audit-block"><div className="audit-heading"><div><h3>Audit history</h3><span>Requester, model, deterministic system, automation, and human actors remain structurally distinct.</span></div><FileClock size={17} /></div><div className="timeline">{request.auditEvents.map((event) => <div className="timeline-item" key={event.id}><div className={`timeline-dot actor-${event.actorType}`}><FileClock size={10} /></div><div><strong>{event.actorName} · {event.actorType}</strong><p>{event.description}</p></div><time>{new Date(event.createdAt).toLocaleTimeString()}</time></div>)}</div></div>
  </>
}

function AutomationEvidence({ request, analyses, automations, artifacts, audioBusy, onRetry, onAudio }: { request: RequestDetail; analyses: AnalysisRun[]; automations: AutomationAttempt[]; artifacts: ArtifactRecord[]; audioBusy: boolean; onRetry: (attemptId: string) => Promise<void>; onAudio: () => Promise<void> }) {
  const latestSummary = analyses.find((run) => run.outcome === 'success' && run.modelAnalysis)?.modelAnalysis?.reviewerSummary
  return <section className="automation-evidence">
    <div className="analysis-heading"><div><p className="eyebrow">Execution evidence</p><h3>Automations and optional audio</h3></div><span>{request.syntheticDemoSafe ? 'synthetic audio eligible' : 'audio prohibited'}</span></div>
    <p className="analysis-summary">{isRecruiterDemo ? 'The written fixture is authoritative in this sandbox. Live audio is disabled; verified provider evidence remains available in the source repository.' : 'The written analysis is authoritative. Audio is generated only for explicitly synthetic demo-safe requests and only after the provider returns real bytes.'}</p>
    {latestSummary && <div className="authoritative-text"><strong>Authoritative briefing text</strong><p>{latestSummary}</p><button className="play-button" disabled={!request.syntheticDemoSafe || audioBusy || isRecruiterDemo} title={isRecruiterDemo ? 'Live audio is intentionally disabled in the anonymous sandbox.' : undefined} onClick={() => void onAudio()}><Headphones size={14} />{isRecruiterDemo ? 'Audio disabled in sandbox' : audioBusy ? 'Generating…' : 'Generate optional audio'}</button></div>}
    {artifacts.map((artifact) => <audio className="audio-artifact" key={artifact.id} controls preload="none" src={artifact.contentUrl}>Your browser cannot play this audio artifact.</audio>)}
    <div className="automation-list">{automations.length === 0 ? <p>No automation attempts recorded.</p> : automations.map((attempt) => <div key={attempt.id}><span className={`automation-status ${attempt.status}`}>{attempt.status}</span><strong>{attempt.automationName}</strong><small>workflow {attempt.workflowVersion} · attempt {attempt.attemptNumber} · correlation {attempt.correlationId.slice(0, 8)} · execution {attempt.externalExecutionId ?? 'none'}</small>{['failed', 'unavailable'].includes(attempt.status) && attempt.automationName !== 'generate-audio-briefing' && <button onClick={() => void onRetry(attempt.id)}>Retry</button>}</div>)}</div>
  </section>
}

function ReviewerWorkspace({ request, analyses, decisions, onDecision }: { request: RequestDetail; analyses: AnalysisRun[]; decisions: DecisionRecord[]; onDecision: (submission: HumanDecision) => Promise<void> }) {
  const latest = analyses.find((run) => run.outcome === 'success' && run.modelAnalysis)
  const [reviewerName, setReviewerName] = useState('Synthetic Reviewer')
  const [rationale, setRationale] = useState('')
  const [saving, setSaving] = useState<HumanDecision['decision'] | null>(null)
  const privacyBlocked = latest?.ruleEvaluation.some((rule) => rule.rule === 'privacy_high_risk_gate' && rule.result === 'failed') ?? false
  const incomplete = Boolean(latest?.modelAnalysis && (latest.modelAnalysis.missingInformation.length > 0 || latest.modelAnalysis.clarificationQuestions.some((question) => question.blocking)))
  const actionRules: Array<{ decision: HumanDecision['decision']; label: string; available: boolean; reason: string }> = [
    { decision: 'approve_for_discovery', label: 'Approve discovery', available: Boolean(latest && request.status === 'ready_for_review' && latest.systemRecommendation === 'ready_for_discovery' && !privacyBlocked && !incomplete), reason: privacyBlocked ? 'Blocked by high-risk privacy rule.' : incomplete ? 'Blocking clarifications remain.' : latest?.systemRecommendation !== 'ready_for_discovery' ? 'Deterministic route is not ready for discovery.' : `Unavailable from ${statusLabel(request.status)}.` },
    { decision: 'defer', label: 'Defer', available: Boolean(latest && ['ready_for_review', 'needs_clarification', 'access_request'].includes(request.status)), reason: `Deferral is unavailable from ${statusLabel(request.status)}.` },
    { decision: 'decline', label: 'Decline', available: Boolean(latest && ['ready_for_review', 'access_request'].includes(request.status)), reason: `Decline is unavailable from ${statusLabel(request.status)}.` },
    { decision: 'request_clarification', label: 'Request clarification', available: Boolean(latest && request.status === 'ready_for_review'), reason: `Clarification is unavailable from ${statusLabel(request.status)}.` },
  ]
  const formValid = reviewerName.trim().length > 0 && rationale.trim().length >= 10
  async function submit(decision: HumanDecision['decision']) {
    if (!latest || !formValid) return
    setSaving(decision)
    try { await onDecision({ reviewerName, rationale, decision, analysisRunId: latest.id, expectedVersion: request.version }); setRationale('') }
    finally { setSaving(null) }
  }
  return <section className="review-workspace">
    <div className="analysis-heading"><div><h3>Reviewer decision</h3></div><span>Request version {request.version}</span></div>
    <p className="analysis-summary">// {isRecruiterDemo ? 'A decision is bound to the latest successful analysis and request version. The sandbox applies the same transition and governance rules locally.' : 'A decision is bound to the latest successful analysis and this request version. The server rechecks legal transitions and governance eligibility.'}</p>
    <div className="review-inputs"><label>Reviewer identity<input value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} /></label><label>Required rationale<textarea value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain the evidence and governance basis for this decision" /></label></div>
    <div className="decision-actions">{actionRules.map((action) => <div key={action.decision}><button disabled={!action.available || !formValid || saving !== null} title={action.available ? 'Requires reviewer identity and rationale.' : action.reason} onClick={() => void submit(action.decision)}>{saving === action.decision ? 'Recording…' : action.label}</button>{!action.available && <small>{action.reason}</small>}</div>)}</div>
    {!formValid && <p className="review-requirement">Enter a named reviewer and at least 10 characters of rationale to enable an available action.</p>}
    {decisions.length > 0 && <div className="decision-history"><h4>Persisted human decisions</h4>{decisions.map((decision) => <div key={decision.id}><strong>{decision.reviewerName} · {decision.decision.replaceAll('_', ' ')}</strong><p>{decision.rationale}</p><small>{decision.previousStatus} → {decision.nextStatus} · analysis {decision.analysisRunId.slice(0, 8)} · version {decision.resultingVersion}</small></div>)}</div>}
  </section>
}

function AnalysisView({ run, request, clarificationAnswers, onAnswer }: { run: AnalysisRun; request: RequestDetail; clarificationAnswers: ClarificationAnswerRecord[]; onAnswer: (submission: ClarificationAnswerSubmission) => Promise<void> }) {
  if (!run.modelAnalysis) return <div className="analysis-error"><strong>Analysis unavailable: {run.outcome.replaceAll('_', ' ')}</strong><span>The request remains usable. Check provider configuration or retry after the provider recovers.</span><small>Sanitized code: {run.sanitizedErrorCode ?? 'provider_error'}</small></div>
  const analysis = run.modelAnalysis
  return <div className="analysis-view">
    <div className="analysis-heading"><div><p className="eyebrow">Validated model output</p><h3>{analysis.normalizedTitle}</h3></div><span>{run.provider} · schema {run.schemaVersion}</span></div>
    <p className="analysis-summary">{analysis.reviewerSummary}</p>
    <div className="recommendation-grid"><div><span>Model suggestion · advisory</span><strong>{run.modelRecommendation?.replaceAll('_', ' ')}</strong></div><div><span>Deterministic system route</span><strong>{run.systemRecommendation?.replaceAll('_', ' ')}</strong></div></div>
    <div className="evidence-grid"><EvidenceList title="Confirmed facts" items={analysis.facts.map((item) => `${item.value} · ${item.source}`)} /><EvidenceList title="Model assumptions" items={analysis.assumptions.map((item) => `${item.value} · unconfirmed`)} /><EvidenceList title="Unknowns" items={analysis.unknowns} /></div>
    <div className="rule-list"><h4>Deterministic rule evaluation</h4>{run.ruleEvaluation.map((rule) => <div key={rule.rule}><span className={`rule-result ${rule.result}`}>{rule.result.replace('_', ' ')}</span><p><strong>{rule.rule.replaceAll('_', ' ')}</strong>{rule.explanation}</p></div>)}</div>
    {analysis.clarificationQuestions.length > 0 && <div className="clarification-list"><h4>Prioritized clarifications</h4>{analysis.clarificationQuestions.map((question) => {
      const answer = clarificationAnswers.find((item) => item.questionId === question.id)
      return <div className="clarification-card" key={question.id}><div><span>{question.id} · priority {question.priority}{question.blocking ? ' · blocking' : ''}</span><strong>{question.question}</strong><p>{question.reason}</p></div>{answer ? <div className="saved-answer"><strong>{answer.actorName}</strong><p>{answer.answer}</p></div> : <ClarificationForm questionId={question.id} requesterName={request.requesterName} onAnswer={onAnswer} />}</div>
    })}</div>}
  </div>
}

function EvidenceList({ title, items }: { title: string; items: string[] }) { return <div><h4>{title}</h4>{items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>None recorded.</p>}</div> }

function ClarificationForm({ questionId, requesterName, onAnswer }: { questionId: string; requesterName: string; onAnswer: (submission: ClarificationAnswerSubmission) => Promise<void> }) {
  const [answer, setAnswer] = useState('')
  const [actorType, setActorType] = useState<'requester' | 'human'>('requester')
  const [actorName, setActorName] = useState(requesterName)
  const [saving, setSaving] = useState(false)
  async function save() {
    if (answer.trim().length < 2 || !actorName.trim()) return
    setSaving(true)
    try { await onAnswer({ questionId, answer, actorType, actorName }) }
    finally { setSaving(false) }
  }
  return <div className="clarification-form"><textarea aria-label={`Answer ${questionId}`} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Add evidence without changing the original request" /><div><select aria-label="Answering as" value={actorType} onChange={(event) => setActorType(event.target.value as 'requester' | 'human')}><option value="requester">Requester</option><option value="human">Reviewer</option></select><input aria-label="Actor name" value={actorName} onChange={(event) => setActorName(event.target.value)} /><button disabled={saving || answer.trim().length < 2 || !actorName.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save answer'}</button></div></div>
}

function DetailField({ label, value }: { label: string; value: string }) { return <div className="detail-field"><span>{label}</span><strong>{value}</strong></div> }

function RequestForm({ onClose, onSubmitted }: { onClose: () => void; onSubmitted: (request: RequestDetail) => Promise<void> }) {
  const [form, setForm] = useState(blankForm)
  const [users, setUsers] = useState('')
  const [sources, setSources] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  function setField<Key extends keyof RequestSubmission>(key: Key, value: RequestSubmission[Key]) { setForm((current) => ({ ...current, [key]: value })) }
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const candidate = { ...form, intendedUsers: users.split(',').map((item) => item.trim()).filter(Boolean), dataSources: sources.split(',').map((item) => item.trim()).filter(Boolean), currentProcess: form.currentProcess?.trim() || null }
    const parsed = requestSubmissionSchema.safeParse(candidate)
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message])))
      return
    }
    setErrors({}); setServerError(null); setSubmitting(true)
    try { await onSubmitted(await submitRequest(parsed.data)) }
    catch (error) { setServerError(error instanceof Error ? error.message : 'Unable to submit request.') }
    finally { setSubmitting(false) }
  }

  return <div className="modal-backdrop"><form className="new-request-modal intake-form" role="dialog" aria-modal="true" aria-labelledby="request-form-title" onSubmit={(event) => void handleSubmit(event)} noValidate><button type="button" className="modal-close" onClick={onClose} aria-label="Close intake form"><X size={18} /></button><p className="eyebrow">{isRecruiterDemo ? 'Isolated sandbox intake' : 'Persisted intake'}</p><h2 id="request-form-title">Submit a request</h2><p>{isRecruiterDemo ? 'Use synthetic information only. The shared contract validates the request before it is stored in this browser.' : 'All fields are synthetic demo information. The server validates the same shared contract before writing anything.'}</p>
    <label>Request type<select autoFocus value={form.requestType} onChange={(e) => setField('requestType', e.target.value as RequestSubmission['requestType'])}><option value="ai_project">Proposed AI project</option><option value="tool_access">AI tool access</option></select></label>
    <Field label="Request title" value={form.title} error={errors.title} onChange={(v) => setField('title', v)} />
    <div className="form-grid"><Field label="Department" value={form.department} error={errors.department} onChange={(v) => setField('department', v)} /><Field label="Requester name" value={form.requesterName} error={errors.requesterName} onChange={(v) => setField('requesterName', v)} /><Field label="Requester role" value={form.requesterRole} error={errors.requesterRole} onChange={(v) => setField('requesterRole', v)} /><Field label="Intended users (comma-separated)" value={users} error={errors.intendedUsers} onChange={setUsers} /></div>
    <TextArea label="Business problem" value={form.businessProblem} error={errors.businessProblem} onChange={(v) => setField('businessProblem', v)} /><TextArea label="Desired outcome" value={form.desiredOutcome} error={errors.desiredOutcome} onChange={(v) => setField('desiredOutcome', v)} /><TextArea label="Current process (optional)" value={form.currentProcess ?? ''} error={errors.currentProcess} onChange={(v) => setField('currentProcess', v)} /><Field label="Data sources (comma-separated)" value={sources} error={errors.dataSources} onChange={setSources} /><label className="checkbox-field"><input type="checkbox" checked={form.syntheticDemoSafe} onChange={(event) => setField('syntheticDemoSafe', event.target.checked)} /><span>This request contains synthetic demo-safe content eligible for optional audio.</span></label>
    {serverError && <p className="form-error" role="alert">{serverError}</p>}<button className="secondary-button full" disabled={submitting}>{submitting ? 'Submitting…' : isRecruiterDemo ? 'Add sandbox request' : 'Submit durable request'}</button>
  </form></div>
}

function Field({ label, value, error, onChange }: { label: string; value: string; error?: string; onChange: (value: string) => void }) { return <label>{label}<input value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />{error && <span className="field-error">{error}</span>}</label> }
function TextArea({ label, value, error, onChange }: { label: string; value: string; error?: string; onChange: (value: string) => void }) { return <label>{label}<textarea value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} />{error && <span className="field-error">{error}</span>}</label> }

export default App
