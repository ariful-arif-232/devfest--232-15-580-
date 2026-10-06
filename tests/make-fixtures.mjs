// Generates a synthetic test pack (mirrors the shape of the official sample) into tests/fixtures.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'

const dir = new URL('./fixtures/', import.meta.url)
mkdirSync(dir, { recursive: true })

async function makePdf(name, label, pages, opts = {}) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage(opts.landscape ? [842, 595] : [595, 842])
    if (opts.rotate) page.setRotation({ type: 'degrees', angle: opts.rotate })
    page.drawText(`${label}`, { x: 60, y: page.getHeight() - 80, size: 22, font })
    page.drawText(`Source page ${i} of ${pages}`, { x: 60, y: page.getHeight() - 120, size: 14, font, color: rgb(0.3, 0.3, 0.3) })
    if (opts.expiry) page.drawText(`Valid until: ${opts.expiry}`, { x: 60, y: page.getHeight() - 150, size: 14, font })
  }
  writeFileSync(new URL(name, dir), await doc.save())
}

await makePdf('01_financial_proposal.pdf', 'Financial Proposal', 3)
await makePdf('02_technical_proposal.pdf', 'Technical Proposal', 4)
await makePdf('03_tin_certificate.pdf', 'TIN Certificate', 1)
await makePdf('04_vat_certificate.pdf', 'VAT Registration Certificate', 1)
await makePdf('trade_license_2025.pdf', 'Trade License 2025', 1, { expiry: '2025-06-30' })
await makePdf('trade_license_2026.pdf', 'Trade License 2026', 1, { expiry: '2027-06-30' })
await makePdf('bank_solvency.pdf', 'Bank Solvency Certificate', 1, { expiry: '2026-12-31' })
await makePdf('experience_cert.pdf', 'Experience Certificate', 2)
copyFileSync(new URL('experience_cert.pdf', dir), new URL('experience_cert (1).pdf', dir))
await makePdf('scan_0042.pdf', 'Declaration (signed)', 2)
await makePdf('rotated_landscape.pdf', 'Rotated page test', 2, { landscape: true, rotate: 90 })
writeFileSync(new URL('company_logo.png', dir), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
writeFileSync(new URL('broken.pdf', dir), '%PDF-1.7\n this is not really a pdf')
writeFileSync(new URL('malformed.json', dir), '{ "tender": { "tender_id": "X" ')

const requirements = {
  tender: {
    tender_id: 'T-2026-0417',
    title: 'Supply of IT Equipment',
    procuring_entity: 'Directorate of Sample Services',
    bidder: 'Meghna Tech Solutions Ltd.',
    submission_deadline: '2026-10-20',
  },
  requirements: [
    { id: 'R01', order: 1, title_en: 'Trade License', title_bn: 'ট্রেড লাইসেন্স', mandatory: true, has_expiry: true },
    { id: 'R02', order: 2, title_en: 'TIN Certificate', title_bn: 'টিআইএন সনদ', mandatory: true, has_expiry: false },
    { id: 'R03', order: 3, title_en: 'VAT Registration Certificate', title_bn: 'ভ্যাট নিবন্ধন সনদ', mandatory: true, has_expiry: false },
    { id: 'R04', order: 4, title_en: 'Bank Solvency Certificate', title_bn: 'ব্যাংক সচ্ছলতা সনদ', mandatory: true, has_expiry: true },
    { id: 'R05', order: 5, title_en: 'Experience Certificate', title_bn: 'অভিজ্ঞতা সনদ', mandatory: true, has_expiry: false },
    { id: 'R06', order: 6, title_en: 'Audited Financial Statement', title_bn: 'নিরীক্ষিত আর্থিক বিবরণী', mandatory: false, has_expiry: false },
    { id: 'R07', order: 7, title_en: "Manufacturer's Authorization", title_bn: 'প্রস্তুতকারকের অনুমোদনপত্র', mandatory: false, has_expiry: false },
    { id: 'R08', order: 8, title_en: 'Technical Proposal', title_bn: 'কারিগরি প্রস্তাব', mandatory: true, has_expiry: false },
    { id: 'R09', order: 9, title_en: 'Financial Proposal', title_bn: 'আর্থিক প্রস্তাব', mandatory: true, has_expiry: false },
    { id: 'R10', order: 10, title_en: 'Signed Declaration', title_bn: 'স্বাক্ষরিত ঘোষণাপত্র', mandatory: true, has_expiry: false },
  ],
}
writeFileSync(new URL('requirements.json', dir), JSON.stringify(requirements, null, 2))

// A different tender: shuffled, non-contiguous order values and other ids.
const other = {
  tender: { tender_id: 'LGED/2027/Q-88', title: 'Road Maintenance Works', procuring_entity: 'Upazila Engineer Office', bidder: 'Padma Builders', submission_deadline: '2027-01-15' },
  requirements: [
    { id: 'doc-z', order: 30, title_en: 'Work Plan', title_bn: 'কর্মপরিকল্পনা', mandatory: true, has_expiry: false },
    { id: 'doc-a', order: 2, title_en: 'Insurance Certificate', title_bn: 'বীমা সনদ', mandatory: true, has_expiry: true },
    { id: 'doc-m', order: 10, title_en: 'Equipment List', title_bn: 'যন্ত্রপাতির তালিকা', mandatory: false, has_expiry: false },
  ],
}
writeFileSync(new URL('requirements_other.json', dir), JSON.stringify(other, null, 2))
console.log('fixtures written')
