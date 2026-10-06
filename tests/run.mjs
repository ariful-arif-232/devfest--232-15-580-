// Run: node tests/make-fixtures.mjs && node tests/run.mjs
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseRequirements } from '../src/lib/requirements.js'
import { evaluate, requirementStatus, STATUS } from '../src/lib/status.js'
import { inspectPdf, buildPackage, packageFileName } from '../src/lib/pdf.js'
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

console.log(`\n${passed} tests passed`)
