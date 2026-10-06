// Browser test: start `npm run dev`, then `node tests/e2e.cjs [url] [shots]` (needs Playwright).
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const FX = path.join(ROOT, 'tests/fixtures')
const URL = process.argv[2] || 'http://localhost:5173/'
const shots = process.argv[3] === 'shots'
;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2300 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(URL)
  const check = (cond, msg) => { if (!cond) { console.log('FAIL:', msg); process.exitCode = 1 } else console.log('ok -', msg) }

  await page.setInputFiles('#json-input', path.join(FX, 'malformed.json'))
  check(await page.getByRole('alert').filter({ hasText: 'not valid JSON' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'malformed JSON error')
  await page.setInputFiles('#json-input', path.join(FX, 'requirements.json'))
  check((await page.textContent('.tender-title')) === 'Supply of IT Equipment', 'tender loaded')
  check((await page.locator('.req-row:not(.req-header)').count()) === 10, '10 requirement rows')
  check((await page.textContent('.readiness strong')).includes('8 blocking'), '8 blocking initially')
  check(await page.locator('#step-generate button.btn-primary').isDisabled(), 'generate disabled')

  const pdfs = fs.readdirSync(FX).filter((f) => f.endsWith('.pdf') && f !== 'rotated_landscape.pdf').map((f) => path.join(FX, f))
  await page.setInputFiles('#pdf-input', [...pdfs, path.join(FX, 'company_logo.png')])
  await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 10)
  const rejectText = await page.textContent('.reject-list')
  check(rejectText.includes('company_logo.png') && rejectText.includes('Not a PDF'), 'png rejected')
  check(rejectText.includes('broken.pdf') && rejectText.includes('damaged'), 'broken pdf rejected')
  check((await page.locator('.file-row.is-dup').count()) === 2, 'two duplicates marked')

  await page.getByRole('button', { name: /Accept \d+ suggestion/ }).click()
  await page.selectOption('#rm-R01', { label: 'trade_license_2025.pdf' })
  await page.fill('#ex-R01', '2025-06-30')
  check((await page.textContent('#req-R01 .badge')) === 'Expired', 'expired trade license')
  if (shots) { await page.evaluate(() => window.scrollTo(0, document.querySelector('#step-match').offsetTop - 140)); await page.waitForTimeout(300); await page.screenshot({ path: path.join(ROOT, 'screenshots/statuses-blocking.png') }) }
  await page.fill('#ex-R01', '2026-10-20')
  check((await page.textContent('#req-R01 .badge')) === 'OK', 'expiry equal to deadline is OK')
  await page.selectOption('#rm-R01', { label: 'trade_license_2026.pdf' })
  check((await page.textContent('#req-R01 .badge')) === 'Expiry date needed', 'new file needs expiry')
  await page.fill('#ex-R01', '2027-06-30')
  await page.fill('#ex-R04', '2026-12-31')
  await page.selectOption('#rm-R10', { label: 'scan_0042.pdf' })

  // duplicate guard
  const r05 = await page.inputValue('#rm-R05')
  const dupOpt = page.locator('#rm-R06 option', { hasText: 'experience_cert' })
  const disabled = await dupOpt.evaluateAll((os) => os.map((o) => o.disabled))
  check(r05 && disabled.filter(Boolean).length === 1, 'duplicate copies disabled for other requirement')

  if (shots) { await page.locator('#step-match').scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollTo(0, document.querySelector('#step-upload').offsetTop + 300)); await page.screenshot({ path: path.join(ROOT, 'screenshots/statuses-en.png') }) }
  check((await page.textContent('.readiness strong')) === 'Ready to generate', 'ready')
  // undo + redo a match
  await page.getByRole('button', { name: 'Clear match for TIN Certificate' }).click()
  check((await page.textContent('#req-R02 .badge')) === 'Missing', 'undo match -> Missing')
  await page.selectOption('#rm-R02', { label: '03_tin_certificate.pdf' })

  await page.locator('#step-generate button.btn-primary').click()
  const link = page.getByRole('link', { name: /Download T-2026-0417_Package.pdf/ })
  await link.waitFor()
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()])
  check(dl.suggestedFilename() === 'T-2026-0417_Package.pdf', 'download filename')
  const out = '/tmp/e2e-package.pdf'
  await dl.saveAs(out)
  console.log('downloaded', fs.statSync(out).size, 'bytes')
  if (shots) await page.screenshot({ path: path.join(ROOT, 'screenshots/generated-en.png'), fullPage: false })

  await page.getByRole('button', { name: 'বাংলা' }).click()
  check((await page.textContent('#req-R01 .req-title')) === 'ট্রেড লাইসেন্স', 'bangla titles')
  check((await page.textContent('.readiness strong')).includes('প্রস্তুত'), 'bangla readiness')
  if (shots) await page.screenshot({ path: path.join(ROOT, 'screenshots/statuses-bn.png'), fullPage: false })

  // remove matched file -> status recalculates
  await page.getByRole('button', { name: 'scan_0042.pdf সরান' }).click()
  check((await page.textContent('#req-R10 .badge')) === 'অনুপস্থিত', 'removing matched file -> Missing')
  await page.getByRole('button', { name: 'English' }).click()

  await page.setViewportSize({ width: 375, height: 800 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  check(!overflow, 'no horizontal overflow at 375px')
  if (shots) await page.screenshot({ path: path.join(ROOT, 'screenshots/mobile.png'), fullPage: true })
  check(errors.length === 0, 'no console errors ' + JSON.stringify(errors))
  await browser.close()
})()
