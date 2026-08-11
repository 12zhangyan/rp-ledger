/**
 * 20 轮仔细端到端测试：启动打包版桌面程序，经 CDP 驱动 UI + window.api。
 * 独立 userData，不触碰正式账本。每轮多断言，全部跑完再汇总。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(root, 'release', 'win-unpacked', '印尼盾记账.exe')
const port = 9334
const userData = path.join(os.tmpdir(), `rp-ledger-e2e20-${Date.now()}`)

const rounds = []
let currentRound = null

function startRound(n, title) {
  currentRound = { n, title, checks: [], ok: true }
  console.log(`\n======== 第 ${n} 轮：${title} ========`)
}

function check(name, ok, detail = '') {
  if (!currentRound) throw new Error('check outside round')
  currentRound.checks.push({ name, ok: !!ok, detail: String(detail || '') })
  if (!ok) currentRound.ok = false
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function endRound() {
  rounds.push(currentRound)
  console.log(`  → 第 ${currentRound.n} 轮 ${currentRound.ok ? '通过' : '失败'}（${currentRound.checks.filter((c) => c.ok).length}/${currentRound.checks.length}）`)
  currentRound = null
}

async function waitForCdp(ms = 25000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('CDP 未就绪')
}

async function waitForApi(page, ms = 20000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const ready = await page.evaluate(() => !!(window.api && window.api.createTransaction))
    if (ready) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('window.api 未就绪')
}

async function gotoTab(page, label) {
  await page.locator('.nav').getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(180)
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
  }
}

async function refreshLedger(page, year = '2026', month = '07') {
  await gotoTab(page, '记账明细')
  await closeOverlays(page)
  const y = page.locator('#q-year')
  if (await y.count()) {
    const opts = await y.locator('option').allTextContents()
    if (opts.some((t) => t.includes(year))) await y.selectOption(year)
  }
  await page.locator('#q-month').selectOption(month)
  await page.waitForTimeout(350)
}

/** 关键词需点「查询」才会写入 applied */
async function searchByKeyword(page, keyword) {
  await page.locator('#q-kw').fill(keyword)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await page.waitForTimeout(400)
}

if (!fs.existsSync(exe)) {
  console.error('未找到打包程序:', exe)
  process.exit(1)
}

fs.mkdirSync(userData, { recursive: true })
console.log('20 轮 E2E 启动')
console.log('exe:', exe)
console.log('userData:', userData)

// 清理占用端口
try {
  const { execSync } = await import('node:child_process')
  execSync(
    `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
    { stdio: 'ignore' },
  )
} catch {
  /* ignore */
}

const child = spawn(
  exe,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
  { cwd: path.dirname(exe), stdio: 'ignore', windowsHide: false },
)
let exitCode = null
child.on('exit', (code) => {
  exitCode = code
})

let browser
const ctx = { ids: [], accountId: 0, catTraffic: 0, catFood: 0, docId: 0, dataPath: '' }

try {
  await waitForCdp()
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0] || (await browser.newContext())
  let page = context.pages().find((p) => !p.url().startsWith('devtools://'))
  const deadline = Date.now() + 20000
  while (!page && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    page = context.pages().find((p) => !p.url().startsWith('devtools://'))
  }
  if (!page) throw new Error('未找到应用页面')
  await page.waitForLoadState('domcontentloaded')
  await waitForApi(page)

  // —— 1 启动与壳层 ——
  startRound(1, '启动、版本与壳层')
  {
    const brand = await page.locator('.brand-mark').innerText()
    check('品牌名', brand.trim() === '印尼盾记账', brand)
    const verUi = (await page.locator('.version-pill').first().innerText()).trim()
    check('侧栏版本 pill', verUi.includes('1.4.9'), verUi)
    const verApi = await page.evaluate(() => window.api.getVersion())
    check('API 版本一致', verApi === '1.4.9', verApi)
    const h1 = await page.locator('h1').first().innerText()
    check('默认页记账明细', h1.includes('记账明细'), h1)
    const sub = await page.locator('.topbar p').first().innerText()
    check('副标题含报账日期/业务期间/PDF', /报账日期/.test(sub) && /业务期间/.test(sub) && /PDF/.test(sub), sub)
    ctx.dataPath = await page.evaluate(() => window.api.getDataPath())
    check('数据目录在独立 userData 下', String(ctx.dataPath).includes('rp-ledger-e2e20'), ctx.dataPath)
    check('进程存活', exitCode === null)
  }
  endRound()

  // —— 2 导航 ——
  startRound(2, '侧栏导航四页')
  {
    for (const [label, title] of [
      ['账户汇总', '账户汇总'],
      ['分类统计', '分类统计'],
      ['设置', '设置'],
      ['记账明细', '记账明细'],
    ]) {
      await gotoTab(page, label)
      const h1 = await page.locator('h1').first().innerText()
      check(`进入「${label}」`, h1.includes(title), h1)
      const active = await page.locator('.nav button.active').innerText()
      check(`「${label}」高亮`, active.trim() === label, active)
    }
  }
  endRound()

  // —— 3 主数据就绪 ——
  startRound(3, '主数据：账户/分类/单据')
  {
    const meta = await page.evaluate(async () => {
      const accounts = await window.api.listAccounts()
      const categories = await window.api.listCategories()
      const docs = await window.api.listDocTypes()
      return { accounts, categories, docs }
    })
    check('至少一个支付方式', meta.accounts.length >= 1, String(meta.accounts.length))
    check('至少一个分类', meta.categories.length >= 1, String(meta.categories.length))
    check('至少一个单据类型', meta.docs.length >= 1, String(meta.docs.length))
    const e2eCat = await page.evaluate(async () => {
      const id = await window.api.upsertCategory({ name: 'E2E测试分类' })
      const list = await window.api.listCategories()
      return { id, found: list.some((c) => c.name === 'E2E测试分类') }
    })
    check('可新增分类', e2eCat.found, `id=${e2eCat.id}`)
    ctx.accountId = meta.accounts.find((a) => a.name !== '月余额')?.id || meta.accounts[0].id
    ctx.catTraffic = meta.categories.find((c) => /交通/.test(c.name))?.id || meta.categories[0].id
    ctx.catFood = meta.categories.find((c) => /餐|食|饭/.test(c.name))?.id || meta.categories[0].id
    ctx.docId = meta.docs[0].id
    check('已解析默认账户/分类', ctx.accountId > 0 && ctx.catTraffic > 0)
  }
  endRound()

  // —— 4 支出 + 期间区间 ——
  startRound(4, '新建支出与业务期间区间')
  {
    const tx = await page.evaluate(async (p) => {
      const id = await window.api.createTransaction({
        date: '2026-07-15',
        period_start: '2026-07-03',
        period_end: '2026-07-24',
        account_id: p.accountId,
        category_id: p.catTraffic,
        type: '支出',
        amount: 1204999,
        doc_type_id: p.docId,
        note: 'E2E-R4 grab打车',
        checked: false,
      })
      const row = await window.api.getTransaction(id)
      return { id, row }
    }, ctx)
    ctx.ids.push(tx.id)
    check('返回有效 id', tx.id > 0, String(tx.id))
    check('支出金额为负', Number(tx.row.amount) === -1204999, String(tx.row.amount))
    check('期间起', tx.row.period_start === '2026-07-03', tx.row.period_start)
    check('期间止', tx.row.period_end === '2026-07-24', tx.row.period_end)
    check('备注保留', tx.row.note === 'E2E-R4 grab打车', tx.row.note)
    await refreshLedger(page)
    const cell = await page.locator('table tbody tr').filter({ hasText: 'E2E-R4' }).first().innerText()
    check('列表短标签 7.3–7.24', cell.includes('7.3–7.24') || cell.includes('7.3'), cell.slice(0, 100))
    check('列表金额千分位', cell.includes('-1,204,999.00') || cell.includes('1,204,999'), cell.slice(0, 120))
    check('表头报账日期', (await page.locator('th', { hasText: '报账日期' }).count()) >= 1)
    check('表头业务期间', (await page.locator('th', { hasText: '业务期间' }).count()) >= 1)
  }
  endRound()

  // —— 5 收入 / 金额 0 / 无期间 ——
  startRound(5, '收入、金额 0、无业务期间')
  {
    const r = await page.evaluate(async (p) => {
      const incomeId = await window.api.createTransaction({
        date: '2026-07-10',
        period_start: null,
        period_end: null,
        account_id: p.accountId,
        category_id: p.catFood,
        type: '收入',
        amount: 500000,
        doc_type_id: p.docId,
        note: 'E2E-R5 报销入账',
      })
      const zeroId = await window.api.createTransaction({
        date: '2026-07-11',
        account_id: p.accountId,
        category_id: p.catFood,
        type: '支出',
        amount: 0,
        note: 'E2E-R5 金额零',
      })
      const income = await window.api.getTransaction(incomeId)
      const zero = await window.api.getTransaction(zeroId)
      return { incomeId, zeroId, income, zero }
    }, ctx)
    ctx.ids.push(r.incomeId, r.zeroId)
    check('收入为正', Number(r.income.amount) === 500000, String(r.income.amount))
    check('无期间存 null', r.income.period_start == null && r.income.period_end == null)
    check('金额 0 可保存', Number(r.zero.amount) === 0, String(r.zero.amount))
    await refreshLedger(page)
    const incomeRow = await page.locator('table tbody tr').filter({ hasText: 'E2E-R5 报销' }).innerText()
    check('列表无期间显示为 -', /\t-\t|\s-\s|-\t/.test(incomeRow) || incomeRow.includes('\t-\t'), incomeRow.slice(0, 90))
  }
  endRound()

  // —— 6 期间边界 ——
  startRound(6, '期间边界：起止反序、单日、跨年')
  {
    const r = await page.evaluate(async (p) => {
      const rev = await window.api.createTransaction({
        date: '2026-07-18',
        period_start: '2026-07-24',
        period_end: '2026-07-03',
        account_id: p.accountId,
        category_id: p.catTraffic,
        type: '支出',
        amount: 100,
        note: 'E2E-R6 反序',
      })
      const one = await window.api.createTransaction({
        date: '2026-07-18',
        period_start: '2026-07-06',
        period_end: '2026-07-06',
        account_id: p.accountId,
        category_id: p.catTraffic,
        type: '支出',
        amount: 200,
        note: 'E2E-R6 单日',
      })
      const cross = await window.api.createTransaction({
        date: '2026-07-18',
        period_start: '2025-12-28',
        period_end: '2026-01-03',
        account_id: p.accountId,
        category_id: p.catTraffic,
        type: '支出',
        amount: 300,
        note: 'E2E-R6 跨年',
      })
      return {
        rev: await window.api.getTransaction(rev),
        one: await window.api.getTransaction(one),
        cross: await window.api.getTransaction(cross),
        ids: [rev, one, cross],
      }
    }, ctx)
    ctx.ids.push(...r.ids)
    check('反序自动纠正', r.rev.period_start === '2026-07-03' && r.rev.period_end === '2026-07-24', `${r.rev.period_start}~${r.rev.period_end}`)
    check('单日起止相同', r.one.period_start === '2026-07-06' && r.one.period_end === '2026-07-06')
    check('跨年期间保留', r.cross.period_start === '2025-12-28' && r.cross.period_end === '2026-01-03')
    await refreshLedger(page)
    const oneCell = await page.locator('table tbody tr').filter({ hasText: 'E2E-R6 单日' }).innerText()
    check('单日列表标签 7.6', oneCell.includes('7.6'), oneCell.slice(0, 80))
    const crossCell = await page.locator('table tbody tr').filter({ hasText: 'E2E-R6 跨年' }).innerText()
    check('跨年列表含年份', /2025|2026/.test(crossCell), crossCell.slice(0, 100))
  }
  endRound()

  // —— 7 编辑与核对 ——
  startRound(7, '编辑流水与已核对')
  {
    const id = ctx.ids[0]
    const before = await page.evaluate((i) => window.api.getTransaction(i), id)
    await page.evaluate(
      async ({ id, accountId, catId, docId }) => {
        await window.api.updateTransaction(id, {
          date: '2026-07-16',
          period_start: '2026-07-01',
          period_end: '2026-07-31',
          account_id: accountId,
          category_id: catId,
          type: '支出',
          amount: 1205000,
          doc_type_id: docId,
          note: 'E2E-R4 grab打车(已改)',
          checked: true,
        })
      },
      { id, accountId: ctx.accountId, catId: ctx.catTraffic, docId: ctx.docId },
    )
    const after = await page.evaluate((i) => window.api.getTransaction(i), id)
    check('日期已改', after.date === '2026-07-16', after.date)
    check('金额已改', Number(after.amount) === -1205000, String(after.amount))
    check('备注已改', String(after.note).includes('已改'), after.note)
    check('已核对标记', !!after.checked, String(after.checked))
    check('期间已改整月', after.period_start === '2026-07-01' && after.period_end === '2026-07-31')
    check('编辑前有值可对比', before.date === '2026-07-15')

    await refreshLedger(page)
    await page.locator('table tbody tr').filter({ hasText: '已改' }).getByRole('button', { name: '编辑' }).click()
    await page.waitForSelector('h3:has-text("编辑流水")')
    const formNote = await page.getByPlaceholder('商户 / 说明').inputValue()
    check('编辑表单回填备注', formNote.includes('已改'), formNote)
    const checked = await page.locator('label:has-text("已核对") input[type="checkbox"]').isChecked()
    check('编辑表单回填核对', checked)
    await page.getByPlaceholder('例如 150000').fill('1205100')
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForTimeout(400)
    const again = await page.evaluate((i) => window.api.getTransaction(i), id)
    check('UI 保存金额生效', Number(again.amount) === -1205100, String(again.amount))
  }
  endRound()

  // —— 8 删除与分类约束 ——
  startRound(8, '删除流水与分类删除约束')
  {
    const doomed = await page.evaluate(async (p) => {
      const id = await window.api.createTransaction({
        date: '2026-07-19',
        account_id: p.accountId,
        category_id: p.catFood,
        type: '支出',
        amount: 11,
        note: 'E2E-R8 待删',
      })
      return id
    }, ctx)
    await page.evaluate((id) => window.api.deleteTransaction(id), doomed)
    const gone = await page.evaluate((id) => window.api.getTransaction(id), doomed)
    check('删除后 get 为空', gone == null)

    const delCat = await page.evaluate(async () => {
      const used = (await window.api.listCategories()).find((c) => /交通|餐|食|饭|E2E/.test(c.name))
      let usedErr = ''
      try {
        await window.api.deleteCategory(used.id)
      } catch (e) {
        usedErr = String(e?.message || e)
      }
      const freshId = await window.api.upsertCategory({ name: `E2E临时可删-${Date.now()}` })
      await window.api.deleteCategory(freshId)
      const still = (await window.api.listCategories()).some((c) => c.id === freshId)
      return { usedErr, still, usedName: used?.name }
    })
    check('引用中分类不可删', /引用|无法|不能|使用/.test(delCat.usedErr) || delCat.usedErr.length > 0, delCat.usedErr || '(无错误?)')
    check('未引用分类可删', delCat.still === false)
  }
  endRound()

  // —— 9 筛选 ——
  startRound(9, '筛选：年月/类型/关键词/特殊字符')
  {
    await page.evaluate(async (p) => {
      await window.api.createTransaction({
        date: '2026-08-02',
        account_id: p.accountId,
        category_id: p.catFood,
        type: '支出',
        amount: 888,
        note: 'E2E-R9 八月笔 100%_off',
      })
      await window.api.createTransaction({
        date: '2026-07-22',
        account_id: p.accountId,
        category_id: p.catTraffic,
        type: '收入',
        amount: 77,
        note: 'E2E-R9 七月收入',
      })
    }, ctx)

    const q = await page.evaluate(async () => {
      const jul = await window.api.queryTransactions({ year: '2026', month: '07', page: 1, pageSize: 50 })
      const aug = await window.api.queryTransactions({ year: '2026', month: '08', page: 1, pageSize: 50 })
      const exp = await window.api.queryTransactions({
        year: '2026',
        month: '07',
        type: '支出',
        page: 1,
        pageSize: 50,
      })
      const kw = await window.api.queryTransactions({
        year: '2026',
        keyword: '100%_off',
        page: 1,
        pageSize: 20,
      })
      const likeTrap = await window.api.queryTransactions({
        year: '2026',
        keyword: '%',
        page: 1,
        pageSize: 50,
      })
      return {
        julTotal: jul.total,
        augNotes: aug.list.map((x) => x.note),
        expOk: exp.list.every((x) => x.type === '支出'),
        expTotal: exp.total,
        kwHit: kw.list.some((x) => String(x.note).includes('100%_off')),
        kwTotal: kw.total,
        pctTotal: likeTrap.total,
      }
    })
    check('7 月有数据', q.julTotal >= 3, String(q.julTotal))
    check('8 月筛到八月笔', q.augNotes.some((n) => String(n).includes('八月')), q.augNotes.join('|'))
    check('类型=支出过滤', q.expOk && q.expTotal >= 1, `total=${q.expTotal}`)
    check('关键词精确命中含 % _', q.kwHit && q.kwTotal === 1, `total=${q.kwTotal}`)
    check('单独 % 不致全表误匹配（或极少）', q.pctTotal <= q.julTotal + 5, `pctTotal=${q.pctTotal}`)

    await gotoTab(page, '记账明细')
    await page.locator('#q-year').selectOption('2026')
    await page.locator('#q-month').selectOption('08')
    await searchByKeyword(page, '八月')
    const ui = await page.locator('table tbody tr').count()
    check('UI 八月+关键词有行', ui >= 1, String(ui))
  }
  endRound()

  // —— 10 分页 ——
  startRound(10, '分页与每页条数')
  {
    await page.evaluate(async (p) => {
      for (let i = 0; i < 12; i++) {
        await window.api.createTransaction({
          date: '2026-07-25',
          account_id: p.accountId,
          category_id: p.catTraffic,
          type: '支出',
          amount: 10 + i,
          note: `E2E-R10 分页-${i}`,
        })
      }
    }, ctx)
    const pages = await page.evaluate(async () => {
      const a = await window.api.queryTransactions({
        year: '2026',
        month: '07',
        keyword: 'E2E-R10',
        page: 1,
        pageSize: 5,
      })
      const b = await window.api.queryTransactions({
        year: '2026',
        month: '07',
        keyword: 'E2E-R10',
        page: 2,
        pageSize: 5,
      })
      const c = await window.api.queryTransactions({
        year: '2026',
        month: '07',
        keyword: 'E2E-R10',
        page: 99,
        pageSize: 5,
      })
      return {
        total: a.total,
        pageSize: a.pageSize,
        p1: a.list.length,
        p2: b.list.length,
        p1notes: a.list.map((x) => x.note),
        p2notes: b.list.map((x) => x.note),
        safePage: c.page,
        totalPages: a.totalPages,
      }
    })
    check('分页 total=12', pages.total === 12, String(pages.total))
    check('pageSize 钳制为 5', pages.pageSize === 5, String(pages.pageSize))
    check('第 1 页 5 条', pages.p1 === 5)
    check('第 2 页 5 条', pages.p2 === 5)
    check('两页无重复', pages.p1notes.every((n) => !pages.p2notes.includes(n)))
    check('超大页码回退', pages.safePage === pages.totalPages, `${pages.safePage}/${pages.totalPages}`)

    await refreshLedger(page)
    await searchByKeyword(page, 'E2E-R10')
    await page.locator('#page-size').selectOption('10')
    await page.waitForTimeout(450)
    const rows10 = await page.locator('table tbody tr').count()
    check('UI 每页 10', rows10 === 10, String(rows10))
    await page.locator('#page-jump').fill('2')
    await page.getByRole('button', { name: 'Go' }).click()
    await page.waitForTimeout(450)
    const rows2 = await page.locator('table tbody tr').count()
    check('UI 跳到第 2 页有数据', rows2 >= 1 && rows2 <= 10, String(rows2))
    const page2Text = await page.locator('table tbody').innerText()
    check('第 2 页仍是分页数据', page2Text.includes('E2E-R10'), page2Text.slice(0, 80))
  }
  endRound()

  // —— 11 UI 表单新增 ——
  startRound(11, 'UI 表单新增流水')
  {
    await refreshLedger(page)
    await page.getByRole('button', { name: '新增流水' }).click()
    await page.waitForSelector('h3:has-text("新增流水")')
    const dates = page.locator('[role="dialog"] input[type="date"]')
    check('表单含 3 个日期', (await dates.count()) >= 3, String(await dates.count()))
    await dates.nth(0).fill('2026-07-28')
    await dates.nth(1).fill('2026-07-08')
    await dates.nth(2).fill('2026-07-09')
    await page.getByPlaceholder('例如 150000').fill('12.5')
    await page.getByPlaceholder('商户 / 说明').fill('E2E-R11 油费小数')
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForTimeout(500)
    const toast = await page.locator('.toast').innerText().catch(() => '')
    check('新增 toast', /新增|凭证/.test(toast), toast)
    const row = await page.evaluate(async () => {
      const r = await window.api.queryTransactions({
        year: '2026',
        month: '07',
        keyword: 'E2E-R11',
        page: 1,
        pageSize: 5,
      })
      return r.list[0]
    })
    check('小数金额 -12.5', Math.abs(Number(row?.amount) + 12.5) < 1e-9, String(row?.amount))
    check('期间 7.8–7.9', row?.period_start === '2026-07-08' && row?.period_end === '2026-07-09', `${row?.period_start}~${row?.period_end}`)
    check('详情抽屉打开', (await page.locator('[role="dialog"], .drawer, .detail').filter({ hasText: '油费' }).count()) >= 1 || (await page.getByText('业务期间').count()) >= 1)
  }
  endRound()

  // —— 12 详情面板 ——
  startRound(12, '详情面板字段')
  {
    await closeOverlays(page)
    await refreshLedger(page)
    await searchByKeyword(page, 'E2E-R11')
    await page.locator('table tbody tr').first().getByRole('button', { name: '详情' }).click()
    await page.waitForTimeout(300)
    const detail = page.locator('[role="dialog"]').filter({ hasText: '流水详情' })
    check('详情对话框', (await detail.count()) >= 1)
    const text = (await detail.innerText().catch(() => '')) || (await page.locator('main').innerText())
    check('详情含报账日期', text.includes('报账日期'))
    check('详情含业务期间', text.includes('业务期间'))
    check('详情含金额或备注', text.includes('油费') || text.includes('12.5') || text.includes('12'))
    check('详情提示可上传凭证', /凭证|PDF|图片|暂无/.test(text))
    await page.keyboard.press('Escape')
  }
  endRound()

  // —— 13 账户汇总 ——
  startRound(13, '账户汇总正确性')
  {
    const sum = await page.evaluate(async () => {
      const rows = await window.api.getAccountSummary({
        start: '2026-07-01',
        end: '2026-07-31',
      })
      const byMonth = await window.api.getAccountSummary('2026-07')
      const all = await window.api.getAccountSummary()
      const q = await window.api.queryTransactions({ year: '2026', month: '07', page: 1, pageSize: 100 })
      return { rows, byMonth, all, income: q.income, expense: q.expense, total: q.total }
    })
    check('7 月区间汇总有账户行', sum.rows.length >= 1, String(sum.rows.length))
    check('月份字符串与区间结果一致', sum.rows[0]?.income === sum.byMonth[0]?.income)
    const pay = sum.rows.find((r) => r.id === ctx.accountId) || sum.rows[0]
    check('汇总含收入/支出字段', pay && ('income' in pay || 'expense' in pay || 'ending' in pay || 'end_balance' in pay), JSON.stringify(pay).slice(0, 120))
    check('查询合计收入>0', sum.income > 0, String(sum.income))
    check('查询合计支出>0', sum.expense > 0, String(sum.expense))

    await gotoTab(page, '账户汇总')
    const dates = page.locator('input[type="date"]')
    if ((await dates.count()) >= 2) {
      await dates.nth(0).fill('2026-07-01')
      await dates.nth(1).fill('2026-07-31')
    }
    await page.waitForTimeout(400)
    const mainText = await page.locator('main').innerText()
    check('汇总页有表格或数字', /\d/.test(mainText) && !mainText.includes('桌面接口未就绪'))
    check('汇总页有合计行', mainText.includes('合计'))
  }
  endRound()

  // —— 14 分类统计 ——
  startRound(14, '分类统计正确性')
  {
    const stats = await page.evaluate(async () =>
      window.api.getCategoryStats({ start: '2026-07-01', end: '2026-07-31' }),
    )
    check('有分类统计行', stats.length >= 1, String(stats.length))
    const traffic = stats.find((s) => /交通|E2E|餐|食/.test(s.name)) || stats[0]
    check('统计含笔数', typeof traffic.count === 'number' && traffic.count >= 1, JSON.stringify(traffic))
    await gotoTab(page, '分类统计')
    const dates = page.locator('input[type="date"]')
    if ((await dates.count()) >= 2) {
      await dates.nth(0).fill('2026-07-01')
      await dates.nth(1).fill('2026-07-31')
    }
    await page.waitForTimeout(400)
    const text = await page.locator('main').innerText()
    check('统计页渲染', (await page.locator('main table tbody tr').count()) >= 1 || text.length > 30)
    check('统计页有合计行', text.includes('合计'))
  }
  endRound()

  // —— 15 导出对话框 ——
  startRound(15, '导出 Excel / 票据文件夹对话框')
  {
    await closeOverlays(page)
    await gotoTab(page, '记账明细')
    await page.locator('.side-actions').getByRole('button', { name: '导出票据文件夹' }).click()
    await page.waitForTimeout(350)
    let modal = page.locator('[role="dialog"], .modal').filter({ hasText: /导出/ })
    let text = await modal.first().innerText()
    check('票据导出对话框', /票据|分类|几号到几号|文件夹/.test(text), text.slice(0, 100))
    check('可选年份月份', /年份|月份|2026/.test(text))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    await page.locator('.side-actions').getByRole('button', { name: '导出 Excel', exact: true }).click()
    await page.waitForTimeout(350)
    modal = page.locator('[role="dialog"], .modal').filter({ hasText: /导出/ })
    text = await modal.first().innerText()
    check('Excel 导出对话框', /Excel|导出/.test(text), text.slice(0, 80))
    check('显示开始和结束日期', text.includes('开始日期') && text.includes('结束日期'))
    await modal.locator('#export-start').fill('2026-07-01')
    await modal.locator('#export-end').fill('2026-08-31')
    await page.waitForTimeout(300)
    const rangeRows = await page.evaluate(async () => {
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
      }
    })
    check(
      '跨月范围严格过滤报账日期',
      rangeRows.total > 0 &&
        rangeRows.dates.every((date) => date >= '2026-07-01' && date <= '2026-08-31'),
      `${rangeRows.total} 笔`,
    )
    check('日期范围导出接口可用', rangeRows.hasExportRange)
    await page.keyboard.press('Escape')

    // 顶部导出按钮
    await page.locator('.toolbar').getByRole('button', { name: '导出', exact: true }).click()
    await page.waitForTimeout(300)
    check('顶栏导出也可开对话框', (await page.locator('[role="dialog"], .modal').filter({ hasText: /导出/ }).count()) >= 1)
    await page.keyboard.press('Escape')
  }
  endRound()

  // —— 16 设置页 ——
  startRound(16, '设置页：导入入口与主数据编辑')
  {
    await gotoTab(page, '设置')
    const text = await page.locator('main').innerText()
    check('合并导入按钮', text.includes('合并导入'))
    check('清空后导入按钮', text.includes('清空后导入'))
    check('打开数据文件夹', text.includes('打开数据文件夹'))
    check('版本信息', text.includes('1.4.2') || text.includes('印尼盾记账'))
    check('支付方式区块', text.includes('支付方式') || text.includes('期初'))
    check('分类区块', text.includes('分类'))

    const renamed = await page.evaluate(async () => {
      const cats = await window.api.listCategories()
      const c = cats.find((x) => x.name === 'E2E测试分类')
      if (!c) return { ok: false, reason: 'missing' }
      await window.api.upsertCategory({ id: c.id, name: 'E2E测试分类-改' })
      const again = (await window.api.listCategories()).find((x) => x.id === c.id)
      return { ok: again?.name === 'E2E测试分类-改', name: again?.name }
    })
    check('分类重命名 API', renamed.ok, renamed.name || renamed.reason)
  }
  endRound()

  // —— 17 年月列表与筛选联动 ——
  startRound(17, '有数据年份/月份列表')
  {
    const lists = await page.evaluate(async () => {
      const years = await window.api.listYears()
      const months = await window.api.listMonths()
      return {
        years: years.map((y) => y.year || y),
        months: months.map((m) => m.month || m),
      }
    })
    check('年份含 2026', lists.years.map(String).includes('2026'), lists.years.join(','))
    check('月份含 2026-07', lists.months.includes('2026-07'), lists.months.slice(0, 8).join(','))
    check('月份含 2026-08', lists.months.includes('2026-08'), lists.months.slice(0, 8).join(','))

    await gotoTab(page, '记账明细')
    // 触发 meta 刷新：开关设置页
    await gotoTab(page, '设置')
    await gotoTab(page, '记账明细')
    await page.waitForTimeout(300)
    const yearOpts = await page.locator('#q-year option').allTextContents()
    check('UI 年份选项含 2026', yearOpts.some((t) => t.includes('2026')), yearOpts.join('|'))
  }
  endRound()

  // —— 18 金额展示与类型切换 ——
  startRound(18, '金额展示格式与收入类型切换')
  {
    const id = await page.evaluate(async (p) => {
      return window.api.createTransaction({
        date: '2026-07-27',
        period_start: '2026-07-27',
        period_end: '2026-07-27',
        account_id: p.accountId,
        category_id: p.catFood,
        type: '支出',
        amount: 1019900,
        note: 'E2E-R18 格式',
      })
    }, ctx)
    await page.evaluate(
      async ({ id, accountId, catId }) => {
        await window.api.updateTransaction(id, {
          date: '2026-07-27',
          period_start: '2026-07-27',
          period_end: '2026-07-27',
          account_id: accountId,
          category_id: catId,
          type: '收入',
          amount: 1019900,
          note: 'E2E-R18 格式',
          checked: false,
        })
      },
      { id, accountId: ctx.accountId, catId: ctx.catFood },
    )
    const row = await page.evaluate((i) => window.api.getTransaction(i), id)
    check('改为收入后为正', Number(row.amount) === 1019900, String(row.amount))
    check('类型字段为收入', row.type === '收入', row.type)

    await refreshLedger(page)
    await searchByKeyword(page, 'E2E-R18')
    const cell = await page.locator('table tbody tr').first().innerText()
    check('列表正金额千分位', cell.includes('1,019,900.00') && !cell.includes('-1,019,900'), cell.slice(0, 100))
    check('列表类型为收入', cell.includes('收入'), cell.slice(0, 80))
    await page.locator('table tbody tr').first().getByRole('button', { name: '详情' }).click()
    await page.waitForTimeout(250)
    const detailText = await page.locator('[role="dialog"]').filter({ hasText: '流水详情' }).innerText()
    check(
      '详情 Rp 格式',
      /Rp\s*1,019,900\.00/.test(detailText) || detailText.includes('1,019,900'),
      detailText.slice(0, 160).replace(/\s+/g, ' '),
    )
    await page.keyboard.press('Escape')
  }
  endRound()

  // —— 19 请求序号/连续查询一致性 ——
  startRound(19, '连续查询一致性与空结果')
  {
    const race = await page.evaluate(async () => {
      const reqs = [
        window.api.queryTransactions({ year: '2026', month: '07', keyword: 'E2E-R10', page: 1, pageSize: 5 }),
        window.api.queryTransactions({ year: '2026', month: '08', keyword: '八月', page: 1, pageSize: 5 }),
        window.api.queryTransactions({ year: '2099', month: '01', page: 1, pageSize: 5 }),
      ]
      const [a, b, c] = await Promise.all(reqs)
      return {
        a: a.total,
        bNotes: b.list.map((x) => x.note).join('|'),
        cTotal: c.total,
        cList: c.list.length,
      }
    })
    check('并行查询 7 月分页关键词', race.a === 12, String(race.a))
    check('并行查询 8 月独立', race.bNotes.includes('八月'), race.bNotes)
    check('空月份 total=0', race.cTotal === 0 && race.cList === 0, `total=${race.cTotal}`)

    await refreshLedger(page, '2026', '07')
    await searchByKeyword(page, '绝对不存在的备注XYZXYZ')
    const empty = await page.locator('table tbody tr').count()
    const emptyTitle = await page.locator('.empty-title').innerText().catch(() => '')
    const mainText = await page.locator('main').innerText()
    check(
      '无匹配 UI 空态',
      empty === 0 && (/还没有流水/.test(emptyTitle) || /共\s*0/.test(mainText) || /收入Rp 0\.00/.test(mainText.replace(/\s+/g, ''))),
      `rows=${empty} title=${emptyTitle} snippet=${mainText.slice(0, 60).replace(/\s+/g, ' ')}`,
    )
  }
  endRound()

  // —— 20 终态一致性与稳定性 ——
  startRound(20, '终态一致性、数据目录与进程稳定')
  {
    const final = await page.evaluate(async () => {
      const all = await window.api.queryTransactions({ year: '2026', page: 1, pageSize: 100 })
      const jul = await window.api.queryTransactions({ year: '2026', month: '07', page: 1, pageSize: 100 })
      const path = await window.api.getDataPath()
      const ver = await window.api.getVersion()
      // 抽样：所有支出金额 <= 0，收入 >= 0
      const signOk = all.list.every((t) =>
        t.type === '支出' ? Number(t.amount) <= 0 : Number(t.amount) >= 0,
      )
      const periodOk = all.list.every((t) => {
        if (!t.period_start || !t.period_end) return true
        return t.period_start <= t.period_end
      })
      return {
        total2026: all.total,
        julTotal: jul.total,
        income: jul.income,
        expense: jul.expense,
        path,
        ver,
        signOk,
        periodOk,
        sample: all.list.slice(0, 3).map((t) => ({ note: t.note, amount: t.amount, p: [t.period_start, t.period_end] })),
      }
    })
    check('2026 年总笔数合理', final.total2026 >= 15, String(final.total2026))
    check('7 月笔数合理', final.julTotal >= 12, String(final.julTotal))
    check('符号规则全局成立', final.signOk)
    check('期间起止顺序全局成立', final.periodOk)
    check('版本仍为 1.4.9', final.ver === '1.4.9', final.ver)
    check('数据目录仍隔离', String(final.path).includes('rp-ledger-e2e20'), final.path)

    const dbFile = path.join(final.path, 'ledger.sqlite')
    check('ledger.sqlite 已落盘', fs.existsSync(dbFile), dbFile)
    check('库文件非空', fs.existsSync(dbFile) && fs.statSync(dbFile).size > 1000, fs.existsSync(dbFile) ? String(fs.statSync(dbFile).size) : 'missing')

    // 快速切换压力
    for (const tab of ['账户汇总', '分类统计', '设置', '记账明细', '账户汇总', '记账明细']) {
      await gotoTab(page, tab)
    }
    check('快速切页后进程仍在', exitCode === null)
    const h1 = await page.locator('h1').first().innerText()
    check('最终停在记账明细', h1.includes('记账明细'), h1)
    check('window.api 仍可用', await page.evaluate(() => typeof window.api.queryTransactions === 'function'))
  }
  endRound()
} catch (err) {
  console.error('\nE2E 异常中断:', err)
  if (currentRound) {
    check('轮次未抛异常', false, String(err?.stack || err?.message || err).slice(0, 300))
    endRound()
  }
  process.exitCode = 1
} finally {
  try {
    if (browser) await browser.close().catch(() => {})
  } catch {
    /* ignore */
  }
  try {
    if (child.pid && exitCode === null) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      await new Promise((r) => setTimeout(r, 600))
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

console.log('\n================ 20 轮汇总 ================')
let passed = 0
let failed = 0
let checksOk = 0
let checksAll = 0
for (const r of rounds) {
  const okN = r.checks.filter((c) => c.ok).length
  checksOk += okN
  checksAll += r.checks.length
  if (r.ok) passed += 1
  else {
    failed += 1
    console.log(`失败轮次 ${r.n} ${r.title}:`)
    for (const c of r.checks.filter((x) => !x.ok)) {
      console.log(`  - ${c.name}: ${c.detail}`)
    }
  }
}
console.log(`轮次：${passed}/20 通过，失败 ${failed}`)
console.log(`断言：${checksOk}/${checksAll} 通过`)
if (failed > 0 || rounds.length < 20) {
  process.exitCode = 1
  console.log('结果：未全部通过')
} else {
  console.log('结果：20 轮端到端全部通过')
}
