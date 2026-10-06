function cell(value) {
  const s = String(value ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Columns: document, file name, pages, expiry date, status.
export function checklistCsv(rows, fileById, docName, statusName) {
  const lines = [['document', 'file name', 'pages', 'expiry date', 'status']]
  for (const row of rows) {
    const file = row.fileId ? fileById[row.fileId] : null
    lines.push([docName(row.req), file?.name ?? '', file?.pages ?? '', row.req.has_expiry ? row.expiry : '', statusName(row.status)])
  }
  return lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'
}
