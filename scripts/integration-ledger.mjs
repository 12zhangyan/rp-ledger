/**
 * 多轮账本集成测试：内存 sql.js，覆盖查询/余额/附件/删除约束等。
 * 不触碰用户真实数据目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const initSqlJs = require('sql.js')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const SQL = await initSqlJs({
  locateFile: (file) => path.join(root, 'node_modules/sql.js/dist', file),
})

let db = new SQL.Database()
let bulkDepth = 0
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ledger-test-'))
const dbFile = path.join(tmpRoot, 'ledger.sqlite')

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0]
}

/** sql.js export() 会清空 last_insert_rowid，必须先取 id 再 persist */
function run(sql, params = []) {
  db.run(sql, params)
  const id = Number(db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0] ?? 0)
  if (bulkDepth === 0) persist()
  return id
}

function persist() {
  const data = db.export()
  const tmp = `${dbFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, Buffer.from(data))
  fs.copyFileSync(tmp, dbFile)
  fs.unlinkSync(tmp)
}

function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function signedAmount(type, amount) {
  const abs = Math.abs(amount)
  return type === '支出' ? -abs : abs
}

function initSchema() {
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      opening_balance REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE doc_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      category_id INTEGER,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      doc_type_id INTEGER,
      note TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `)
  ;[
    ['BCA', 1000000, 1],
    ['现金', 500000, 2],
    ['月余额', 0, 3],
  ].forEach(([name, bal, order]) => {
    db.run('INSERT INTO accounts (name, opening_balance, sort_order) VALUES (?, ?, ?)', [
      name,
      bal,
      order,
    ])
  })
  ;['生活费', '办公费', '余额'].forEach((name, i) => {
    db.run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, i + 1])
  })
  ;['小票', '发票'].forEach((name, i) => {
    db.run('INSERT INTO doc_types (name, sort_order) VALUES (?, ?)', [name, i + 1])
  })
  persist()
}

function createTx(input) {
  const amount = signedAmount(input.type, input.amount)
  return run(
    `INSERT INTO transactions (date, account_id, category_id, type, amount, doc_type_id, note, checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.date,
      input.account_id,
      input.category_id ?? null,
      input.type,
      amount,
      input.doc_type_id ?? null,
      input.note ?? null,
      input.checked ? 1 : 0,
    ],
  )
}

function addAtt(txId, stored, fileName = stored) {
  return run(
    `INSERT INTO attachments (transaction_id, file_name, stored_name, mime_type) VALUES (?, ?, ?, ?)`,
    [txId, fileName, stored, 'image/png'],
  )
}

function listAttachments(txId, limit) {
  if (limit && limit > 0) {
    return queryAll(
      'SELECT * FROM attachments WHERE transaction_id = ? ORDER BY id LIMIT ?',
      [txId, limit],
    )
  }
  return queryAll('SELECT * FROM attachments WHERE transaction_id = ? ORDER BY id', [txId])
}

function buildTxWhere(filters = {}) {
  const where = []
  const params = []
  if (filters.month && /^\d{4}-\d{2}$/.test(filters.month)) {
    where.push("strftime('%Y-%m', t.date) = ?")
    params.push(filters.month)
  } else {
    if (filters.year) {
      where.push("strftime('%Y', t.date) = ?")
      params.push(filters.year)
    }
    if (filters.month && /^\d{1,2}$/.test(filters.month)) {
      where.push("strftime('%m', t.date) = ?")
      params.push(filters.month.padStart(2, '0'))
    }
  }
  if (filters.start && /^\d{4}-\d{2}-\d{2}$/.test(filters.start)) {
    where.push('t.date >= ?')
    params.push(filters.start)
  }
  if (filters.end && /^\d{4}-\d{2}-\d{2}$/.test(filters.end)) {
    where.push('t.date <= ?')
    params.push(filters.end)
  }
  if (filters.account_id) {
    where.push('t.account_id = ?')
    params.push(filters.account_id)
  }
  if (filters.category_id) {
    where.push('t.category_id = ?')
    params.push(filters.category_id)
  }
  if (filters.type === '收入' || filters.type === '支出') {
    where.push('t.type = ?')
    params.push(filters.type)
  }
  if (filters.keyword?.trim()) {
    where.push(
      `(IFNULL(t.note, '') LIKE ? ESCAPE '\\' OR IFNULL(cat.name, '') LIKE ? ESCAPE '\\' OR IFNULL(a.name, '') LIKE ? ESCAPE '\\')`,
    )
    const kw = `%${escapeLike(filters.keyword.trim())}%`
    params.push(kw, kw, kw)
  }
  return { where, params }
}

function queryTransactions(filters = {}) {
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 10))
  const { where, params } = buildTxWhere(filters)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number(
    queryOne(
      `SELECT COUNT(*) AS cnt FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories cat ON cat.id = t.category_id
       ${whereSql}`,
      params,
    )?.cnt ?? 0,
  )
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const offset = (safePage - 1) * pageSize
  const rows = queryAll(
    `SELECT t.id, t.date, t.amount, t.type, t.note, t.account_id, a.name AS account_name,
            t.category_id, cat.name AS category_name,
            (SELECT COUNT(*) FROM attachments att WHERE att.transaction_id = t.id) AS attachment_count
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories cat ON cat.id = t.category_id
     ${whereSql}
     ORDER BY t.date DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )
  const list = rows.map((row) => {
    const id = Number(row.id)
    const count = Number(row.attachment_count ?? 0)
    return {
      ...row,
      amount: Number(row.amount),
      attachment_count: count,
      attachments: count > 0 ? listAttachments(id, 3) : [],
    }
  })
  const sumRow = queryOne(
    `SELECT
      COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END), 0) AS expense
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories cat ON cat.id = t.category_id
     ${whereSql}`,
    params,
  )
  return {
    list,
    total,
    page: safePage,
    pageSize,
    totalPages,
    income: Number(sumRow?.income ?? 0),
    expense: Number(sumRow?.expense ?? 0),
  }
}

function getOpeningBalanceTotal() {
  return Number(
    queryOne(
      `SELECT COALESCE(SUM(opening_balance), 0) AS total FROM accounts WHERE active = 1 AND name != ?`,
      ['月余额'],
    )?.total ?? 0,
  )
}

function withRunningBalance(rows, month) {
  let balance = getOpeningBalanceTotal()
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const prior = queryOne(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE date < ?`, [
      `${month}-01`,
    ])
    balance = getOpeningBalanceTotal() + Number(prior?.s ?? 0)
  }
  return rows.map((row) => {
    balance += Number(row.amount)
    return { ...row, balance }
  })
}

function accountSummary(month) {
  const accounts = queryAll(
    `SELECT * FROM accounts WHERE active = 1 AND name != '月余额' ORDER BY sort_order`,
  )
  return accounts.map((acc) => {
    const periodParams = [acc.id, month]
    const income = Number(
      queryOne(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
         WHERE account_id = ? AND amount > 0 AND strftime('%Y-%m', date) = ?`,
        periodParams,
      )?.s ?? 0,
    )
    const expense = Number(
      queryOne(
        `SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM transactions
         WHERE account_id = ? AND amount < 0 AND strftime('%Y-%m', date) = ?`,
        periodParams,
      )?.s ?? 0,
    )
    const [y, m] = month.split('-').map(Number)
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    const cumulative = Number(
      queryOne(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date < ?`,
        [acc.id, next],
      )?.s ?? 0,
    )
    return {
      name: acc.name,
      opening_balance: Number(acc.opening_balance),
      income,
      expense,
      net: income - expense,
      current_balance: Number(acc.opening_balance) + cumulative,
    }
  })
}

function deleteCategory(id) {
  const cnt = Number(
    queryOne('SELECT COUNT(*) AS cnt FROM transactions WHERE category_id = ?', [id])?.cnt ?? 0,
  )
  if (cnt > 0) throw new Error(`该分类仍被 ${cnt} 笔流水使用，请先修改这些流水后再删除`)
  run('DELETE FROM categories WHERE id = ?', [id])
}

function findDuplicate(input) {
  return queryOne(
    `SELECT id FROM transactions
     WHERE date = ? AND account_id = ? AND amount = ?
       AND IFNULL(note, '') = IFNULL(?, '')
     LIMIT 1`,
    [input.date, input.account_id, input.amount, input.note ?? null],
  )
}

function safeStoredName(storedName) {
  const raw = String(storedName || '').replace(/\\/g, '/')
  const base = path.basename(raw)
  if (!base || base === '.' || base === '..' || base.includes('\0')) {
    throw new Error('非法图片文件名')
  }
  if (raw.includes('/') && raw.split('/').filter(Boolean).length > 1) {
    throw new Error('非法图片路径')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error('非法图片文件名')
  }
  return base
}

function round(name, fn) {
  process.stdout.write(`  · ${name} ... `)
  fn()
  console.log('ok')
}

console.log('integration-ledger 开始，临时目录:', tmpRoot)
initSchema()

const bca = queryOne(`SELECT id FROM accounts WHERE name = 'BCA'`).id
const cash = queryOne(`SELECT id FROM accounts WHERE name = '现金'`).id
const life = queryOne(`SELECT id FROM categories WHERE name = '生活费'`).id
const office = queryOne(`SELECT id FROM categories WHERE name = '办公费'`).id
const unusedCat = queryOne(`SELECT id FROM categories WHERE name = '余额'`).id
const doc = queryOne(`SELECT id FROM doc_types WHERE name = '小票'`).id

// —— 第 1 轮：金额符号与基础 CRUD ——
console.log('\n[轮次 1] 金额符号 / CRUD / 金额 0')
round('支出为负、收入为正，且 insert 在 persist 后仍返回有效 id', () => {
  const id1 = createTx({
    date: '2026-01-05',
    account_id: bca,
    category_id: life,
    type: '支出',
    amount: 150000,
    doc_type_id: doc,
    note: '午餐',
  })
  const id2 = createTx({
    date: '2026-01-06',
    account_id: bca,
    category_id: office,
    type: '收入',
    amount: 500000,
    doc_type_id: doc,
    note: '报销',
  })
  const id0 = createTx({
    date: '2026-01-07',
    account_id: cash,
    category_id: life,
    type: '支出',
    amount: 0,
    note: '零金额',
  })
  assert.ok(id1 >= 1, `id1 应 >= 1，实际 ${id1}`)
  assert.ok(id2 > id1)
  assert.ok(id0 > id2)
  assert.equal(Number(queryOne('SELECT amount FROM transactions WHERE id = ?', [id1]).amount), -150000)
  assert.equal(Number(queryOne('SELECT amount FROM transactions WHERE id = ?', [id2]).amount), 500000)
  assert.equal(Number(queryOne('SELECT amount FROM transactions WHERE id = ?', [id0]).amount), 0)
})

// —— 第 2 轮：筛选与分页 ——
console.log('\n[轮次 2] 年月筛选 / 分页 / 关键词转义')
round('年+月筛选与合计', () => {
  createTx({
    date: '2025-12-31',
    account_id: bca,
    category_id: life,
    type: '支出',
    amount: 10000,
    note: '跨年',
  })
  createTx({
    date: '2026-02-01',
    account_id: bca,
    category_id: life,
    type: '支出',
    amount: 20000,
    note: '二月',
  })
  const jan = queryTransactions({ year: '2026', month: '01', page: 1, pageSize: 10 })
  assert.ok(jan.total >= 3)
  assert.ok(jan.list.every((r) => r.date.startsWith('2026-01')))
  assert.equal(jan.income, 500000)
  assert.ok(jan.expense >= 150000)

  const ym = queryTransactions({ month: '2026-01', page: 1, pageSize: 10 })
  assert.equal(ym.total, jan.total)
})

round('日期范围闭区间可跨月跨年', () => {
  const range = queryTransactions({
    start: '2025-12-31',
    end: '2026-02-01',
    page: 1,
    pageSize: 100,
  })
  assert.ok(range.list.some((r) => r.date === '2025-12-31'), '应包含开始日期')
  assert.ok(range.list.some((r) => r.date === '2026-02-01'), '应包含结束日期')
  assert.ok(range.list.every((r) => r.date >= '2025-12-31' && r.date <= '2026-02-01'))
})

round('分页边界与 pageSize 下限钳制', () => {
  for (let i = 1; i <= 8; i++) {
    createTx({
      date: `2026-06-${String(i).padStart(2, '0')}`,
      account_id: cash,
      category_id: life,
      type: '支出',
      amount: 100 + i,
      note: `六月${i}`,
    })
  }
  const p1 = queryTransactions({ year: '2026', month: '06', page: 1, pageSize: 5 })
  assert.equal(p1.pageSize, 5)
  assert.equal(p1.list.length, 5)
  assert.ok(p1.totalPages >= 2)
  const clamped = queryTransactions({ year: '2026', month: '06', page: 1, pageSize: 2 })
  assert.equal(clamped.pageSize, 5, 'pageSize < 5 应钳到 5')
  const last = queryTransactions({ year: '2026', month: '06', page: 999, pageSize: 5 })
  assert.equal(last.page, last.totalPages)
  assert.ok(last.list.length <= 5)
})

round('LIKE 转义不把 % 当通配', () => {
  createTx({
    date: '2026-03-01',
    account_id: cash,
    category_id: life,
    type: '支出',
    amount: 1000,
    note: '折扣100%',
  })
  const hit = queryTransactions({ keyword: '100%', page: 1, pageSize: 10 })
  assert.ok(hit.list.some((r) => r.note === '折扣100%'))
  const miss = queryTransactions({ keyword: '折扣100x', page: 1, pageSize: 10 })
  assert.ok(!miss.list.some((r) => r.note === '折扣100%'))
})

// —— 第 3 轮：附件与详情限流 ——
console.log('\n[轮次 3] 附件数量 / LIMIT 3')
round('列表最多 3 张缩略图，计数正确', () => {
  const id = createTx({
    date: '2026-04-01',
    account_id: bca,
    category_id: office,
    type: '支出',
    amount: 3000,
    note: '多图',
  })
  for (let i = 1; i <= 5; i++) addAtt(id, `img-${i}.png`, `原图${i}.png`)
  const q = queryTransactions({ keyword: '多图', page: 1, pageSize: 10 })
  const row = q.list.find((r) => r.note === '多图')
  assert.ok(row)
  assert.equal(row.attachment_count, 5)
  assert.equal(row.attachments.length, 3)
  const all = listAttachments(id)
  assert.equal(all.length, 5)
})

round('路径安全', () => {
  assert.equal(safeStoredName('abc-123.png'), 'abc-123.png')
  assert.throws(() => safeStoredName('../x.png'))
  assert.throws(() => safeStoredName('a/b.png'))
})

// —— 第 4 轮：余额与账户汇总 ——
console.log('\n[轮次 4] 运行余额 / 账户期末')
round('运行余额 = 期初 + 累计', () => {
  const monthRows = queryAll(
    `SELECT amount FROM transactions WHERE strftime('%Y-%m', date) = '2026-01' ORDER BY date ASC, id ASC`,
  )
  const withBal = withRunningBalance(monthRows, '2026-01')
  const opening = getOpeningBalanceTotal()
  const prior = Number(
    queryOne(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE date < '2026-01-01'`)?.s ??
      0,
  )
  assert.equal(withBal[0].balance, opening + prior + Number(monthRows[0].amount))
})

round('账户汇总期末余额', () => {
  const sum = accountSummary('2026-01')
  const bcaRow = sum.find((a) => a.name === 'BCA')
  assert.ok(bcaRow)
  const cum = Number(
    queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date < '2026-02-01'`,
      [bca],
    )?.s ?? 0,
  )
  assert.equal(bcaRow.current_balance, 1000000 + cum)
  assert.equal(bcaRow.net, bcaRow.income - bcaRow.expense)
})

// —— 第 5 轮：删除约束与去重 ——
console.log('\n[轮次 5] 删除约束 / 重复检测 / 持久化')
round('引用中的分类不可删，未引用可删', () => {
  assert.throws(() => deleteCategory(life))
  deleteCategory(unusedCat)
  assert.equal(queryOne('SELECT id FROM categories WHERE id = ?', [unusedCat]), undefined)
})

round('重复流水检测', () => {
  const amount = signedAmount('支出', 777)
  createTx({
    date: '2026-05-01',
    account_id: cash,
    category_id: life,
    type: '支出',
    amount: 777,
    note: 'dup',
  })
  const dup = findDuplicate({ date: '2026-05-01', account_id: cash, amount, note: 'dup' })
  assert.ok(dup?.id)
  const no = findDuplicate({ date: '2026-05-01', account_id: cash, amount, note: 'other' })
  assert.equal(no, undefined)
})

round('原子持久化文件存在且可重载', () => {
  assert.ok(fs.existsSync(dbFile))
  const buf = fs.readFileSync(dbFile)
  const reopened = new SQL.Database(buf)
  const cnt = reopened.exec('SELECT COUNT(*) AS c FROM transactions')[0].values[0][0]
  assert.ok(Number(cnt) >= 5)
  reopened.close()
})

// —— 第 6 轮：竞态丢弃语义（前端同款） ——
console.log('\n[轮次 6] 请求序号丢弃过期结果')
round('旧响应不覆盖新结果', () => {
  let latest = 0
  let value = null
  function apply(reqId, v) {
    if (reqId !== latest) return
    value = v
  }
  latest = 1
  apply(1, 'old')
  latest = 2
  apply(1, 'stale')
  apply(2, 'new')
  assert.equal(value, 'new')
})

// —— 第 7 轮：业务期间与票据文件名（与 electron/period.ts 对齐） ——
console.log('\n[轮次 7] 业务期间 / 票据文件名')
function pad2(n) {
  return String(n).padStart(2, '0')
}
function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  return m ? { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) } : null
}
function ymdKey(p) {
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`
}
function orderPair(a, b) {
  return ymdKey(a) <= ymdKey(b) ? [a, b] : [b, a]
}
function formatPeriodFolder(start, end) {
  if (!start && !end) return '未填期间'
  let a = parseYmd(start || end)
  let b = parseYmd(end || start)
  if (!a || !b) return '未填期间'
  ;[a, b] = orderPair(a, b)
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) return `${a.y}.${a.mo}.${a.d}`
  if (a.y === b.y) return `${a.y}.${a.mo}.${a.d}-${b.mo}.${b.d}`
  return `${a.y}.${a.mo}.${a.d}-${b.y}.${b.mo}.${b.d}`
}
function sanitizeFilePart(raw) {
  return String(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
}
function formatAmountForFile(amount) {
  const abs = Math.abs(Number(amount) || 0)
  if (!Number.isFinite(abs)) return '0'
  if (Math.abs(abs - Math.round(abs)) < 1e-9) return String(Math.round(abs))
  return abs.toFixed(2).replace(/\.?0+$/, '').replace('.', '_')
}
function buildReceiptFileName(opts) {
  const date = sanitizeFilePart(opts.date || '')
  const period =
    opts.periodStart || opts.periodEnd
      ? sanitizeFilePart(formatPeriodFolder(opts.periodStart, opts.periodEnd)) || '未填期间'
      : ''
  const note = sanitizeFilePart(opts.note || '')
  const cat = sanitizeFilePart(opts.categoryName || '')
  const amount = formatAmountForFile(opts.amount)
  let ext = opts.ext.startsWith('.') ? opts.ext : `.${opts.ext}`
  if (ext === '.jpeg') ext = '.jpg'
  const parts = [date, period, note, cat, amount].filter(Boolean)
  const name = `${parts.join(' ')}${ext}`
  const base = name.toLowerCase().endsWith(ext.toLowerCase())
    ? name.slice(0, -ext.length)
    : name
  return `${sanitizeFilePart(base) || '凭证'}${ext}`
}
function categoryFolderName(categoryName) {
  return sanitizeFilePart(categoryName || '') || '未分类'
}
function periodFolderName(start, end) {
  const label = formatPeriodLabel(start, end).replace(/[\u2013\u2014]/g, '-')
  if (!label || label === '-') return '未填期间'
  return sanitizeFilePart(label) || '未填期间'
}
function formatPeriodLabel(start, end) {
  if (!start && !end) return '-'
  let a = parseYmd(start || end)
  let b = parseYmd(end || start)
  if (!a || !b) return '-'
  ;[a, b] = orderPair(a, b)
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) return `${a.mo}.${a.d}`
  if (a.y === b.y) return `${a.mo}.${a.d}–${b.mo}.${b.d}`
  return `${a.y}.${a.mo}.${a.d}–${b.y}.${b.mo}.${b.d}`
}
function parsePeriodFolderText(raw, yearHint) {
  const s0 = String(raw || '')
    .trim()
    .replace(/[\u2013\u2014]/g, '-')
  if (!s0 || s0 === '未填期间' || s0 === '-') {
    return { period_start: null, period_end: null }
  }
  const ordered = (start, end) =>
    start <= end
      ? { period_start: start, period_end: end }
      : { period_start: end, period_end: start }
  const looksLikeYearWrap = (mo1, mo2) => mo1 >= 11 && mo2 <= 2
  const cross = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(s0)
  if (cross) {
    return ordered(
      `${cross[1]}-${pad2(cross[2])}-${pad2(cross[3])}`,
      `${cross[4]}-${pad2(cross[5])}-${pad2(cross[6])}`,
    )
  }
  const range = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/.exec(s0)
  if (range) {
    const y = Number(range[1])
    const mo1 = Number(range[2])
    const d1 = Number(range[3])
    const mo2 = Number(range[4])
    const d2 = Number(range[5])
    const start = `${range[1]}-${pad2(mo1)}-${pad2(d1)}`
    if (looksLikeYearWrap(mo1, mo2)) {
      return {
        period_start: start,
        period_end: `${y + 1}-${pad2(mo2)}-${pad2(d2)}`,
      }
    }
    return ordered(start, `${range[1]}-${pad2(mo2)}-${pad2(d2)}`)
  }
  const one = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(s0)
  if (one) {
    const d = `${one[1]}-${pad2(one[2])}-${pad2(one[3])}`
    return { period_start: d, period_end: d }
  }
  const yearNum = yearHint && /^(\d{4})/.exec(yearHint)?.[1]
  if (yearNum) {
    const y = Number(yearNum)
    const shortRange = /^(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/.exec(s0)
    if (shortRange) {
      const mo1 = Number(shortRange[1])
      const d1 = Number(shortRange[2])
      const mo2 = Number(shortRange[3])
      const d2 = Number(shortRange[4])
      const end = `${yearNum}-${pad2(mo2)}-${pad2(d2)}`
      if (looksLikeYearWrap(mo1, mo2)) {
        return {
          period_start: `${y - 1}-${pad2(mo1)}-${pad2(d1)}`,
          period_end: end,
        }
      }
      return ordered(`${yearNum}-${pad2(mo1)}-${pad2(d1)}`, end)
    }
    const shortOne = /^(\d{1,2})\.(\d{1,2})$/.exec(s0)
    if (shortOne) {
      const d = `${yearNum}-${pad2(shortOne[1])}-${pad2(shortOne[2])}`
      return { period_start: d, period_end: d }
    }
  }
  return { period_start: null, period_end: null }
}
round('期间文件夹与文件名', () => {
  assert.equal(formatPeriodFolder('2026-07-03', '2026-07-24'), '2026.7.3-7.24')
  assert.equal(formatPeriodFolder('2026-07-24', '2026-07-03'), '2026.7.3-7.24')
  const name = buildReceiptFileName({
    periodStart: '2026-07-03',
    periodEnd: '2026-07-24',
    note: 'grab打车',
    categoryName: '交通费',
    amount: -1204999,
    ext: '.pdf',
  })
  assert.equal(name, '2026.7.3-7.24 grab打车 交通费 1204999.pdf')
  assert.equal(
    buildReceiptFileName({
      date: '2026-08-15',
      periodStart: '2026-07-06',
      periodEnd: '2026-07-06',
      note: '油费.',
      categoryName: null,
      amount: 12.5,
      ext: '.jpg',
    }),
    '2026-08-15 2026.7.6 油费 12_5.jpg',
  )
  assert.equal(categoryFolderName('交通费'), '交通费')
  assert.equal(categoryFolderName(null), '未分类')
  assert.equal(categoryFolderName('a/b'), 'a_b')
  assert.equal(periodFolderName('2026-07-03', '2026-07-24'), '7.3-7.24')
  assert.equal(periodFolderName('2026-07-06', '2026-07-06'), '7.6')
  assert.equal(periodFolderName(null, null), '未填期间')
  assert.equal(
    buildReceiptFileName({
      date: '2026-08-15',
      note: 'grab打车',
      amount: -1204999,
      ext: '.pdf',
    }),
    '2026-08-15 grab打车 1204999.pdf',
  )
  assert.deepEqual(parsePeriodFolderText('7.3–7.24', '2026-08-01'), {
    period_start: '2026-07-03',
    period_end: '2026-07-24',
  })
  assert.deepEqual(parsePeriodFolderText('12.28–1.3', '2026-01-10'), {
    period_start: '2025-12-28',
    period_end: '2026-01-03',
  })
  assert.deepEqual(parsePeriodFolderText('2026.12.28-1.3'), {
    period_start: '2026-12-28',
    period_end: '2027-01-03',
  })
  assert.deepEqual(parsePeriodFolderText('3.1–2.1', '2026-07-15'), {
    period_start: '2026-02-01',
    period_end: '2026-03-01',
  })
  assert.deepEqual(parsePeriodFolderText('7.24–7.3', '2026-07-15'), {
    period_start: '2026-07-03',
    period_end: '2026-07-24',
  })
  assert.equal(formatPeriodFolder('2025-12-28', '2026-01-03'), '2025.12.28-2026.1.3')
})

db.close()
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log('\nintegration-ledger 全部通过')
