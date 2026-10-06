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

  // Shrink the list until it fits within the page margins. If it still does not fit,
  // drop the file-name lines so every included document is always listed.
  const bottom = 56
  const colNo = 26
  const colPages = 86
  let size = 10
  let layout
  fitting: for (const withFiles of [true, false]) {
    for (size = 10; size >= 6; size -= 0.5) {
      const lh = size * 1.35
      layout = entries.map((e) => {
        const title = wrap(bold, safeText(bold, e.title), size, width - colNo - colPages)
        const file = withFiles ? wrap(regular, safeText(regular, e.fileName), size - 1, width - colNo - colPages) : []
        return { e, title, file, h: (title.length + file.length) * lh + size * 0.6 }
      })
      const total = layout.reduce((s, l) => s + l.h, size * 1.8)
      if (y - total >= bottom) break fitting
    }
  }
  size = Math.max(size, 6)
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

// ---------- footer band ----------
// Every output page gets a dedicated band added below its visible area; the footer (and an
// optional seal) are drawn only inside that band, so original page content is never covered.
const FOOTER_BAND = 24
const SEAL_PAD = 6

function pageFrame(page) {
  const box = page.getCropBox()
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360
  const sideways = rot === 90 || rot === 270
  return { box, rot, VW: sideways ? box.height : box.width, VH: sideways ? box.width : box.height }
}

// Grows the visible page by `extra` points on its visual bottom edge (honouring /Rotate).
// Content keeps its coordinates and scale, so nothing is moved, cropped or resized.
function extendVisualBottom(page, extra) {
  const { box, rot } = pageFrame(page)
  let { x, y, width, height } = box
  if (rot === 90) width += extra
  else if (rot === 180) height += extra
  else if (rot === 270) {
    x -= extra
    width += extra
  } else {
    y -= extra
    height += extra
  }
  page.setCropBox(x, y, width, height)
  const m = page.getMediaBox()
  const x0 = Math.min(m.x, x)
  const y0 = Math.min(m.y, y)
  page.setMediaBox(x0, y0, Math.max(m.x + m.width, x + width) - x0, Math.max(m.y + m.height, y + height) - y0)
}

// Maps visual coordinates (origin at the visual bottom-left) to page coordinates.
function visualToPage(page) {
  const { box, rot, VW } = pageFrame(page)
  const map = (vx, vy) => {
    if (rot === 90) return { x: box.x + box.width - vy, y: box.y + vx }
    if (rot === 180) return { x: box.x + box.width - vx, y: box.y + box.height - vy }
    if (rot === 270) return { x: box.x + vy, y: box.y + box.height - vx }
    return { x: box.x + vx, y: box.y + vy }
  }
  return { map, rotate: degrees(rot), VW }
}

// Fits a seal image into a sizePt box (wider images may use up to 1.6x width), preserving aspect ratio.
function sealDims(page, image, sizePt) {
  const { VW } = pageFrame(page)
  const k = Math.min(Math.min(sizePt * 1.6, VW * 0.3) / image.width, sizePt / image.height)
  return { w: image.width * k, h: image.height * k }
}

// Adds the band, then draws the optional seal and "<tender_id> | Page X of Y" inside it.
function finishPage(page, font, text, seal) {
  const dims = seal ? sealDims(page, seal.image, seal.size) : null
  const extra = FOOTER_BAND + (dims ? dims.h + SEAL_PAD * 2 : 0)
  extendVisualBottom(page, extra)
  const { map, rotate, VW } = visualToPage(page)
  // The band lies wholly outside the original visible area; paint it white so any content that was
  // previously hidden outside the crop box cannot show through.
  const origin = map(0, 0)
  page.drawRectangle({ x: origin.x, y: origin.y, width: VW, height: extra, rotate, color: rgb(1, 1, 1) })
  if (dims) {
    const margin = 24
    const vx = seal.position === 'bottom-left' ? margin : VW - margin - dims.w
    const at = map(vx, FOOTER_BAND + SEAL_PAD)
    page.drawImage(seal.image, { x: at.x, y: at.y, width: dims.w, height: dims.h, rotate })
  }
  const size = 8
  const tw = font.widthOfTextAtSize(text, size)
  const at = map((VW - tw) / 2, (FOOTER_BAND - size) / 2 + 1.5)
  page.drawText(text, { x: at.x, y: at.y, size, font, color: INK, rotate })
}

// Page plan shared by the UI manifest and the generator: cover, optional index, then documents.
export function planPackage(pageCounts, withIndex) {
  let next = withIndex ? 3 : 2
  const ranges = pageCounts.map((n) => {
    const range = { start: next, end: next + n - 1 }
    next += n
    return range
  })
  return { indexPage: withIndex ? 2 : null, ranges, sourcePages: next - (withIndex ? 3 : 2), total: next - 1 }
}

// A label is plain text (Helvetica) or a pre-rendered image { png, width, height } in points.
async function drawLabel(out, page, label, x, y, size, font, color) {
  if (typeof label === 'string') {
    page.drawText(label, { x, y, size, font, color })
    return
  }
  const img = await out.embedPng(label.png)
  // Images are rendered with descender room; sit them on the text baseline.
  page.drawImage(img, { x, y: y - label.height * 0.28, width: label.width, height: label.height })
}

async function drawIndex(out, page, fonts, tender, index, entries) {
  const { regular, bold } = fonts
  const [W, H] = A4
  const M = 56
  let y = H - M
  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: ACCENT })
  page.drawText(safeText(bold, tender.tender_id), { x: M, y: y - 10, size: 10, font: bold, color: ACCENT })
  y -= 44
  await drawLabel(out, page, index.heading, M, y, 20, bold, INK)
  y -= 34
  const colStart = W - M - 70
  const rowH = Math.min(22, (y - 70) / Math.max(1, entries.length + 1))
  const size = Math.min(11, rowH * 0.55)
  page.drawText('#', { x: M, y, size: size - 1, font: bold, color: MUTED })
  await drawLabel(out, page, index.columns.document, M + 26, y, size - 1, bold, MUTED)
  await drawLabel(out, page, index.columns.start, colStart, y, size - 1, bold, MUTED)
  y -= size * 0.7
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: RULE })
  for (let i = 0; i < entries.length; i++) {
    y -= rowH
    const e = entries[i]
    page.drawText(String(i + 1), { x: M, y, size, font: bold, color: INK })
    const label = index.labels[i]
    if (typeof label === 'string') {
      const line = wrap(regular, safeText(regular, label), size, colStart - M - 40)[0]
      page.drawText(line, { x: M + 26, y, size, font: regular, color: INK })
    } else {
      await drawLabel(out, page, label, M + 26, y, size, regular, INK)
    }
    page.drawText(String(e.start), { x: colStart, y, size, font: bold, color: INK })
  }
}

export function isPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytes.length > 8 && sig.every((b, i) => bytes[i] === b)
}

// Parses "1, 3-5" into sorted unique page numbers; returns null when any part is invalid or out of range.
export function parsePageList(text, max) {
  const out = new Set()
  for (const part of String(text).split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a || b > max) return null
    for (let n = a; n <= b; n++) out.add(n)
  }
  return [...out].sort((x, y) => x - y)
}

export const SEAL_SIZES = { s: 48, m: 60, l: 72 }

// documents: [{ title, fileName, bytes }] already in final order.
// options.seal: null, or { png, pages: [final page numbers], position, size }.
// options.index: null, or { heading, columns: { document, start }, labels[] } (labels are text or images).
export async function buildPackage(tender, documents, options = {}) {
  const out = await PDFDocument.create()
  const regular = await out.embedFont(StandardFonts.Helvetica)
  const bold = await out.embedFont(StandardFonts.HelveticaBold)
  out.setTitle(`${tender.tender_id} Submission Package`)
  out.setProducer('Tender Document Package Builder')

  const withIndex = !!options.index
  const cover = out.addPage(A4)
  const indexPage = withIndex ? out.addPage(A4) : null
  const sources = []
  for (const doc of documents) {
    const src = await PDFDocument.load(doc.bytes, { updateMetadata: false })
    const copied = await out.copyPages(src, src.getPageIndices())
    copied.forEach((p) => out.addPage(p))
    sources.push(copied.length)
  }
  const plan = planPackage(sources, withIndex)
  const entries = documents.map((doc, i) => ({ title: doc.title, fileName: doc.fileName, ...plan.ranges[i] }))

  const generatedOn = todayIso()
  drawCover(cover, { regular, bold }, tender, entries, generatedOn)
  if (indexPage) await drawIndex(out, indexPage, { regular, bold }, tender, options.index, entries)

  const pages = out.getPages()
  const total = pages.length
  const id = safeText(regular, tender.tender_id)
  const sealPages = new Set(options.seal ? options.seal.pages : [])
  const seal = sealPages.size
    ? { image: await out.embedPng(options.seal.png), size: SEAL_SIZES[options.seal.size] || SEAL_SIZES.m, position: options.seal.position }
    : null
  pages.forEach((page, i) => finishPage(page, regular, `${id} | Page ${i + 1} of ${total}`, seal && sealPages.has(i + 1) ? seal : null))

  const bytes = await out.save()
  return { bytes, total, entries, generatedOn }
}

export function packageFileName(tenderId) {
  // eslint-disable-next-line no-control-regex
  const safe = String(tenderId).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'Tender'
  return `${safe}_Package.pdf`
}
