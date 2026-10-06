// Run: node tests/make-fixtures.mjs && node tests/run.mjs
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseRequirements } from '../src/lib/requirements.js'
import { evaluate, requirementStatus, STATUS } from '../src/lib/status.js'
import { inspectPdf, buildPackage, packageFileName, planPackage, parsePageList, isPng } from '../src/lib/pdf.js'
import { deflateSync } from 'node:zlib'
import { suggestMatches } from '../src/lib/suggest.js'

const fx = (n) => new URL(`./fixtures/${n}`, import.meta.url)
const fileOf = (n) => new File([readFileSync(fx(n))], n, { type: n.endsWith('.pdf') ? 'application/pdf' : '' })
let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name) }

await test('parse sorts by numeric order and validates', () => {
  const { tender, requirements } = parseRequirements(readFileSync(fx('requirements_other.json'), 'utf8'))
  assert.equal(tender.tender_id, 'LGED/2027/Q-88')
  assert.deepEqual(requirements.map((r) => r.id), ['doc-a', 'doc-m', 'doc-z'])
  const shuffled = JSON.parse(readFileSync(fx('requirements.json'), 'utf8'))
  shuffled.requirements.reverse()
  assert.equal(parseRequirements(JSON.stringify(shuffled)).requirements[0].id, 'R01')
})

await test('malformed JSON gives keyed errors', () => {
  const bad = ['{', '[]', '{"requirements":[]}', '{"tender":{"tender_id":"A","submission_deadline":"2026-02-30"},"requirements":[{"id":"x","order":1,"title_en":"t","mandatory":true}]}',
    '{"tender":{"tender_id":"A","submission_deadline":"2026-02-01"},"requirements":[{"id":"x","order":"one","title_en":"t","mandatory":true}]}',
    '{"tender":{"tender_id":"A","submission_deadline":"2026-02-01"},"requirements":[{"id":"x","order":1,"title_en":"t"}]}']
  for (const text of bad) assert.throws(() => parseRequirements(text), (e) => typeof e.key === 'string')
})

await test('status rules incl. expiry boundaries', () => {
  const D = '2026-10-20'
  const mand = { mandatory: true, has_expiry: false }
  const opt = { mandatory: false, has_expiry: false }
  const exp = { mandatory: true, has_expiry: true }
  assert.equal(requirementStatus(mand, null, '', D), STATUS.MISSING)
  assert.equal(requirementStatus(opt, null, '', D), STATUS.NOT_PROVIDED)
  assert.equal(requirementStatus(mand, 'f', '', D), STATUS.OK)
  assert.equal(requirementStatus(exp, 'f', '', D), STATUS.EXPIRY_NEEDED)
  assert.equal(requirementStatus(exp, 'f', '2026-10-19', D), STATUS.EXPIRED)
  assert.equal(requirementStatus(exp, 'f', '2026-10-20', D), STATUS.OK)
  assert.equal(requirementStatus(exp, 'f', '2026-10-21', D), STATUS.OK)
  assert.equal(requirementStatus({ mandatory: false, has_expiry: true }, null, '', D), STATUS.NOT_PROVIDED)
  assert.equal(requirementStatus({ mandatory: false, has_expiry: true }, 'f', '', D), STATUS.EXPIRY_NEEDED)
})

const names = ['01_financial_proposal.pdf', '02_technical_proposal.pdf', '03_tin_certificate.pdf', '04_vat_certificate.pdf', 'trade_license_2025.pdf',
  'trade_license_2026.pdf', 'bank_solvency.pdf', 'experience_cert.pdf', 'experience_cert (1).pdf', 'scan_0042.pdf']
const files = []
await test('inspect PDFs, hashes detect duplicates, bad files rejected', async () => {
  for (const n of names) files.push({ id: n, name: n, ...(await inspectPdf(fileOf(n))) })
  const h = Object.fromEntries(files.map((f) => [f.name, f.hash]))
  assert.equal(h['experience_cert.pdf'], h['experience_cert (1).pdf'])
  assert.notEqual(h['trade_license_2025.pdf'], h['trade_license_2026.pdf'])
  assert.equal(files.find((f) => f.name === '02_technical_proposal.pdf').pages, 4)
  await assert.rejects(inspectPdf(fileOf('company_logo.png')), (e) => e.key === 'errNotPdf')
  await assert.rejects(inspectPdf(fileOf('broken.pdf')), (e) => e.key === 'errDamaged')
})

const { tender, requirements } = parseRequirements(readFileSync(fx('requirements.json'), 'utf8'))
const matches = { R01: 'trade_license_2026.pdf', R02: '03_tin_certificate.pdf', R03: '04_vat_certificate.pdf', R04: 'bank_solvency.pdf',
  R05: 'experience_cert.pdf', R08: '02_technical_proposal.pdf', R09: '01_financial_proposal.pdf', R10: 'scan_0042.pdf' }

await test('evaluation and readiness', () => {
  let ev = evaluate(requirements, {}, {}, tender.deadlineIso)
  assert.equal(ev.blocking.length, 8)
  ev = evaluate(requirements, matches, {}, tender.deadlineIso)
  assert.deepEqual(ev.blocking.map((r) => r.status), [STATUS.EXPIRY_NEEDED, STATUS.EXPIRY_NEEDED])
  ev = evaluate(requirements, { ...matches, R01: 'trade_license_2025.pdf' }, { 'trade_license_2025.pdf': '2025-06-30', 'bank_solvency.pdf': '2026-12-31' }, tender.deadlineIso)
  assert.deepEqual(ev.blocking.map((r) => r.status), [STATUS.EXPIRED])
  ev = evaluate(requirements, matches, { 'trade_license_2026.pdf': '2027-06-30', 'bank_solvency.pdf': '2026-12-31' }, tender.deadlineIso)
  assert.ok(ev.ready)
  assert.equal(ev.rows.find((r) => r.req.id === 'R06').status, STATUS.NOT_PROVIDED)
})

await test('suggestions are advisory and skip ambiguous ties', () => {
  const s = suggestMatches(requirements, files, {})
  assert.equal(s.R02, '03_tin_certificate.pdf')
  assert.equal(s.R09, '01_financial_proposal.pdf')
  assert.equal(s.R01, undefined) // two trade licenses with different content
  assert.ok(['experience_cert.pdf', 'experience_cert (1).pdf'].includes(s.R05))
  assert.equal(new Set(Object.values(s)).size, Object.values(s).length)
})

await test('package: order, page count, footer on every page', async () => {
  const byName = Object.fromEntries(files.map((f) => [f.name, f]))
  const docs = requirements.filter((r) => matches[r.id]).map((r) => ({ title: r.title_en, fileName: matches[r.id], bytes: byName[matches[r.id]].bytes }))
  const out = await buildPackage(tender, docs)
  assert.equal(out.total, 16)
  assert.equal(packageFileName(tender.tender_id), 'T-2026-0417_Package.pdf')
  // Written to the OS temp dir so tests never touch the official output/ package.
  const path = join(tmpdir(), 'tpb-test-package.pdf')
  writeFileSync(path, out.bytes)
  const text = execFileSync('pdftotext', ['-layout', path, '-']).toString()
  const pages = text.split('\f').filter((p, i, a) => i < a.length - 1 || p.trim())
  assert.equal(pages.length, 16)
  pages.forEach((p, i) => assert.ok(p.includes(`T-2026-0417 | Page ${i + 1} of 16`), `footer page ${i + 1}`))
  assert.ok(pages[0].includes('Meghna Tech Solutions Ltd.') && pages[0].includes('2026-10-20') && pages[0].includes('Included Documents'))
  const expectOrder = ['Trade License 2026', 'TIN Certificate', 'VAT Registration', 'Bank Solvency', 'Experience Certificate', 'Experience Certificate',
    'Technical Proposal', 'Technical Proposal', 'Technical Proposal', 'Technical Proposal', 'Financial Proposal', 'Financial Proposal', 'Financial Proposal', 'Declaration', 'Declaration']
  expectOrder.forEach((label, i) => assert.ok(pages[i + 1].includes(label), `page ${i + 2} should be ${label}`))
  assert.ok(pages[7].includes('Source page 1 of 4') && pages[10].includes('Source page 4 of 4'))
  assert.ok(!text.includes('Audited Financial'))
})

await test('rotated pages and odd tender ids still get footers', async () => {
  const rot = await inspectPdf(fileOf('rotated_landscape.pdf'))
  const t2 = { ...tender, tender_id: 'LGED/2027/Q-88', title: 'Bangla বাংলা title “quoted”' }
  const out = await buildPackage(t2, [{ title: 'A very long document title '.repeat(8), fileName: 'x'.repeat(200) + '.pdf', bytes: rot.bytes }])
  assert.equal(out.total, 3)
  const tmp = join(tmpdir(), 'tpb-rot-test.pdf')
  writeFileSync(tmp, out.bytes)
  const text = execFileSync('pdftotext', [tmp, '-']).toString()
  for (let i = 1; i <= 3; i++) assert.ok(text.includes(`LGED/2027/Q-88 | Page ${i} of 3`))
  assert.equal(packageFileName('LGED/2027/Q-88'), 'LGED_2027_Q-88_Package.pdf')
})

await test('page plan and index page numbering', async () => {
  assert.deepEqual(planPackage([1, 1, 4], false), { indexPage: null, ranges: [{ start: 2, end: 2 }, { start: 3, end: 3 }, { start: 4, end: 7 }], sourcePages: 6, total: 7 })
  assert.deepEqual(planPackage([2, 3], true).ranges, [{ start: 3, end: 4 }, { start: 5, end: 7 }])
  assert.equal(planPackage([], true).total, 2)
  const byName = Object.fromEntries(files.map((f) => [f.name, f]))
  const docs = requirements.filter((r) => matches[r.id]).map((r) => ({ title: r.title_en, fileName: matches[r.id], bytes: byName[matches[r.id]].bytes }))
  const index = { heading: 'Index', columns: { document: 'Document', start: 'Starts at' }, labels: docs.map((d) => d.title) }
  const out = await buildPackage(tender, docs, { index })
  assert.equal(out.total, 17)
  const path = join(tmpdir(), 'tpb-index-test.pdf')
  writeFileSync(path, out.bytes)
  const pages = execFileSync('pdftotext', ['-layout', path, '-']).toString().split('\f')
  pages.slice(0, 17).forEach((p, i) => assert.ok(p.includes(`T-2026-0417 | Page ${i + 1} of 17`), `footer ${i + 1}`))
  const idx = pages[1]
  assert.ok(idx.includes('Index') && idx.includes('Starts at'))
  const expectStarts = [['Trade License', 3], ['TIN Certificate', 4], ['VAT Registration Certificate', 5], ['Bank Solvency Certificate', 6], ['Experience Certificate', 7], ['Technical Proposal', 9], ['Financial Proposal', 13], ['Signed Declaration', 16]]
  for (const [title, start] of expectStarts) assert.match(idx, new RegExp(`${title}\\s+${start}\\s*$`, 'm'), title)
  assert.ok(pages[2].includes('Trade License 2026') && pages[8].includes('Technical Proposal'))
})

// Minimal solid red RGBA PNG for seal tests.
function redPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([255, 0, 0, 255], y * (w * 4 + 1) + 1 + x * 4)
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

await test('seal: page list parsing and placement on selected pages only', async () => {
  assert.deepEqual(parsePageList('1, 3-4 3', 5), [1, 3, 4])
  assert.equal(parsePageList('0', 5), null)
  assert.equal(parsePageList('2-9', 5), null)
  assert.equal(parsePageList('a', 5), null)
  const png = redPng(40, 20)
  assert.ok(isPng(png) && !isPng(new Uint8Array([1, 2, 3])))
  const rot = await inspectPdf(fileOf('rotated_landscape.pdf'))
  const tin = files.find((f) => f.name === '03_tin_certificate.pdf')
  const out = await buildPackage(tender, [{ title: 'TIN', fileName: 'a.pdf', bytes: tin.bytes }, { title: 'Rot', fileName: 'b.pdf', bytes: rot.bytes }], { seal: { png, pages: [1, 3], position: 'bottom-right', size: 'm' } })
  const path = join(tmpdir(), 'tpb-seal-test.pdf')
  writeFileSync(path, out.bytes)
  const list = execFileSync('pdfimages', ['-list', path]).toString().trim().split('\n').slice(2).map((l) => Number(l.trim().split(/\s+/)[0]))
  assert.deepEqual(list, [1, 3])
  const text = execFileSync('pdftotext', [path, '-']).toString()
  for (let i = 1; i <= 4; i++) assert.ok(text.includes(`T-2026-0417 | Page ${i} of 4`))
  // Rendered: red pixels on page 3 must sit in the visual bottom-right, above the footer strip.
  const ppm = execFileSync('pdftoppm', ['-r', '36', '-f', '3', '-l', '3', '-singlefile', path]) // P6 at 0.5 px/pt
  const header = ppm.toString('latin1', 0, 30).split(/\s+/)
  const W = Number(header[1]); const H = Number(header[2])
  const offset = ppm.indexOf(Buffer.from('255\n')) + 4
  let minX = W, minY = H, maxX = 0, maxY = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = offset + (y * W + x) * 3; if (ppm[i] > 200 && ppm[i + 1] < 60 && ppm[i + 2] < 60) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) } }
  assert.ok(maxX > 0, 'seal rendered')
  assert.ok(minX > W / 2 && maxY > H / 2, `seal in bottom-right (${minX},${minY})-(${maxX},${maxY}) of ${W}x${H}`)
  // Footer box spans 9-22pt from the bottom; the seal must end above 24pt (0.5 px per pt here).
  assert.ok(maxY < H - 0.5 * 24 && maxX < W, 'seal stays above footer and inside page')
})

await test('cover lists every included document even for 30 documents', async () => {
  const tin = files.find((f) => f.name === '03_tin_certificate.pdf')
  const docs = Array.from({ length: 30 }, (_, i) => ({ title: `Requirement number ${i + 1} supporting certificate`, fileName: `document_file_${i + 1}_scan.pdf`, bytes: tin.bytes }))
  const out = await buildPackage(tender, docs)
  const path = join(tmpdir(), 'tpb-many-test.pdf')
  writeFileSync(path, out.bytes)
  const cover = execFileSync('pdftotext', ['-f', '1', '-l', '1', path, '-']).toString()
  for (let i = 1; i <= 30; i++) assert.ok(cover.includes(`Requirement number ${i} supporting`), `cover entry ${i}`)
})

console.log(`\n${passed} tests passed`)
