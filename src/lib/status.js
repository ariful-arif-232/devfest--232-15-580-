// The single source of truth for requirement statuses.

export const STATUS = {
  MISSING: 'MISSING',
  EXPIRY_NEEDED: 'EXPIRY_NEEDED',
  EXPIRED: 'EXPIRED',
  NOT_PROVIDED: 'NOT_PROVIDED',
  OK: 'OK',
}

export const BLOCKING = new Set([STATUS.MISSING, STATUS.EXPIRY_NEEDED, STATUS.EXPIRED])

// expiry and deadline are YYYY-MM-DD strings, so string comparison is date comparison.
export function requirementStatus(req, fileId, expiry, deadlineIso) {
  if (!fileId) return req.mandatory ? STATUS.MISSING : STATUS.NOT_PROVIDED
  if (req.has_expiry) {
    if (!expiry) return STATUS.EXPIRY_NEEDED
    if (expiry < deadlineIso) return STATUS.EXPIRED
  }
  return STATUS.OK
}

export function evaluate(requirements, matches, expiryByFile, deadlineIso) {
  const rows = requirements.map((req) => {
    const fileId = matches[req.id] || null
    const expiry = fileId ? expiryByFile[fileId] || '' : ''
    const status = requirementStatus(req, fileId, expiry, deadlineIso)
    return { req, fileId, expiry, status, blocking: BLOCKING.has(status) }
  })
  const blocking = rows.filter((r) => r.blocking)
  return {
    rows,
    blocking,
    ready: blocking.length === 0,
    okCount: rows.filter((r) => r.status === STATUS.OK).length,
  }
}
