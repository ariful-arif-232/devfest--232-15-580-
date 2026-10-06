// Optional AI Help: explains the current tender checklist with Google Gemini, using the user's own key.
// Only checklist metadata is sent (never PDF bytes or PDF text). The key is passed in per call and
// only ever placed in the request header; it is never stored, logged or included in errors.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
// The alias tracks Google's current Flash model; the pinned model is a fallback if the alias is unavailable.
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash']
const TIMEOUT_MS = 30000

export class AiError extends Error {
  constructor(key) {
    super(key)
    this.key = key
  }
}

// Builds the metadata summary sent to the model from the app's deterministic state.
export function buildTenderSummary({ tender, rows, files, fileById, dupGroups, ready, lang }) {
  const title = (req) => (lang === 'bn' ? req.title_bn : req.title_en)
  return {
    tender: {
      tender_id: tender.tender_id,
      title: tender.title,
      procuring_entity: tender.procuring_entity,
      bidder: tender.bidder,
      submission_deadline: tender.submission_deadline,
    },
    readiness: {
      ready_to_generate: ready,
      blocking_issues: rows.filter((r) => r.blocking).length,
      generate_button_enabled: ready,
    },
    requirements: rows.map((r) => {
      const file = r.fileId ? fileById[r.fileId] : null
      return {
        order: r.req.order,
        id: r.req.id,
        title: title(r.req),
        title_en: r.req.title_en,
        mandatory: r.req.mandatory,
        needs_expiry_date: r.req.has_expiry,
        status: r.status,
        blocking: r.blocking,
        matched_file: file ? file.name : null,
        pages: file ? file.pages : null,
        expiry_date: r.req.has_expiry && file ? r.expiry || null : null,
      }
    }),
    uploaded_files: files.map((f) => ({
      name: f.name,
      pages: f.pages,
      duplicate_of: dupGroups[f.hash].length > 1 ? dupGroups[f.hash].filter((g) => g.id !== f.id).map((g) => g.name) : [],
      matched: rows.some((r) => r.fileId === f.id),
    })),
  }
}

export function buildPrompt(summary, lang) {
  const language = lang === 'bn' ? 'Bangla (বাংলা)' : 'English'
  return [
    'You help an office worker prepare a tender submission package.',
    'Below is the current checklist produced by the application. Its statuses are authoritative:',
    'MISSING (mandatory, no file, blocking), EXPIRY_NEEDED (expiry date not entered, blocking),',
    'EXPIRED (expiry date before the submission deadline, blocking), NOT_PROVIDED (optional, not blocking), OK.',
    'An expiry date on or after the deadline is valid. Duplicate files have identical content and only one copy may be used.',
    'Rules: only explain the supplied data; do not invent documents, dates or requirements; do not change or',
    'second-guess the validation rules or statuses; do not ask for passwords, keys or other sensitive information.',
    `Answer in ${language}, concisely, in plain text (no tables), using these short sections:`,
    '1. Overall readiness  2. Blocking issues  3. Recommended next actions  4. Optional observations.',
    '',
    'Checklist data (JSON):',
    JSON.stringify(summary, null, 2),
  ].join('\n')
}

function errorFor(status, body) {
  const reason = JSON.stringify(body || {})
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(reason)) return 'errAiKey'
  if (status === 401 || status === 403) return 'errAiKey'
  if (status === 429) return 'errAiQuota'
  if (status === 404) return 'errAiUnavailable'
  if (status >= 500) return 'errAiUnavailable'
  return 'errAiRequest'
}

async function callModel(model, apiKey, prompt, signal, fetchImpl) {
  let res
  try {
    res = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      signal,
    })
  } catch (err) {
    throw new AiError(err?.name === 'AbortError' ? 'errAiTimeout' : 'errAiNetwork')
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    if (res.ok) throw new AiError('errAiBadResponse')
  }
  if (!res.ok) throw new AiError(errorFor(res.status, body))
  const parts = body?.candidates?.[0]?.content?.parts
  const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim() : ''
  if (!text) throw new AiError('errAiBadResponse')
  return text
}

// Returns the model's explanation as plain text, or throws AiError with a translation key.
export async function analyzeTender({ apiKey, summary, lang, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const key = String(apiKey || '').trim()
  if (!key) throw new AiError('errAiNoKey')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const prompt = buildPrompt(summary, lang)
    for (const [i, model] of MODELS.entries()) {
      try {
        return await callModel(model, key, prompt, controller.signal, fetchImpl)
      } catch (err) {
        // Only fall back to the next model when this one is not available.
        if (!(err instanceof AiError) || err.key !== 'errAiUnavailable' || i === MODELS.length - 1) throw err
      }
    }
    throw new AiError('errAiUnavailable')
  } finally {
    clearTimeout(timer)
  }
}
