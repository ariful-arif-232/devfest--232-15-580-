import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { makeT, localDigits } from './lib/i18n.js'
import { parseRequirements, toIsoDate } from './lib/requirements.js'
import { evaluate, STATUS } from './lib/status.js'
import { inspectPdf, looksLikePdf, buildPackage, packageFileName, planPackage, parsePageList, isPng, MAX_FILES, MAX_TOTAL_BYTES } from './lib/pdf.js'
import { suggestMatches } from './lib/suggest.js'
import { checklistCsv } from './lib/csv.js'
import { saveProject, loadProject, clearProject, peekProject } from './lib/store.js'
import { analyzeTender, buildTenderSummary } from './lib/ai.js'
import './App.css'

let nextId = 1
const newId = () => `f${nextId++}`

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function initialLang() {
  try {
    return localStorage.getItem('tpb-lang') === 'bn' ? 'bn' : 'en'
  } catch {
    return 'en'
  }
}

function Dropzone({ accept, multiple, onFiles, title, hint, icon, compact, disabled, inputId }) {
  const [over, setOver] = useState(false)
  const inputRef = useRef(null)
  return (
    <div
      className={`dropzone${over ? ' is-over' : ''}${compact ? ' is-compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!disabled && e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
      }}
    >
      <span className="dropzone-icon" aria-hidden="true">{icon}</span>
      <div className="dropzone-text">
        <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={disabled}>
          {title}
        </button>
        <span className="muted">{hint}</span>
      </div>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          if (e.target.files.length) onFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function StatusBadge({ status, t }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{t(`st_${status}`)}</span>
}

export default function App() {
  const [lang, setLang] = useState(initialLang)
  const t = useMemo(() => makeT(lang), [lang])
  const num = useCallback((v) => localDigits(lang, v), [lang])

  const [data, setData] = useState(null)
  const [tenderError, setTenderError] = useState(null)
  const [files, setFiles] = useState([])
  const [rejected, setRejected] = useState([])
  const [matches, setMatches] = useState({})
  const [expiryByFile, setExpiryByFile] = useState({})
  const [busy, setBusy] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [genError, setGenError] = useState('')
  const [toast, setToast] = useState(null)
  const [withIndex, setWithIndex] = useState(false)
  const [saved, setSaved] = useState(null)
  const [seal, setSeal] = useState(null)
  const [sealPages, setSealPages] = useState('')
  const [sealPos, setSealPos] = useState('bottom-right')
  const [sealSize, setSealSize] = useState('m')
  const [sealError, setSealError] = useState('')
  // AI Help: the key lives only in this component's memory and is never persisted.
  const [aiKey, setAiKey] = useState('')
  const [aiShowKey, setAiShowKey] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult, setAiResult] = useState('')
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    peekProject().then(setSaved)
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
    try {
      localStorage.setItem('tpb-lang', lang)
    } catch {
      /* storage unavailable */
    }
  }, [lang])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => () => result && URL.revokeObjectURL(result.url), [result])
  useEffect(() => () => seal && URL.revokeObjectURL(seal.url), [seal])

  const requirements = useMemo(() => data?.requirements ?? [], [data])
  const reqById = useMemo(() => Object.fromEntries(requirements.map((r) => [r.id, r])), [requirements])
  const fileById = useMemo(() => Object.fromEntries(files.map((f) => [f.id, f])), [files])
  const docName = useCallback((req) => (lang === 'bn' ? req.title_bn : req.title_en), [lang])

  const reqOfFile = useMemo(() => {
    const map = {}
    for (const [reqId, fileId] of Object.entries(matches)) map[fileId] = reqId
    return map
  }, [matches])

  const dupGroups = useMemo(() => {
    const groups = {}
    for (const f of files) (groups[f.hash] ||= []).push(f)
    return groups
  }, [files])
  const dupCount = useMemo(() => Object.values(dupGroups).filter((g) => g.length > 1).length, [dupGroups])

  const evaluation = useMemo(
    () => (data ? evaluate(requirements, matches, expiryByFile, data.tender.deadlineIso) : null),
    [data, requirements, matches, expiryByFile],
  )

  const suggestions = useMemo(
    () => (data ? suggestMatches(requirements, files, matches) : {}),
    [data, requirements, files, matches],
  )

  const signature = useMemo(
    () => JSON.stringify([data?.tender.tender_id, matches, expiryByFile, files.map((f) => f.id), withIndex, withIndex ? lang : '', seal?.url, sealPages, sealPos, sealSize]),
    [data, matches, expiryByFile, files, withIndex, lang, seal, sealPages, sealPos, sealSize],
  )
  const resultFresh = result && result.signature === signature

  // Returns the requirement id that blocks this assignment because a duplicate copy is used there.
  const duplicateConflict = useCallback(
    (fileId, reqId) => {
      const hash = fileById[fileId]?.hash
      for (const [r, f] of Object.entries(matches)) {
        if (r !== reqId && f !== fileId && fileById[f]?.hash === hash) return r
      }
      return null
    },
    [matches, fileById],
  )

  // ---------- actions ----------

  async function loadJson(fileList) {
    const file = fileList[0]
    if (!file) return
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      setTenderError({ key: 'errNotJson' })
      return
    }
    try {
      const text = await file.text()
      const parsed = parseRequirements(text)
      setData({ ...parsed, sourceName: file.name, sourceText: text })
      setTenderError(null)
      setMatches({})
    } catch (err) {
      setTenderError(err && err.key ? { key: err.key, params: err.params } : { key: 'errReadFile' })
    }
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList)
    setBusy((b) => b + incoming.length)
    const rejects = []
    let count = files.length
    let total = files.reduce((s, f) => s + f.size, 0)
    const added = []
    for (const file of incoming) {
      try {
        if (!looksLikePdf(file)) throw { key: 'errNotPdf' }
        if (count >= MAX_FILES) throw { key: 'errTooMany', params: { max: MAX_FILES } }
        if (total + file.size > MAX_TOTAL_BYTES) throw { key: 'errTooBig', params: { max: MAX_TOTAL_BYTES / 1024 / 1024 } }
        const info = await inspectPdf(file)
        count += 1
        total += file.size
        added.push({ id: newId(), name: file.name, size: file.size, ...info })
      } catch (err) {
        rejects.push({ id: newId(), name: file.name, key: err?.key || 'errDamaged', params: err?.params })
      }
    }
    if (added.length) setFiles((prev) => [...prev, ...added])
    setRejected((prev) => [...rejects, ...prev])
    setBusy((b) => b - incoming.length)
  }

  function removeFile(fileId) {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
    setMatches((prev) => Object.fromEntries(Object.entries(prev).filter(([, f]) => f !== fileId)))
    setExpiryByFile((prev) => {
      const next = { ...prev }
      delete next[fileId]
      return next
    })
  }

  function assign(reqId, fileId) {
    if (!fileId) {
      setMatches((prev) => {
        const next = { ...prev }
        delete next[reqId]
        return next
      })
      return
    }
    if (duplicateConflict(fileId, reqId)) return
    const from = reqOfFile[fileId]
    setMatches((prev) => {
      const next = {}
      for (const [r, f] of Object.entries(prev)) if (f !== fileId && r !== reqId) next[r] = f
      next[reqId] = fileId
      return next
    })
    if (from && from !== reqId) {
      setToast(t('moved', { file: fileById[fileId].name, from: docName(reqById[from]), to: docName(reqById[reqId]) }))
    }
  }

  function acceptSuggestions(entries) {
    setMatches((prev) => {
      const next = { ...prev }
      for (const [reqId, fileId] of entries) {
        if (!next[reqId] && !Object.values(next).includes(fileId)) next[reqId] = fileId
      }
      return next
    })
  }

  function setExpiry(fileId, value) {
    setExpiryByFile((prev) => ({ ...prev, [fileId]: toIsoDate(value) || '' }))
  }

  async function generate() {
    if (!evaluation?.ready || generating) return
    setGenerating(true)
    setGenError('')
    try {
      const docs = evaluation.rows
        .filter((r) => r.fileId)
        .map((r) => ({ title: r.req.title_en, fileName: fileById[r.fileId].name, bytes: fileById[r.fileId].bytes }))
      const sealOpt = seal && sealList?.length ? { png: seal.bytes, pages: sealList, position: sealPos, size: sealSize } : null
      const out = await buildPackage(data.tender, docs, { index: withIndex ? await indexOptions() : null, seal: sealOpt })
      const url = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }))
      setResult({ url, name: packageFileName(data.tender.tender_id), total: out.total, docs: docs.length, signature })
    } catch (err) {
      setGenError(t('genError', { msg: err?.message || String(err) }))
    } finally {
      setGenerating(false)
    }
  }

  // Index labels: Helvetica text in English; Bangla is shaped by the browser with the bundled font.
  async function indexOptions() {
    const reqs = evaluation.rows.filter((r) => r.fileId).map((r) => r.req)
    if (lang !== 'bn') {
      return { heading: 'Index', columns: { document: 'Document', start: 'Starts at' }, labels: reqs.map((r) => r.title_en) }
    }
    const { renderLabel } = await import('./lib/bnText.js')
    return {
      heading: await renderLabel('সূচিপত্র', 20),
      columns: { document: await renderLabel('কাগজ', 10), start: await renderLabel('শুরুর পৃষ্ঠা', 10, 68) },
      labels: await Promise.all(reqs.map((r) => renderLabel(r.title_bn, 11, 360))),
    }
  }

  function focusRequirement(reqId) {
    const row = document.getElementById(`req-${reqId}`)
    if (!row) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    const target = row.querySelector('input[type="date"]') || row.querySelector('select')
    target?.focus({ preventScroll: true })
  }

  function exportCsv() {
    const csv = checklistCsv(evaluation.rows, fileById, (req) => docName(req), (s) => t(`st_${s}`))
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.tender.tender_id}_Checklist.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function chooseSeal(fileList) {
    const file = fileList[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (!isPng(bytes)) {
      setSealError('errSealPng')
      return
    }
    setSealError('')
    setSeal({ name: file.name, bytes, url: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })) })
  }

  async function runAiHelp() {
    if (aiLoading || !evaluation) return
    setAiLoading(true)
    setAiError('')
    try {
      const summary = buildTenderSummary({ tender: data.tender, rows: evaluation.rows, files, fileById, dupGroups, ready: evaluation.ready, lang })
      setAiResult(await analyzeTender({ apiKey: aiKey, summary, lang }))
    } catch (err) {
      setAiResult('')
      setAiError(err?.key || 'errAiRequest')
    } finally {
      setAiLoading(false)
    }
  }

  async function saveWork() {
    try {
      await saveProject({ version: 1, sourceText: data.sourceText, sourceName: data.sourceName, lang, withIndex, matches, expiryByFile }, files)
      setSaved(await peekProject())
      setToast(t('savedToast'))
    } catch (err) {
      setToast(t('saveFailed', { msg: err?.message || String(err) }))
    }
  }

  async function reopenWork() {
    try {
      const restored = await loadProject()
      if (!restored) return
      const { project, files: restoredFiles, missing } = restored
      const parsed = parseRequirements(project.sourceText)
      const fileIds = new Set(restoredFiles.map((f) => f.id))
      const reqIds = new Set(parsed.requirements.map((r) => r.id))
      for (const f of restoredFiles) nextId = Math.max(nextId, Number(f.id.slice(1)) + 1)
      setData({ ...parsed, sourceName: project.sourceName, sourceText: project.sourceText })
      setFiles(restoredFiles)
      setMatches(Object.fromEntries(Object.entries(project.matches || {}).filter(([r, f]) => reqIds.has(r) && fileIds.has(f))))
      setExpiryByFile(Object.fromEntries(Object.entries(project.expiryByFile || {}).filter(([f]) => fileIds.has(f))))
      setWithIndex(!!project.withIndex)
      if (project.lang === 'bn' || project.lang === 'en') setLang(project.lang)
      setRejected(missing.map((name) => ({ id: newId(), name, key: 'errRestore' })))
      setResult(null)
      setTenderError(null)
      setGenError('')
      setToast(t('reopenedToast'))
    } catch (err) {
      setToast(t('reopenFailed', { msg: err?.message || String(err) }))
    }
  }

  async function clearSaved() {
    try {
      await clearProject()
    } finally {
      setSaved(null)
      setToast(t('clearedToast'))
    }
  }

  function resetAll() {
    if (!window.confirm(t('resetConfirm'))) return
    setData(null)
    setFiles([])
    setRejected([])
    setMatches({})
    setExpiryByFile({})
    setResult(null)
    setTenderError(null)
    setGenError('')
  }

  // ---------- derived view data ----------

  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const matchedRows = evaluation ? evaluation.rows.filter((r) => r.fileId) : []
  const matchedPages = matchedRows.reduce((s, r) => s + (fileById[r.fileId]?.pages || 0), 0)
  const plan = planPackage(matchedRows.map((r) => fileById[r.fileId]?.pages || 0), withIndex)
  const mandatoryRows = evaluation ? evaluation.rows.filter((r) => r.req.mandatory) : []
  const optionalRows = evaluation ? evaluation.rows.filter((r) => !r.req.mandatory) : []
  const sealList = seal ? parsePageList(sealPages, plan.total) : null
  const sealInvalid = !!seal && (!sealList || sealList.length === 0)
  const pageLabel = (a, b) => (a === b ? t('mfPage', { a }) : t('mfRange', { a, b }))
  const suggestionEntries = Object.entries(suggestions)
  const steps = [
    { n: 1, label: t('step1'), done: !!data, href: '#step-tender' },
    { n: 2, label: t('step2'), done: files.length > 0, href: '#step-upload' },
    { n: 3, label: t('step3'), done: !!evaluation?.ready, href: '#step-match' },
    { n: 4, label: t('step4'), done: !!resultFresh, href: '#step-generate' },
  ]
  const progress = evaluation ? Math.round(((evaluation.rows.length - evaluation.blocking.length) / evaluation.rows.length) * 100) : 0

  function blockingReason(row) {
    return t(`why_${row.status}`, {
      doc: docName(row.req),
      date: row.expiry,
      deadline: data.tender.submission_deadline,
    })
  }

  return (
    <div className={`app lang-${lang}`}>
      <a className="skip-link" href="#main">{t('skip')}</a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12v2h8v-2H8Zm0 4v2h5v-2H8Z"/></svg>
            </span>
            <div>
              <div className="brand-name">{t('appName')}</div>
              <div className="trust-badge">
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v10h16V6H4Z"/></svg>
                {t('privacy')}
              </div>
            </div>
          </div>
          <div className="lang-switch" role="group" aria-label={t('langLabel')}>
            <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')} lang="en">English</button>
            <button type="button" aria-pressed={lang === 'bn'} onClick={() => setLang('bn')} lang="bn">বাংলা</button>
          </div>
        </div>
        <nav className="stepper" aria-label={t('workflow')}>
          <ol>
            {steps.map((s) => (
              <li key={s.n} className={s.done ? 'is-done' : ''}>
                <a href={s.href}>
                  <span className="step-num" aria-hidden="true">{s.done ? '✓' : num(s.n)}</span>
                  <span className="step-label">{s.label}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      <main id="main" className="layout">
        <div className="main-col">
          {/* STEP 1 */}
          <section id="step-tender" className="card" aria-labelledby="h-tender">
            <div className="card-head">
              <span className="eyebrow">{t('stepOf', { n: 1 })}</span>
              <h2 id="h-tender">{t('tenderTitle')}</h2>
              {!data && <p className="muted">{t('tenderHelp')}</p>}
            </div>
            {data ? (
              <>
                <div className="tender-head">
                  <div>
                    <div className="tender-id">{data.tender.tender_id}</div>
                    <h3 className="tender-title">{data.tender.title || '—'}</h3>
                  </div>
                  <Dropzone
                    compact
                    accept=".json,application/json"
                    onFiles={loadJson}
                    title={t('replaceJson')}
                    hint=""
                    icon=""
                    inputId="json-input-replace"
                  />
                </div>
                <dl className="tender-grid">
                  <div><dt>{t('entity')}</dt><dd>{data.tender.procuring_entity || '—'}</dd></div>
                  <div><dt>{t('bidder')}</dt><dd>{data.tender.bidder || '—'}</dd></div>
                  <div><dt>{t('deadline')}</dt><dd className="strong">{data.tender.submission_deadline}</dd></div>
                  <div>
                    <dt>{t('colDocument')}</dt>
                    <dd>{t('reqCount', { n: requirements.length, m: requirements.filter((r) => r.mandatory).length })}</dd>
                  </div>
                </dl>
                <p className="muted small">{t('loadedFrom', { name: data.sourceName })}</p>
              </>
            ) : (
              <Dropzone
                accept=".json,application/json"
                onFiles={loadJson}
                title={t('chooseJson')}
                hint={t('dropJson')}
                icon={<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M5 3h9l5 5v13H5V3Zm8 1.5V9h4.5L13 4.5ZM8.5 13c-.8 0-1 .6-1 1.2v.6c0 .3-.2.5-.5.5v1c.3 0 .5.2.5.5v.6c0 .6.2 1.2 1 1.2h.5v-1h-.3c-.2 0-.2-.1-.2-.3v-.8c0-.4-.2-.6-.5-.7.3-.1.5-.3.5-.7v-.8c0-.2 0-.3.2-.3H9v-1h-.5Zm7 0H15v1h.3c.2 0 .2.1.2.3v.8c0 .4.2.6.5.7-.3.1-.5.3-.5.7v.8c0 .2 0 .3-.2.3H15v1h.5c.8 0 1-.6 1-1.2v-.6c0-.3.2-.5.5-.5v-1c-.3 0-.5-.2-.5-.5v-.6c0-.6-.2-1.2-1-1.2Z"/></svg>}
                inputId="json-input"
              />
            )}
            {tenderError && (
              <div className="alert alert-error" role="alert">
                <strong>requirements.json</strong> — {t(tenderError.key, tenderError.params)}
              </div>
            )}
            {(data || saved) && (
              <div className="saved-bar">
                <div className="saved-text">
                  <strong>{t('savedTitle')}</strong>
                  <span className="muted small">
                    {saved
                      ? t('savedInfo', { id: saved.sourceText ? (() => { try { return JSON.parse(saved.sourceText).tender.tender_id } catch { return '—' } })() : '—', n: (saved.files || []).length, date: new Date(saved.savedAt).toLocaleString(lang === 'bn' ? 'bn-BD' : 'en-GB') })
                      : t('savedNone')}
                  </span>
                </div>
                <div className="saved-actions">
                  {data && <button type="button" className="btn btn-secondary btn-sm" onClick={saveWork}>{t('saveWork')}</button>}
                  {saved && <button type="button" className="btn btn-ghost btn-sm" onClick={reopenWork}>{t('reopenWork')}</button>}
                  {saved && <button type="button" className="btn btn-ghost btn-sm" onClick={clearSaved}>{t('clearSaved')}</button>}
                </div>
              </div>
            )}
          </section>

          {/* STEP 2 */}
          <section id="step-upload" className="card" aria-labelledby="h-upload">
            <div className="card-head">
              <span className="eyebrow">{t('stepOf', { n: 2 })}</span>
              <h2 id="h-upload">{t('uploadTitle')}</h2>
              <p className="muted">{t('uploadHelp', { files: MAX_FILES, mb: 50 })}</p>
            </div>
            <Dropzone
              accept=".pdf,application/pdf"
              multiple
              onFiles={addFiles}
              disabled={busy > 0}
              title={t('choosePdfs')}
              hint={t('dropPdfs')}
              icon={<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M12 3 7 8h3v6h4V8h3l-5-5ZM5 16v4h14v-4h2v6H3v-6h2Z"/></svg>}
              inputId="pdf-input"
            />
            <div className="usage">
              <span>{t('usage', { n: files.length, max: MAX_FILES, size: formatSize(totalSize), maxSize: '50 MB' })}</span>
              <span className="meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (totalSize / MAX_TOTAL_BYTES) * 100)}%` }} /></span>
            </div>
            {busy > 0 && <p className="muted" role="status">{t('processing', { n: busy })}</p>}

            {rejected.length > 0 && (
              <div className="alert alert-error" role="alert">
                <div className="alert-head">
                  <strong>{t('rejectedTitle')}</strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRejected([])}>{t('dismiss')}</button>
                </div>
                <ul className="reject-list">
                  {rejected.map((r) => (
                    <li key={r.id}><span className="filename">{r.name}</span> — {t(r.key, r.params)}</li>
                  ))}
                </ul>
              </div>
            )}

            {dupCount > 0 && (
              <div className="alert alert-warn" role="status">
                <strong>{t('duplicate')} ({num(dupCount)})</strong> — {t('duplicateNote')}
              </div>
            )}

            {files.length === 0 ? (
              <div className="empty">
                <span className="empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M4 4h6l2 2h8v12a2 2 0 0 1-2 2H4V4Zm2 4v10h12V8H6Z"/></svg>
                </span>
                <strong>{t('noFiles')}</strong>
                <span className="muted">{t('noFilesHelp')}</span>
              </div>
            ) : (
              <ul className="file-list">
                {files.map((f) => {
                  const group = dupGroups[f.hash]
                  const isDup = group.length > 1
                  const matchedReq = reqOfFile[f.id]
                  return (
                    <li key={f.id} className={`file-row${isDup ? ' is-dup' : ''}`}>
                      <span className="pdf-icon" aria-hidden="true">PDF</span>
                      <div className="file-main">
                        <div className="filename" title={f.name}>{f.name}</div>
                        <div className="file-meta">
                          <span>{f.pages === 1 ? t('page1') : t('pages', { n: f.pages })}</span>
                          <span>·</span>
                          <span>{formatSize(f.size)}</span>
                          {isDup && <span className="badge badge-dup">{t('duplicate')}</span>}
                        </div>
                        {isDup && (
                          <div className="dup-note">
                            {t('duplicateOf', { names: group.filter((g) => g.id !== f.id).map((g) => g.name).join(', ') })}
                            <span className={`dup-state${matchedReq ? ' is-used' : ''}`}>
                              {matchedReq
                                ? t('dupInUse', { doc: docName(reqById[matchedReq]) })
                                : group.some((g) => reqOfFile[g.id])
                                  ? t('dupUnused')
                                  : t('dupChooseOne')}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="file-match">
                        <label className="sr-only" htmlFor={`fm-${f.id}`}>{t('chooseRequirement')}: {f.name}</label>
                        <select
                          id={`fm-${f.id}`}
                          value={matchedReq || ''}
                          disabled={!data}
                          onChange={(e) => {
                            if (e.target.value) assign(e.target.value, f.id)
                            else if (matchedReq) assign(matchedReq, '')
                          }}
                        >
                          <option value="">{data ? t('notMatched') : t('noTender')}</option>
                          {requirements.map((r) => {
                            const conflict = duplicateConflict(f.id, r.id)
                            const holder = matches[r.id] && matches[r.id] !== f.id ? fileById[matches[r.id]] : null
                            return (
                              <option key={r.id} value={r.id} disabled={!!conflict}>
                                {num(r.order)}. {docName(r)}
                                {conflict ? ` — ${t('dupUsedBy', { doc: docName(reqById[conflict]) })}` : holder ? ` — ${holder.name}` : ''}
                              </option>
                            )
                          })}
                        </select>
                      </div>
                      <button type="button" className="btn btn-icon" onClick={() => removeFile(f.id)} aria-label={t('removeFile', { name: f.name })} title={t('remove')}>
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* STEP 3 */}
          <section id="step-match" className="card" aria-labelledby="h-match">
            <div className="card-head">
              <span className="eyebrow">{t('stepOf', { n: 3 })}</span>
              <h2 id="h-match">{t('matchTitle')}</h2>
              <p className="muted">{data ? t('matchHelp') : t('matchNeedTender')}</p>
            </div>

            {suggestionEntries.length > 0 && (
              <div className="suggest-box">
                <div>
                  <strong>{t('suggestionsTitle')}</strong>
                  <span className="muted small"> — {t('suggestionsHelp')}</span>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => acceptSuggestions(suggestionEntries)}>
                  {t('acceptAll', { n: suggestionEntries.length })}
                </button>
              </div>
            )}

            {evaluation && (
              <div className="req-table" role="table" aria-label={t('matchTitle')}>
                <div className="req-row req-header" role="row">
                  <span role="columnheader">{t('colOrder')}</span>
                  <span role="columnheader">{t('colDocument')}</span>
                  <span role="columnheader">{t('colFileMatch')}</span>
                  <span role="columnheader">{t('colExpiry')}</span>
                  <span role="columnheader">{t('colStatus')}</span>
                </div>
                {evaluation.rows.map((row) => {
                  const { req, fileId, expiry, status } = row
                  const sugg = suggestions[req.id] ? fileById[suggestions[req.id]] : null
                  return (
                    <div key={req.id} id={`req-${req.id}`} className={`req-row status-${status.toLowerCase()}`} role="row">
                      <span className="req-order" role="cell">{num(req.order)}</span>
                      <div className="req-doc" role="cell">
                        <div className="req-title">{docName(req)}</div>
                        <div className="req-tags">
                          <span className="req-id">{req.id}</span>
                          <span className={`tag ${req.mandatory ? 'tag-mand' : 'tag-opt'}`}>{req.mandatory ? t('mandatory') : t('optional')}</span>
                          {req.has_expiry && <span className="tag tag-exp">{t('needsExpiry')}</span>}
                        </div>
                      </div>
                      <div className="req-file" role="cell">
                        <label className="sr-only" htmlFor={`rm-${req.id}`}>{t('colFileMatch')}: {docName(req)}</label>
                        <div className="select-row">
                          <select id={`rm-${req.id}`} value={fileId || ''} onChange={(e) => assign(req.id, e.target.value)} disabled={!files.length}>
                            <option value="">{t('notMatched')}</option>
                            {files.map((f) => {
                              const conflict = duplicateConflict(f.id, req.id)
                              const usedFor = reqOfFile[f.id] && reqOfFile[f.id] !== req.id ? reqById[reqOfFile[f.id]] : null
                              return (
                                <option key={f.id} value={f.id} disabled={!!conflict}>
                                  {f.name}
                                  {conflict ? ` — ${t('dupUsedBy', { doc: docName(reqById[conflict]) })}` : usedFor ? ` — ${t('inUseBy', { doc: docName(usedFor) })}` : ''}
                                </option>
                              )
                            })}
                          </select>
                          {fileId && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => assign(req.id, '')} aria-label={t('unmatchFor', { doc: docName(req) })}>
                              {t('unmatch')}
                            </button>
                          )}
                        </div>
                        {sugg && (
                          <div className="suggest-inline">
                            <span>{t('suggestion', { file: sugg.name })}</span>
                            <button type="button" className="link-btn" onClick={() => assign(req.id, sugg.id)}>{t('accept')}</button>
                          </div>
                        )}
                        {fileId && (
                          <div className="matched-file small">
                            <span className="filename">{fileById[fileId].name}</span>
                            <span className="muted"> · {fileById[fileId].pages === 1 ? t('page1') : t('pages', { n: fileById[fileId].pages })}</span>
                          </div>
                        )}
                      </div>
                      <div className="req-expiry" role="cell">
                        {req.has_expiry && fileId ? (
                          <>
                            <label className="sr-only" htmlFor={`ex-${req.id}`}>{t('expiryLabel', { doc: docName(req) })}</label>
                            <input
                              id={`ex-${req.id}`}
                              type="date"
                              value={expiry}
                              onChange={(e) => setExpiry(fileId, e.target.value)}
                              aria-invalid={status === STATUS.EXPIRED || status === STATUS.EXPIRY_NEEDED}
                              aria-describedby={`exh-${req.id}`}
                            />
                            <div id={`exh-${req.id}`} className="muted small">{t('expiryHint', { date: data.tender.submission_deadline })}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                      <div className="req-status" role="cell">
                        <StatusBadge status={status} t={t} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="card card-ai" aria-labelledby="h-ai">
            <div className="card-head">
              <h2 id="h-ai">{t('aiTitle')}</h2>
              <p className="muted">{t('aiIntro')}</p>
            </div>
            <div className="ai-form">
              <label className="ai-key">
                <span className="small strong">{t('aiKeyLabel')}</span>
                <span className="ai-key-row">
                  <input
                    type={aiShowKey ? 'text' : 'password'}
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    data-lpignore="true"
                    placeholder="AIza…"
                  />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAiShowKey((v) => !v)} aria-pressed={aiShowKey}>
                    {aiShowKey ? t('aiHide') : t('aiShow')}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAiKey(''); setAiShowKey(false) }} disabled={!aiKey}>
                    {t('aiClearKey')}
                  </button>
                </span>
              </label>
              <button type="button" className="btn btn-secondary" onClick={runAiHelp} disabled={aiLoading || !data}>
                {aiLoading ? t('aiLoading') : t('aiAnalyze')}
              </button>
            </div>
            <p className="muted small ai-note">{t('aiPrivacy')}</p>
            {!data && <p className="muted small">{t('aiNeedTender')}</p>}
            {aiError && (
              <div className="alert alert-error small" role="alert">
                {t(aiError)} {t('aiFailNote')}
              </div>
            )}
            {aiLoading && <p className="muted small" role="status">{t('aiLoading')}</p>}
            {aiResult && (
              <div className="ai-result" role="region" aria-label={t('aiResultTitle')}>
                <div className="ai-result-head">
                  <strong>{t('aiResultTitle')}</strong>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAiResult('')}>{t('aiClearResult')}</button>
                </div>
                <div className="ai-text">{aiResult.replace(/\*\*/g, '')}</div>
                <p className="ai-disclaimer small">{t('aiDisclaimer')}</p>
              </div>
            )}
          </section>
        </div>

        {/* STEP 4 / readiness */}
        <aside className="side-col" id="step-generate" aria-labelledby="h-generate">
          <section className="card card-sticky">
            <span className="eyebrow">{t('stepOf', { n: 4 })}</span>
            <h2 id="h-generate">{t('generateTitle')}</h2>

            {!evaluation ? (
              <p className="muted">{t('noTender')}</p>
            ) : (
              <>
                <div className={`readiness ${evaluation.ready ? 'is-ready' : 'is-blocked'}`} role="status" aria-live="polite">
                  <div className="readiness-top">
                    <span className="readiness-label">{t('readiness')}</span>
                    <strong>{evaluation.ready ? t('ready') : t('blockingN', { n: evaluation.blocking.length })}</strong>
                  </div>
                  <div className="progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
                  <div className="muted small">{t('okOf', { ok: evaluation.okCount, total: evaluation.rows.length })}</div>
                </div>

                <section className="preflight" aria-labelledby="h-preflight">
                  <h3 id="h-preflight">{t('pfTitle')}</h3>
                  <dl className="pf-grid">
                    <div className={mandatoryRows.every((r) => !r.blocking) ? 'is-good' : 'is-bad'}>
                      <dt>{t('pfMandatory')}</dt>
                      <dd>{num(mandatoryRows.filter((r) => !r.blocking).length)} / {num(mandatoryRows.length)}</dd>
                    </div>
                    <div>
                      <dt>{t('pfOptional')}</dt>
                      <dd>{num(optionalRows.filter((r) => r.fileId).length)} / {num(optionalRows.length)}</dd>
                    </div>
                    <div className={evaluation.blocking.length ? 'is-bad' : 'is-good'}>
                      <dt>{t('pfBlocking')}</dt>
                      <dd>{num(evaluation.blocking.length)}</dd>
                    </div>
                    <div>
                      <dt>{t('pfUploaded')}</dt>
                      <dd>{num(files.length)}</dd>
                    </div>
                    <div>
                      <dt>{t('pfIncluded')}</dt>
                      <dd>{num(matchedRows.length)}</dd>
                    </div>
                    <div>
                      <dt>{t('pfSource')}</dt>
                      <dd>{num(plan.sourcePages)}</dd>
                    </div>
                    <div className="pf-wide">
                      <dt>{t('pfTotal')}</dt>
                      <dd>{num(plan.total)}</dd>
                    </div>
                  </dl>
                  <p className={`pf-verdict ${evaluation.ready ? 'is-good' : 'is-bad'}`}>
                    {evaluation.ready ? t('ready') : t('actionRequired')}
                  </p>
                </section>

                <ul className="status-counts">
                  {Object.values(STATUS).map((s) => {
                    const n = evaluation.rows.filter((r) => r.status === s).length
                    return n ? (
                      <li key={s}><StatusBadge status={s} t={t} /> <span>{num(n)}</span></li>
                    ) : null
                  })}
                </ul>

                {!evaluation.ready && (
                  <div className="blocking">
                    <h3>{t('blockingTitle')}</h3>
                    <ul>
                      {evaluation.blocking.map((row) => (
                        <li key={row.req.id}>
                          <a
                            href={`#req-${row.req.id}`}
                            onClick={(e) => {
                              e.preventDefault()
                              focusRequirement(row.req.id)
                            }}
                          >
                            <span className="issue-doc">{docName(row.req)}</span> — <span className="issue-status">{t(`st_${row.status}`)}</span>
                            <span className="issue-why">{blockingReason(row).replace(`${docName(row.req)}: `, '')}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <section className="manifest" aria-labelledby="h-manifest">
                  <h3 id="h-manifest">{t('mfTitle')}</h3>
                  <ol className="mf-list">
                    <li className="mf-fixed">
                      <span className="mf-title">{t('mfCover')}</span>
                      <span className="mf-pages">{pageLabel(num(1), num(1))}</span>
                    </li>
                    {withIndex && (
                      <li className="mf-fixed">
                        <span className="mf-title">{t('mfIndex')}</span>
                        <span className="mf-pages">{pageLabel(num(2), num(2))}</span>
                      </li>
                    )}
                    {matchedRows.map((r, i) => (
                      <li key={r.req.id}>
                        <span className="mf-title">{docName(r.req)}</span>
                        <span className="mf-pages">{pageLabel(num(plan.ranges[i].start), num(plan.ranges[i].end))}</span>
                        <span className="mf-file">
                          {fileById[r.fileId].name} · {fileById[r.fileId].pages === 1 ? t('page1') : t('pages', { n: fileById[r.fileId].pages })}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {matchedRows.length === 0 && <p className="muted small">{t('mfEmpty')}</p>}
                  <p className="mf-total">{t('mfTotal', { n: plan.total })}</p>
                </section>

                <label className="check-row">
                  <input type="checkbox" checked={withIndex} onChange={(e) => setWithIndex(e.target.checked)} />
                  <span>
                    <strong>{t('indexToggle')}</strong>
                    <span className="muted small">{t('indexHint')}</span>
                  </span>
                </label>

                <section className="seal-box" aria-labelledby="h-seal">
                  <h3 id="h-seal">{t('sealTitle')}</h3>
                  {!seal ? (
                    <>
                      <label className="btn btn-ghost btn-sm seal-choose">
                        {t('sealChoose')}
                        <input type="file" accept="image/png,.png" className="sr-only" onChange={(e) => { chooseSeal(e.target.files); e.target.value = '' }} />
                      </label>
                      <p className="muted small">{t('sealHint')}</p>
                    </>
                  ) : (
                    <>
                      <div className="seal-head">
                        <img src={seal.url} alt={t('sealPreviewAlt')} className="seal-preview" />
                        <span className="filename small">{seal.name}</span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSeal(null); setSealPages('') }}>{t('remove')}</button>
                      </div>
                      <div className="seal-fields">
                        <label>
                          <span className="small">{t('sealPages', { max: plan.total })}</span>
                          <input type="text" inputMode="numeric" value={sealPages} placeholder={`1, ${plan.total}`} onChange={(e) => setSealPages(e.target.value)} aria-invalid={sealInvalid} />
                        </label>
                        <label>
                          <span className="small">{t('sealPos')}</span>
                          <select value={sealPos} onChange={(e) => setSealPos(e.target.value)}>
                            {['bottom-right', 'bottom-left'].map((p) => <option key={p} value={p}>{t(`pos_${p}`)}</option>)}
                          </select>
                        </label>
                        <label>
                          <span className="small">{t('sealSize')}</span>
                          <select value={sealSize} onChange={(e) => setSealSize(e.target.value)}>
                            {['s', 'm', 'l'].map((z) => <option key={z} value={z}>{t(`size_${z}`)}</option>)}
                          </select>
                        </label>
                      </div>
                      <p className={`small ${sealInvalid ? 'seal-err' : 'seal-ok'}`} role="status">
                        {sealInvalid ? t('errSealPages', { max: plan.total }) : t('sealWill', { list: sealList.map((n) => num(n)).join(', ') })}
                      </p>
                    </>
                  )}
                  {sealError && <p className="small seal-err" role="alert">{t(sealError)}</p>}
                </section>

                <p className="muted small">{t('generateHelp', { id: data.tender.tender_id })}</p>
                {evaluation.ready && (
                  <p className="small include-line">
                    {withIndex
                      ? t('willIncludeIdx', { docs: matchedRows.length, pages: matchedPages, total: plan.total })
                      : t('willInclude', { docs: matchedRows.length, pages: matchedPages, total: plan.total })}
                  </p>
                )}

                <button type="button" className="btn btn-primary btn-block btn-lg" disabled={!evaluation.ready || generating || sealInvalid} onClick={generate} aria-describedby="gen-state">
                  {generating ? t('generating') : t('generate')}
                </button>
                <span id="gen-state" className="sr-only">{evaluation.ready ? t('ready') : t('blockingN', { n: evaluation.blocking.length })}</span>

                {genError && <div className="alert alert-error" role="alert">{genError}</div>}

                {result && resultFresh && (
                  <div className="result" role="status">
                    <div className="result-head">
                      <span className="result-check" aria-hidden="true">✓</span>
                      <div>
                        <strong>{t('generated')}</strong>
                        <div className="muted small">{t('generatedInfo', { pages: result.total, docs: result.docs })}</div>
                      </div>
                    </div>
                    <dl className="result-facts">
                      <div><dt>{t('colFile')}</dt><dd className="filename">{result.name}</dd></div>
                      <div><dt>{t('pfIncluded')}</dt><dd>{num(result.docs)}</dd></div>
                      <div><dt>{t('pfTotal')}</dt><dd>{num(result.total)}</dd></div>
                      <div><dt>{t('colStatus')}</dt><dd className="ok-text">✓ {t('validated')}</dd></div>
                    </dl>
                    <a className="btn btn-success btn-block" href={result.url} download={result.name}>
                      {t('download', { name: result.name })}
                    </a>
                    <a className="btn btn-secondary btn-block" href={result.url} target="_blank" rel="noopener">
                      {t('preview')}
                    </a>
                  </div>
                )}
                {result && !resultFresh && <div className="alert alert-warn small">{t('stale')}</div>}

                <div className="side-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={exportCsv}>{t('exportCsv')}</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={resetAll}>{t('reset')}</button>
                </div>
              </>
            )}
          </section>
        </aside>
      </main>

      <footer className="site-footer">
        <p>{t('footerNote')}</p>
      </footer>

      <div className="toast-region" aria-live="polite">
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  )
}
