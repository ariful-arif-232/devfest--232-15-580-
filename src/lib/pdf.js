import { PDFDocument, StandardFonts, rgb, degrees, EncryptedPDFError } from 'pdf-lib'

export const MAX_FILES = 30
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function hasPdfHeader(bytes) {
  // The PDF spec allows junk before the header; readers look in the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  return head.includes('%PDF-')
}

export function looksLikePdf(file) {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
}

// Reads a PDF and returns { bytes, hash, pages } or throws { key } for the UI.
export async function inspectPdf(file) {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (!hasPdfHeader(bytes)) throw { key: 'errNotPdf' }
  const hash = await sha256Hex(buffer)
  let pages
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    pages = doc.getPageCount()
    // Make sure the pages can actually be copied later, not just counted.
    const probe = await PDFDocument.create()
    await probe.copyPages(doc, doc.getPageIndices())
  } catch (err) {
    if (err instanceof EncryptedPDFError || /encrypt/i.test(String(err && err.message))) {
      throw { key: 'errEncrypted' }
    }
    throw { key: 'errDamaged' }
  }
  if (!pages) throw { key: 'errDamaged' }
  return { bytes, hash, pages }
}

// ---------- package generation ----------

const A4 = [595.28, 841.89]
const INK = rgb(0.11, 0.16, 0.24)
const MUTED = rgb(0.38, 0.43, 0.5)
const ACCENT = rgb(0.06, 0.33, 0.42)
const RULE = rgb(0.84, 0.86, 0.89)

// Standard fonts only cover WinAnsi; replace anything else so drawing never throws.
function safeText(font, text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    try {
      font.encodeText(ch)
      out += ch
    } catch {
      out += '?'
    }
  }
  return out
}

function wrap(font, text, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    // Break a single over-long word by characters.
    let rest = word
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    line = rest
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

export function todayIso() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function drawCover(page, fonts, tender, entries, generatedOn) {
  const { regular, bold } = fonts
  const [W, H] = A4
  const M = 56
  const width = W - M * 2
  let y = H - M

  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: ACCENT })
  page.drawText('TENDER SUBMISSION PACKAGE', { x: M, y: y - 10, size: 10, font: bold, color: ACCENT })
  y -= 40

  for (const line of wrap(bold, safeText(bold, tender.title || tender.tender_id), 20, width).slice(0, 3)) {
    page.drawText(line, { x: M, y, size: 20, font: bold, color: INK })
    y -= 26
  }
  y -= 8

  const details = [
    ['Tender ID', tender.tender_id],
    ['Tender Title', tender.title || '-'],
    ['Procuring Entity', tender.procuring_entity || '-'],
    ['Bidder', tender.bidder || '-'],
    ['Submission Deadline', tender.submission_deadline],
    ['Package Generated', generatedOn],
  ]
  const labelW = 130
  for (const [label, value] of details) {
    page.drawText(label, { x: M, y, size: 10, font: bold, color: MUTED })
    const lines = wrap(regular, safeText(regular, value), 11, width - labelW)
    for (const line of lines.slice(0, 3)) {
      page.drawText(line, { x: M + labelW, y, size: 11, font: regular, color: INK })
      y -= 15
    }
    y -= 5
  }

  y -= 8
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: RULE })
  y -= 24
  page.drawText('Included Documents', { x: M, y, size: 13, font: bold, color: INK })
  y -= 20

  // Shrink the list until it fits above the footer area.
  const bottom = 48
  const colNo = 26
  const colPages = 86
  let size = 10
  let layout
  for (; size >= 6; size -= 0.5) {
    const lh = size * 1.35
    layout = entries.map((e) => {
      const title = wrap(bold, safeText(bold, e.title), size, width - colNo - colPages)
      const file = wrap(regular, safeText(regular, e.fileName), size - 1, width - colNo - colPages)
      return { e, title, file, h: (title.length + file.length) * lh + size * 0.6 }
    })
    const total = layout.reduce((s, l) => s + l.h, size * 1.8)
    if (y - total >= bottom) break
  }
  const lh = size * 1.35

  page.drawText('#', { x: M, y, size: size - 1, font: bold, color: MUTED })
  page.drawText('Document / File', { x: M + colNo, y, size: size - 1, font: bold, color: MUTED })
  page.drawText('Pages', { x: W - M - colPages + 10, y, size: size - 1, font: bold, color: MUTED })
  y -= size * 0.6
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: RULE })
  y -= lh

  layout.forEach(({ e, title, file }, i) => {
    if (y < bottom) return
    page.drawText(String(i + 1), { x: M, y, size, font: bold, color: INK })
    const range = e.start === e.end ? `${e.start}` : `${e.start}-${e.end}`
    page.drawText(range, { x: W - M - colPages + 10, y, size, font: regular, color: INK })
    for (const line of title) {
      page.drawText(line, { x: M + colNo, y, size, font: bold, color: INK })
      y -= lh
    }
    for (const line of file) {
      page.drawText(line, { x: M + colNo, y, size: size - 1, font: regular, color: MUTED })
      y -= lh
    }
    y -= size * 0.6
  })
}

// Draws "<tender_id> | Page X of Y" centred on the visual bottom edge, honouring /Rotate.
function drawFooter(page, font, text) {
  const size = 8
  const tw = font.widthOfTextAtSize(text, size)
  const box = page.getCropBox()
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360
  const inset = 12
  let x, y
  if (rot === 90) {
    x = box.x + box.width - inset
    y = box.y + (box.height - tw) / 2
  } else if (rot === 180) {
    x = box.x + (box.width + tw) / 2
    y = box.y + box.height - inset
  } else if (rot === 270) {
    x = box.x + inset
    y = box.y + (box.height + tw) / 2
  } else {
    x = box.x + (box.width - tw) / 2
    y = box.y + inset
  }
  const rad = (rot * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const local = (lx, ly) => ({ x: x + lx * cos - ly * sin, y: y + lx * sin + ly * cos })
  const pad = 5
  const origin = local(-pad, -3)
  page.drawRectangle({
    x: origin.x,
    y: origin.y,
    width: tw + pad * 2,
    height: size + 5,
    rotate: degrees(rot),
    color: rgb(1, 1, 1),
    opacity: 0.85,
  })
  page.drawText(text, { x, y, size, font, color: INK, rotate: degrees(rot) })
}

// documents: [{ title, fileName, bytes }] already in final order.
export async function buildPackage(tender, documents) {
  const out = await PDFDocument.create()
  const regular = await out.embedFont(StandardFonts.Helvetica)
  const bold = await out.embedFont(StandardFonts.HelveticaBold)
  out.setTitle(`${tender.tender_id} Submission Package`)
  out.setProducer('Tender Document Package Builder')

  const cover = out.addPage(A4)
  const entries = []
  let next = 2
  for (const doc of documents) {
    const src = await PDFDocument.load(doc.bytes, { updateMetadata: false })
    const copied = await out.copyPages(src, src.getPageIndices())
    copied.forEach((p) => out.addPage(p))
    entries.push({ title: doc.title, fileName: doc.fileName, start: next, end: next + copied.length - 1 })
    next += copied.length
  }

  const generatedOn = todayIso()
  drawCover(cover, { regular, bold }, tender, entries, generatedOn)

  const pages = out.getPages()
  const total = pages.length
  const id = safeText(regular, tender.tender_id)
  pages.forEach((page, i) => drawFooter(page, regular, `${id} | Page ${i + 1} of ${total}`))

  const bytes = await out.save()
  return { bytes, total, entries, generatedOn }
}

export function packageFileName(tenderId) {
  // eslint-disable-next-line no-control-regex
  const safe = String(tenderId).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'Tender'
  return `${safe}_Package.pdf`
}
