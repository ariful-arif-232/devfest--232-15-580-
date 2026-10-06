// Parsing and validation of requirements.json.
// Errors are returned as { key, params } so the UI can translate them.

export class RequirementsError extends Error {
  constructor(key, params = {}) {
    super(key)
    this.key = key
    this.params = params
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

// Returns the YYYY-MM-DD part of a date string, or null if it is not a real date.
export function toIsoDate(value) {
  if (typeof value !== 'string') return null
  const m = value.trim().match(DATE_RE)
  if (!m) return null
  const [, y, mo, d] = m.map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return m[0]
}

function asText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asBool(value, field, index) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  throw new RequirementsError('errReqField', { n: index + 1, field })
}

export function parseRequirements(text) {
  let data
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new RequirementsError('errJsonSyntax')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RequirementsError('errJsonShape')
  }

  const t = data.tender
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    throw new RequirementsError('errTenderMissing')
  }
  const tender = {
    tender_id: asText(t.tender_id),
    title: asText(t.title),
    procuring_entity: asText(t.procuring_entity),
    bidder: asText(t.bidder),
    submission_deadline: asText(t.submission_deadline),
  }
  if (!tender.tender_id) throw new RequirementsError('errTenderField', { field: 'tender_id' })
  const deadline = toIsoDate(tender.submission_deadline)
  if (!deadline) throw new RequirementsError('errDeadline', { value: tender.submission_deadline || '—' })
  tender.deadlineIso = deadline

  if (!Array.isArray(data.requirements) || data.requirements.length === 0) {
    throw new RequirementsError('errReqList')
  }

  const seen = new Set()
  const requirements = data.requirements.map((r, index) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new RequirementsError('errReqItem', { n: index + 1 })
    }
    const id = asText(r.id)
    if (!id) throw new RequirementsError('errReqField', { n: index + 1, field: 'id' })
    if (seen.has(id)) throw new RequirementsError('errReqDupId', { id })
    seen.add(id)

    const order = typeof r.order === 'string' && r.order.trim() !== '' ? Number(r.order) : r.order
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new RequirementsError('errReqField', { n: index + 1, field: 'order' })
    }
    const title_en = asText(r.title_en)
    if (!title_en) throw new RequirementsError('errReqField', { n: index + 1, field: 'title_en' })

    return {
      id,
      order,
      title_en,
      title_bn: asText(r.title_bn) || title_en,
      mandatory: asBool(r.mandatory, 'mandatory', index),
      has_expiry: r.has_expiry === undefined ? false : asBool(r.has_expiry, 'has_expiry', index),
      index,
    }
  })

  // Numeric sort by order; original position breaks ties so the result is stable.
  requirements.sort((a, b) => a.order - b.order || a.index - b.index)
  return { tender, requirements }
}
