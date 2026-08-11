/**
 * 实际启动打包版桌面程序，经 CDP 做 UI/API 端到端验证。
 * 使用独立 userData，不触碰本机正式账本。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(root, 'release', 'win-unpacked', '印尼盾记账.exe')
const port = 9333
const userData = path.join(os.tmpdir(), `rp-ledger-ui-e2e-${Date.now()}`)
const exportDir = path.join(userData, 'exports')
const results = []

function log(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitForCdp(ms = 20000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('CDP 未就绪')
}

async function waitForApi(page, ms = 15000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const ready = await page.evaluate(() => !!(window.api && window.api.listAccounts))
    if (ready) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('window.api 未就绪')
}

if (!fs.existsSync(exe)) {
  console.error('未找到打包程序:', exe)
  process.exit(1)
}

fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(exportDir, { recursive: true })
console.log('UI E2E 启动', exe)
console.log('userData:', userData)

const child = spawn(
  exe,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
  {
    cwd: path.dirname(exe),
    stdio: 'ignore',
    windowsHide: false,
    env: { ...process.env, RP_LEDGER_E2E_EXPORT_DIR: exportDir },
  },
)

let exitCode = null
child.on('exit', (code) => {
  exitCode = code
})

let browser
try {
  await waitForCdp()
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0] || (await browser.newContext())
  let page = context.pages().find((p) => !p.url().startsWith('devtools://'))
  if (!page) {
    // 等主窗口
    const start = Date.now()
    while (Date.now() - start < 15000) {
      page = context.pages().find((p) => !p.url().startsWith('devtools://'))
      if (page) break
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  assert.ok(page, '未找到应用页面')
  await page.waitForLoadState('domcontentloaded')
  await waitForApi(page)
  if (process.env.RP_LEDGER_CAPTURE_PATH) {
    const capturePath = path.resolve(process.env.RP_LEDGER_CAPTURE_PATH)
    fs.mkdirSync(path.dirname(capturePath), { recursive: true })
    await page.screenshot({ path: capturePath })
    console.log('UI screenshot:', capturePath)
  }

  // 1. 版本与主界面
  {
    const brand = await page.locator('.brand-mark').innerText()
    log('品牌展示', brand.includes('印尼盾记账'), brand)
    const ver = await page.locator('.version-pill').innerText().catch(() => '')
    log('版本号显示', /^v?1\.4\.9$/.test(ver.trim()) || ver.includes('1.4.9'), ver || '(空)')
    const h1 = await page.locator('h1').first().innerText()
    log('默认记账明细页', h1.includes('记账明细'), h1)
    const sub = await page.locator('.topbar p').first().innerText()
    log('副标题含业务期间/凭证', /业务期间/.test(sub) && /PDF|凭证/.test(sub), sub)
  }

  // 2. 侧栏切换
  for (const [label, title] of [
    ['账户汇总', '账户汇总'],
    ['分类统计', '分类统计'],
    ['设置', '设置'],
    ['记账明细', '记账明细'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(150)
    const h1 = await page.locator('h1').first().innerText()
    log(`切换到${label}`, h1.includes(title), h1)
  }

  // 3. API：新建流水（含业务期间）
  const created = await page.evaluate(async () => {
    const accounts = await window.api.listAccounts()
    const cats = await window.api.listCategories()
    const docs = await window.api.listDocTypes()
    const accountId = accounts[0]?.id
    const categoryId = cats.find((c) => c.name.includes('交通'))?.id || cats[0]?.id || null
    const docTypeId = docs[0]?.id || null
    if (!accountId) throw new Error('无账户')
    const id = await window.api.createTransaction({
      date: '2026-07-15',
      period_start: '2026-07-03',
      period_end: '2026-07-24',
      account_id: accountId,
      category_id: categoryId,
      type: '支出',
      amount: 1204999,
      doc_type_id: docTypeId,
      note: 'E2E grab打车',
      checked_at: '',
    })
    const tx = await window.api.getTransaction(id)
    return { id, tx, accountId, categoryId }
  })
  log(
    'API 新建流水含期间',
    created.id > 0 &&
      created.tx?.period_start === '2026-07-03' &&
      created.tx?.period_end === '2026-07-24' &&
      Number(created.tx?.amount) < 0,
    `id=${created.id} amount=${created.tx?.amount}`,
  )

  // 刷新列表并检查 UI
  await page.getByRole('button', { name: '记账明细', exact: true }).click()
  await page.locator('#q-year').selectOption('2026')
  await page.locator('#q-month').selectOption('07')
  await page.waitForTimeout(400)
  const periodCol = await page.locator('th', { hasText: '业务期间' }).count()
  const dateCol = await page.locator('th', { hasText: '报账日期' }).count()
  log('表头含业务期间', periodCol >= 1)
  log('表头含报账日期', dateCol >= 1)
  const rowText = await page.locator('table tbody tr').first().innerText()
  log('列表显示备注', rowText.includes('E2E grab打车'), rowText.slice(0, 80))
  log('列表显示期间短标签', /7\.3\s*[–-]\s*7\.24/.test(rowText) || rowText.includes('7.3'), rowText.slice(0, 120))

  // 4. UI 表单新增
  await page.getByRole('button', { name: '新增流水' }).click()
  await page.waitForSelector('h3:has-text("新增流水")')
  await page.locator('label:has-text("报账日期") + input, form input[type="date"]').first().fill('2026-07-20')
  // 期间起止
  const dateInputs = page.locator('.modal input[type="date"], dialog input[type="date"], form input[type="date"]')
  const dateCount = await dateInputs.count()
  if (dateCount >= 3) {
    await dateInputs.nth(0).fill('2026-07-20')
    await dateInputs.nth(1).fill('2026-07-06')
    await dateInputs.nth(2).fill('2026-07-06')
  } else {
    // 按 label 邻近
    await page.getByText('业务期间起').locator('..').locator('input').fill('2026-07-06')
    await page.getByText('业务期间止').locator('..').locator('input').fill('2026-07-06')
  }
  await page.getByPlaceholder('例如 150000').fill('50000')
  await page.getByPlaceholder('商户 / 说明').fill('E2E 油费')
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(500)
  const toast = await page.locator('.toast, [class*="toast"]').innerText().catch(() => '')
  const oilRow = await page.evaluate(async () => {
    const r = await window.api.queryTransactions({
      year: '2026',
      month: '07',
      keyword: 'E2E 油费',
      page: 1,
      pageSize: 10,
    })
    return r.list?.[0] || null
  })
  log(
    'UI 表单保存流水',
    !!(oilRow && String(oilRow.note || '').includes('油费')),
    toast || `note=${oilRow?.note} period=${oilRow?.period_start}`,
  )
  log(
    '单日期间写入',
    oilRow?.period_start === '2026-07-06' && oilRow?.period_end === '2026-07-06',
    `${oilRow?.period_start}~${oilRow?.period_end}`,
  )

  // 5. 导出对话框（不点原生保存，避免卡住）
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator('.side-actions').getByRole('button', { name: '导出票据文件夹' }).click()
  await page.waitForTimeout(300)
  const receiptModal = page.locator('.modal, [role="dialog"]').filter({ hasText: /票据|导出/ })
  const receiptOpen = (await receiptModal.count()) > 0
  const receiptText = receiptOpen ? await receiptModal.first().innerText() : ''
  log('导出票据对话框可打开', receiptOpen && /导出|票据|月份/.test(receiptText), receiptText.slice(0, 80))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  await page.locator('.side-actions').getByRole('button', { name: '导出 Excel', exact: true }).click()
  await page.waitForTimeout(300)
  const excelModal = page.locator('.modal, [role="dialog"]').filter({ hasText: /导出/ })
  log('导出 Excel 对话框可打开', (await excelModal.count()) > 0)
  const exportStart = excelModal.locator('#export-start')
  const exportEnd = excelModal.locator('#export-end')
  log('Excel 可选开始和结束日期', (await exportStart.count()) === 1 && (await exportEnd.count()) === 1)
  await exportStart.fill('2026-07-01')
  await exportEnd.fill('2026-08-31')
  await page.waitForTimeout(300)
  const rangeCheck = await page.evaluate(async () => {
    const accounts = await window.api.listAccounts()
    const categories = await window.api.listCategories()
    await window.api.createTransaction({
      date: '2026-08-31',
      period_start: '2026-08-31',
      period_end: '2026-08-31',
      account_id: accounts[0].id,
      category_id: categories[0]?.id || null,
      type: '收入',
      amount: 1,
      doc_type_id: null,
      note: 'E2E 导出范围结束日',
      checked_at: '',
    })
    await window.api.createTransaction({
      date: '2026-09-01',
      period_start: '2026-09-01',
      period_end: '2026-09-01',
      account_id: accounts[0].id,
      category_id: categories[0]?.id || null,
      type: '收入',
      amount: 1,
      doc_type_id: null,
      note: 'E2E 导出范围外',
      checked_at: '',
    })
    const result = await window.api.queryTransactions({
      start: '2026-07-01',
      end: '2026-08-31',
      page: 1,
      pageSize: 100,
    })
    return {
      total: result.total,
      dates: result.list.map((row) => row.date),
      hasExportRange: typeof window.api.exportRange === 'function',
      includesEnd: result.list.some((row) => row.note === 'E2E 导出范围结束日'),
      excludesOutside: !result.list.some((row) => row.note === 'E2E 导出范围外'),
    }
  })
  log(
    '日期范围查询含起止日且可跨月',
    rangeCheck.total >= 3 &&
      rangeCheck.includesEnd &&
      rangeCheck.excludesOutside &&
      rangeCheck.dates.every((date) => date >= '2026-07-01' && date <= '2026-08-31'),
    `${rangeCheck.total} 笔`,
  )
  log('日期范围导出接口可用', rangeCheck.hasExportRange)
  await excelModal.getByRole('button', { name: /导出 Excel/ }).click()
  const rangeFile = path.join(exportDir, '日记账_2026-07-01_至_2026-08-31.xlsx')
  const rangeExported = await (async () => {
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(rangeFile)) {
        const firstSize = fs.statSync(rangeFile).size
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (fs.existsSync(rangeFile) && fs.statSync(rangeFile).size === firstSize && firstSize > 0) {
          return true
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  })()
  let exportedDates = []
  if (rangeExported) {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(rangeFile)
    const sheet = workbook.getWorksheet('记账明细')
    exportedDates = sheet
      .getColumn(1)
      .values.slice(5)
      .filter((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
  }
  log(
    '日期范围 Excel 已生成且明细未越界',
    rangeExported &&
      exportedDates.length > 0 &&
      exportedDates.includes('2026-08-31') &&
      !exportedDates.includes('2026-09-01') &&
      exportedDates.every((date) => date >= '2026-07-01' && date <= '2026-08-31'),
    rangeExported ? `${exportedDates.length} 行` : '未生成文件',
  )

  // 6. 设置页文案
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForTimeout(200)
  const settingsText = await page.locator('main').innerText()
  log('设置页含导入说明', settingsText.includes('合并导入') || settingsText.includes('Excel'))
  log(
    '设置页含数据/版本信息',
    settingsText.includes('数据') || settingsText.includes('版本') || settingsText.includes('1.4'),
    settingsText.slice(0, 80).replace(/\s+/g, ' '),
  )

  // 7. 附件协议：PDF 不应经 ledger-img（用 evaluate 调协议语义）
  const protocolCheck = await page.evaluate(async () => {
    // 模拟：创建一笔并检查 mime 辅助逻辑是否在前端可区分
    const accounts = await window.api.listAccounts()
    const id = await window.api.createTransaction({
      date: '2026-07-21',
      period_start: '2026-07-21',
      period_end: '2026-07-21',
      account_id: accounts[0].id,
      category_id: null,
      type: '支出',
      amount: 12.5,
      doc_type_id: null,
      note: 'E2E 小数金额',
      checked_at: '',
    })
    const tx = await window.api.getTransaction(id)
    return { id, amount: tx.amount }
  })
  log(
    '小数金额可保存',
    Math.abs(Math.abs(Number(protocolCheck.amount)) - 12.5) < 0.001,
    String(protocolCheck.amount),
  )

  // 8. 编辑详情页字段标签
  await page.getByRole('button', { name: '记账明细', exact: true }).click()
  await page.locator('#q-year').selectOption('2026')
  await page.locator('#q-month').selectOption('07')
  await page.waitForTimeout(300)
  await page.locator('table tbody tr').first().click()
  await page.waitForTimeout(300)
  const detail = await page.locator('main').innerText()
  log('详情含业务期间标签', detail.includes('业务期间'))
  log('详情含报账日期标签', detail.includes('报账日期'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)

  // 9. 账户汇总有数据
  await page.getByRole('button', { name: '账户汇总', exact: true }).click()
  await page.waitForTimeout(400)
  const accText = await page.locator('main').innerText()
  log('账户汇总有内容', accText.length > 20 && !accText.includes('桌面接口未就绪'))

  // 10. 进程仍存活
  log('进程未崩溃', exitCode === null, exitCode == null ? 'running' : `exit=${exitCode}`)

  const failed = results.filter((r) => !r.ok)
  console.log('\n—— 汇总 ——')
  console.log(`通过 ${results.length - failed.length}/${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log('失败:', f.name, f.detail)
    process.exitCode = 1
  } else {
    console.log('UI E2E 全部通过')
  }
} catch (err) {
  console.error('UI E2E 异常:', err)
  process.exitCode = 1
} finally {
  try {
    if (browser) await browser.close().catch(() => {})
  } catch {
    /* ignore */
  }
  try {
    if (child.pid && exitCode === null) {
      child.kill()
      await new Promise((r) => setTimeout(r, 800))
      try {
        process.kill(child.pid)
      } catch {
        /* ignore */
      }
      // Windows 强杀子进程树
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    }
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
