import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { electronDir } from './dirname'
import { getDbPath } from './paths'
import type { Database as SqlJsDatabase } from 'sql.js'

const require = createRequire(import.meta.url)
const initSqlJsModule = require('sql.js') as typeof import('sql.js') | { default: typeof import('sql.js') }
const initSqlJs =
  typeof initSqlJsModule === 'function'
    ? initSqlJsModule
    : (initSqlJsModule as { default: typeof import('sql.js') }).default

export type TxType = '收入' | '支出'

export interface Account {
  id: number
  name: string
  opening_balance: number
  sort_order: number
  active: number
}

export interface Category {
  id: number
  name: string
  sort_order: number
}

export interface DocType {
  id: number
  name: string
  sort_order: number
}

export interface Attachment {
  id: number
  transaction_id: number
  file_name: string
  stored_name: string
  mime_type: string | null
  created_at: string
}

export interface TransactionRow {
  id: number
  date: string
  period_start?: string | null
  period_end?: string | null
  account_id: number
  account_name: string
  category_id: number | null
  category_name: string | null
  type: TxType
  amount: number
  doc_type_id: number | null
  doc_type_name: string | null
  note: string | null
  checked: number
  created_at: string
  balance?: number
  attachment_count?: number
  attachments?: Attachment[]
}

let db: SqlJsDatabase | null = null
let bulkDepth = 0

function getDb() {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function persist() {
  const data = getDb().export()
  const target = getDbPath()
  const tmp = `${target}.${process.pid}.tmp`
  const buf = Buffer.from(data)
  fs.writeFileSync(tmp, buf)
  try {
    const fd = fs.openSync(tmp, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // Windows 上 rename 无法覆盖已存在文件
    fs.copyFileSync(tmp, target)
    try {
      const tfd = fs.openSync(target, 'r+')
      try {
        fs.fsyncSync(tfd)
      } finally {
        fs.closeSync(tfd)
      }
    } catch {
      /* fsync 目标失败不阻断 */
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function escapeLike(raw: string) {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export function beginBulk() {
  bulkDepth += 1
}

export function endBulk() {
  bulkDepth = Math.max(0, bulkDepth - 1)
  if (bulkDepth === 0) persist()
}

/**
 * 执行写语句。须在 persist/export 之前读取 last_insert_rowid：
 * sql.js 的 db.export() 会把 last_insert_rowid 重置为 0。
 */
function run(sql: string, params: unknown[] = []): number {
  getDb().run(sql, params as never[])
  const id = Number(getDb().exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0] ?? 0)
  if (bulkDepth === 0) persist()
  return id
}

function queryAll<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql)
  stmt.bind(params as never[])
  const rows: T[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return rows
}

function queryOne<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  return queryAll<T>(sql, params)[0]
}

function wasmPath() {
  const file = 'sql-wasm.wasm'
  const candidates = [
    path.join(process.resourcesPath, file),
    path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', file),
    path.join(electronDir, '../../node_modules/sql.js/dist', file),
    path.join(electronDir, '../node_modules/sql.js/dist', file),
    path.join(process.cwd(), 'node_modules/sql.js/dist', file),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[candidates.length - 1]
}

export async function initDb() {
  const SQL = await initSqlJs({
    locateFile: () => wasmPath(),
  })
  const dbFile = getDbPath()
  if (fs.existsSync(dbFile)) {
    db = new SQL.Database(fs.readFileSync(dbFile))
  } else {
    db = new SQL.Database()
  }

  getDb().run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      opening_balance REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS doc_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      account_id INTEGER NOT NULL,
      category_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('收入', '支出')),
      amount REAL NOT NULL,
      doc_type_id INTEGER,
      note TEXT,
      checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(account_id) REFERENCES accounts(id),
      FOREIGN KEY(category_id) REFERENCES categories(id),
      FOREIGN KEY(doc_type_id) REFERENCES doc_types(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_att_tx ON attachments(transaction_id);
  `)
  migrateSchema()
  persist()
  seedDefaults()
  return db
}

function tableColumns(table: string): string[] {
  return queryAll<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
}

function migrateSchema() {
  const cols = tableColumns('transactions')
  if (!cols.includes('period_start')) {
    getDb().run('ALTER TABLE transactions ADD COLUMN period_start TEXT')
  }
  if (!cols.includes('period_end')) {
    getDb().run('ALTER TABLE transactions ADD COLUMN period_end TEXT')
  }
}

function normalizePeriod(start?: string | null, end?: string | null) {
  const s = start?.trim() || null
  const e = end?.trim() || null
  if (!s && !e) return { period_start: null, period_end: null }
  if (s && !e) return { period_start: s, period_end: s }
  if (!s && e) return { period_start: e, period_end: e }
  if (s! > e!) return { period_start: e, period_end: s }
  return { period_start: s, period_end: e }
}

function seedDefaults() {
  const accountCount = queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM accounts')
  if (!accountCount?.c) {
    ;[
      ['BCA', 0, 1],
      ['ICBC', 0, 2],
      ['现金', 0, 3],
      ['OVO', 0, 4],
      ['月余额', 0, 5],
    ].forEach(([name, bal, order]) => {
      getDb().run('INSERT INTO accounts (name, opening_balance, sort_order) VALUES (?, ?, ?)', [
        name,
        bal,
        order,
      ] as never[])
    })
    persist()
  }

  const catCount = queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM categories')
  if (!catCount?.c) {
    ;['生活费', '办公费', '交通费', '招待费', '社保', '项目费用', '余额', '印花税', '工资'].forEach(
      (name, i) => {
        getDb().run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, i + 1] as never[])
      },
    )
    persist()
  }

  const docCount = queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM doc_types')
  if (!docCount?.c) {
    ;['小票', '发票', '白条', '电子票', '手写票'].forEach((name, i) => {
      getDb().run('INSERT INTO doc_types (name, sort_order) VALUES (?, ?)', [name, i + 1] as never[])
    })
    persist()
  }
}

export function listAccounts() {
  return queryAll<Account>('SELECT * FROM accounts WHERE active = 1 ORDER BY sort_order, id')
}

export function listAllAccounts() {
  return queryAll<Account>('SELECT * FROM accounts ORDER BY sort_order, id')
}

export function upsertAccount(input: {
  id?: number
  name: string
  opening_balance: number
  sort_order?: number
  active?: number
}) {
  if (input.id) {
    run(
      'UPDATE accounts SET name = ?, opening_balance = ?, sort_order = COALESCE(?, sort_order), active = COALESCE(?, active) WHERE id = ?',
      [input.name, input.opening_balance, input.sort_order ?? null, input.active ?? null, input.id],
    )
    return input.id
  }
  return run('INSERT INTO accounts (name, opening_balance, sort_order, active) VALUES (?, ?, ?, ?)', [
    input.name,
    input.opening_balance,
    input.sort_order ?? 99,
    input.active ?? 1,
  ])
}

export function listCategories() {
  return queryAll<Category>('SELECT * FROM categories ORDER BY sort_order, id')
}

export function upsertCategory(input: { id?: number; name: string; sort_order?: number }) {
  if (input.id) {
    run('UPDATE categories SET name = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?', [
      input.name,
      input.sort_order ?? null,
      input.id,
    ])
    return input.id
  }
  return run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [
    input.name,
    input.sort_order ?? 99,
  ])
}

export function deleteCategory(id: number) {
  const used = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM transactions WHERE category_id = ?',
    [id],
  )
  const cnt = Number(used?.cnt ?? 0)
  if (cnt > 0) {
    throw new Error(`该分类仍被 ${cnt} 笔流水使用，请先修改这些流水后再删除`)
  }
  run('DELETE FROM categories WHERE id = ?', [id])
}

export function listDocTypes() {
  return queryAll<DocType>('SELECT * FROM doc_types ORDER BY sort_order, id')
}

export function upsertDocType(input: { id?: number; name: string; sort_order?: number }) {
  if (input.id) {
    run('UPDATE doc_types SET name = ?, sort_order = COALESCE(?, sort_order) WHERE id = ?', [
      input.name,
      input.sort_order ?? null,
      input.id,
    ])
    return input.id
  }
  return run('INSERT INTO doc_types (name, sort_order) VALUES (?, ?)', [
    input.name,
    input.sort_order ?? 99,
  ])
}

export function deleteDocType(id: number) {
  const used = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM transactions WHERE doc_type_id = ?',
    [id],
  )
  const cnt = Number(used?.cnt ?? 0)
  if (cnt > 0) {
    throw new Error(`该单据类型仍被 ${cnt} 笔流水使用，请先修改这些流水后再删除`)
  }
  run('DELETE FROM doc_types WHERE id = ?', [id])
}

function signedAmount(type: TxType, amount: number) {
  const abs = Math.abs(amount)
  return type === '支出' ? -abs : abs
}

export function createTransaction(input: {
  date: string
  period_start?: string | null
  period_end?: string | null
  account_id: number
  category_id?: number | null
  type: TxType
  amount: number
  doc_type_id?: number | null
  note?: string | null
  checked?: boolean
}) {
  const amount = signedAmount(input.type, input.amount)
  const period = normalizePeriod(input.period_start, input.period_end)
  return run(
    `INSERT INTO transactions (date, period_start, period_end, account_id, category_id, type, amount, doc_type_id, note, checked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.date,
      period.period_start,
      period.period_end,
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

export function updateTransaction(
  id: number,
  input: {
    date: string
    period_start?: string | null
    period_end?: string | null
    account_id: number
    category_id?: number | null
    type: TxType
    amount: number
    doc_type_id?: number | null
    note?: string | null
    checked?: boolean
  },
) {
  const amount = signedAmount(input.type, input.amount)
  const period = normalizePeriod(input.period_start, input.period_end)
  run(
    `UPDATE transactions
     SET date = ?, period_start = ?, period_end = ?, account_id = ?, category_id = ?, type = ?, amount = ?, doc_type_id = ?, note = ?, checked = ?
     WHERE id = ?`,
    [
      input.date,
      period.period_start,
      period.period_end,
      input.account_id,
      input.category_id ?? null,
      input.type,
      amount,
      input.doc_type_id ?? null,
      input.note ?? null,
      input.checked ? 1 : 0,
      id,
    ],
  )
}

export function deleteTransaction(id: number) {
  run('DELETE FROM attachments WHERE transaction_id = ?', [id])
  run('DELETE FROM transactions WHERE id = ?', [id])
}

export function addAttachment(input: {
  transaction_id: number
  file_name: string
  stored_name: string
  mime_type?: string | null
}) {
  return run(
    `INSERT INTO attachments (transaction_id, file_name, stored_name, mime_type)
     VALUES (?, ?, ?, ?)`,
    [input.transaction_id, input.file_name, input.stored_name, input.mime_type ?? null],
  )
}

export function listAttachments(transactionId: number, limit?: number) {
  if (limit && limit > 0) {
    return queryAll<Attachment>(
      'SELECT * FROM attachments WHERE transaction_id = ? ORDER BY id LIMIT ?',
      [transactionId, limit],
    )
  }
  return queryAll<Attachment>(
    'SELECT * FROM attachments WHERE transaction_id = ? ORDER BY id',
    [transactionId],
  )
}

export function countAttachments(transactionId: number) {
  return Number(
    queryOne<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM attachments WHERE transaction_id = ?',
      [transactionId],
    )?.cnt ?? 0,
  )
}

export function getAttachment(id: number) {
  return queryOne<Attachment>('SELECT * FROM attachments WHERE id = ?', [id])
}

export function deleteAttachment(id: number) {
  const row = getAttachment(id)
  if (!row) return null
  run('DELETE FROM attachments WHERE id = ?', [id])
  return row
}

export function getOpeningBalanceTotal() {
  const row = queryOne<{ total: number }>(
    'SELECT COALESCE(SUM(opening_balance), 0) AS total FROM accounts WHERE active = 1 AND name != ?',
    ['月余额'],
  )
  return row?.total ?? 0
}

export interface TxQuery {
  year?: string
  month?: string // YYYY-MM 或 MM
  account_id?: number
  category_id?: number
  type?: TxType | ''
  keyword?: string
  page?: number
  pageSize?: number
  withAttachments?: boolean
  order?: 'asc' | 'desc'
}

function buildTxWhere(filters?: TxQuery) {
  const where: string[] = []
  const params: unknown[] = []

  if (filters?.month && /^\d{4}-\d{2}$/.test(filters.month)) {
    where.push("strftime('%Y-%m', t.date) = ?")
    params.push(filters.month)
  } else {
    if (filters?.year) {
      where.push("strftime('%Y', t.date) = ?")
      params.push(filters.year)
    }
    if (filters?.month && /^\d{1,2}$/.test(filters.month)) {
      where.push("strftime('%m', t.date) = ?")
      params.push(filters.month.padStart(2, '0'))
    }
  }

  if (filters?.account_id) {
    where.push('t.account_id = ?')
    params.push(filters.account_id)
  }
  if (filters?.category_id) {
    where.push('t.category_id = ?')
    params.push(filters.category_id)
  }
  if (filters?.type === '收入' || filters?.type === '支出') {
    where.push('t.type = ?')
    params.push(filters.type)
  }
  if (filters?.keyword?.trim()) {
    where.push(
      `(IFNULL(t.note, '') LIKE ? ESCAPE '\\' OR IFNULL(cat.name, '') LIKE ? ESCAPE '\\' OR IFNULL(a.name, '') LIKE ? ESCAPE '\\')`,
    )
    const kw = `%${escapeLike(filters.keyword.trim())}%`
    params.push(kw, kw, kw)
  }

  return { where, params }
}

const TX_SELECT = `
  SELECT
    t.id, t.date, t.period_start, t.period_end, t.account_id, a.name AS account_name,
    t.category_id, cat.name AS category_name,
    t.type, t.amount, t.doc_type_id, d.name AS doc_type_name,
    t.note, t.checked, t.created_at,
    (SELECT COUNT(*) FROM attachments att WHERE att.transaction_id = t.id) AS attachment_count
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories cat ON cat.id = t.category_id
  LEFT JOIN doc_types d ON d.id = t.doc_type_id
`

export function listTransactions(filters?: TxQuery) {
  const { where, params } = buildTxWhere(filters)
  const order = filters?.order === 'asc' ? 'ASC' : 'DESC'
  const sql = `
    ${TX_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.date ${order}, t.id ${order}
  `
  const rows = queryAll<TransactionRow>(sql, params)
  return rows.map((row) => ({
    ...row,
    amount: Number(row.amount),
    attachments: filters?.withAttachments === false ? [] : listAttachments(Number(row.id)),
  }))
}

export function queryTransactions(filters: TxQuery = {}) {
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 10))
  const { where, params } = buildTxWhere(filters)
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const countRow = queryOne<{ cnt: number }>(
    `
    SELECT COUNT(*) AS cnt
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories cat ON cat.id = t.category_id
    ${whereSql}
    `,
    params,
  )
  const total = Number(countRow?.cnt ?? 0)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const offset = (safePage - 1) * pageSize
  const order = filters.order === 'asc' ? 'ASC' : 'DESC'

  const rows = queryAll<TransactionRow>(
    `
    ${TX_SELECT}
    ${whereSql}
    ORDER BY t.date ${order}, t.id ${order}
    LIMIT ? OFFSET ?
    `,
    [...params, pageSize, offset],
  )

  const list = rows.map((row) => {
    const id = Number(row.id)
    const count = Number((row as TransactionRow & { attachment_count?: number }).attachment_count ?? 0)
    return {
      ...row,
      amount: Number(row.amount),
      attachment_count: count,
      // 列表只取前 3 张缩略图，详情再拉全量
      attachments: count > 0 ? listAttachments(id, 3) : [],
    }
  })

  const sumRow = queryOne<{ income: number; expense: number }>(
    `
    SELECT
      COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END), 0) AS expense
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories cat ON cat.id = t.category_id
    ${whereSql}
    `,
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

export function getTransactionById(id: number) {
  const row = queryOne<TransactionRow>(
    `
    ${TX_SELECT}
    WHERE t.id = ?
    `,
    [id],
  )
  if (!row) return null
  return {
    ...row,
    amount: Number(row.amount),
    attachments: listAttachments(Number(row.id)),
  }
}

export function withRunningBalance(
  rows: TransactionRow[],
  opts?: { month?: string },
): TransactionRow[] {
  const opening = getOpeningBalanceTotal()
  let balance = opening
  if (opts?.month && /^\d{4}-\d{2}$/.test(opts.month)) {
    const prior = queryOne<{ s: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE date < ?`,
      [`${opts.month}-01`],
    )
    balance = opening + Number(prior?.s ?? 0)
  }
  return rows.map((row) => {
    balance += Number(row.amount)
    return { ...row, balance }
  })
}

export function listTransactionsForExport(month: string) {
  const rows = listTransactions({ month, order: 'asc', withAttachments: true })
  return withRunningBalance(rows, { month })
}

export function findDuplicateTransaction(input: {
  date: string
  account_id: number
  amount: number
  note?: string | null
}) {
  return queryOne<{ id: number }>(
    `SELECT id FROM transactions
     WHERE date = ? AND account_id = ? AND amount = ?
       AND IFNULL(note, '') = IFNULL(?, '')
     LIMIT 1`,
    [input.date, input.account_id, input.amount, input.note ?? null],
  )
}

export function getYearsWithData() {
  return queryAll<{ year: string }>(
    `SELECT DISTINCT strftime('%Y', date) AS year FROM transactions ORDER BY year DESC`,
  )
}

export function getAccountSummary(month?: string) {
  const accounts = listAccounts().filter((a) => a.name !== '月余额')

  return accounts.map((acc) => {
    const periodParams: unknown[] = [acc.id]
    let periodFilter = ''
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      periodFilter = ` AND strftime('%Y-%m', date) = ?`
      periodParams.push(month)
    }

    const income = Number(
      queryOne<{ s: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
         WHERE account_id = ? AND amount > 0${periodFilter}`,
        periodParams,
      )?.s ?? 0,
    )
    const expense = Number(
      queryOne<{ s: number }>(
        `SELECT COALESCE(SUM(ABS(amount)), 0) AS s FROM transactions
         WHERE account_id = ? AND amount < 0${periodFilter}`,
        periodParams,
      )?.s ?? 0,
    )
    const net = income - expense

    // 期末余额 = 期初 + 截止该月末（或全部）的累计净变动
    const endParams: unknown[] = [acc.id]
    let endFilter = ''
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number)
      const next =
        m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
      endFilter = ' AND date < ?'
      endParams.push(next)
    }
    const cumulative = Number(
      queryOne<{ s: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
         WHERE account_id = ?${endFilter}`,
        endParams,
      )?.s ?? 0,
    )

    return {
      id: acc.id,
      name: acc.name,
      opening_balance: Number(acc.opening_balance),
      income,
      expense,
      net,
      current_balance: Number(acc.opening_balance) + cumulative,
    }
  })
}

export function getCategoryStats(month?: string) {
  const cats = listCategories()
  return cats.map((cat) => {
    let sql = `
      SELECT
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS expense,
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
        COUNT(*) AS cnt
      FROM transactions
      WHERE category_id = ?
    `
    const params: unknown[] = [cat.id]
    if (month) {
      sql += ` AND strftime('%Y-%m', date) = ?`
      params.push(month)
    }
    const row = queryOne<{ expense: number; income: number; cnt: number }>(sql, params)
    return {
      id: cat.id,
      name: cat.name,
      expense: Number(row?.expense ?? 0),
      income: Number(row?.income ?? 0),
      count: Number(row?.cnt ?? 0),
    }
  })
}

export function getMonthsWithData() {
  return queryAll<{ month: string }>(
    `SELECT DISTINCT strftime('%Y-%m', date) AS month FROM transactions ORDER BY month DESC`,
  )
}

export function countTransactions() {
  return Number(queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM transactions')?.c ?? 0)
}

export function findAccountByName(name: string) {
  return queryOne<Account>('SELECT * FROM accounts WHERE name = ?', [name])
}

export function findCategoryByName(name: string) {
  return queryOne<Category>('SELECT * FROM categories WHERE name = ?', [name])
}

export function findDocTypeByName(name: string) {
  return queryOne<DocType>('SELECT * FROM doc_types WHERE name = ?', [name])
}

export function clearLedgerData() {
  beginBulk()
  try {
    run('DELETE FROM attachments')
    run('DELETE FROM transactions')
    run('DELETE FROM categories')
    run('DELETE FROM doc_types')
    run('DELETE FROM accounts')
  } finally {
    endBulk()
  }
}

export function ensureAccount(
  name: string,
  opts?: { opening?: number; sortOrder?: number },
) {
  const existing = findAccountByName(name)
  if (existing) {
    if (opts?.opening != null && opts.opening !== Number(existing.opening_balance)) {
      run('UPDATE accounts SET opening_balance = ? WHERE id = ?', [opts.opening, existing.id])
    }
    return existing.id
  }
  return upsertAccount({
    name,
    opening_balance: opts?.opening ?? 0,
    sort_order: opts?.sortOrder ?? 99,
  })
}

export function ensureCategory(name: string, sortOrder = 99) {
  const existing = findCategoryByName(name)
  if (existing) return existing.id
  return upsertCategory({ name, sort_order: sortOrder })
}

export function ensureDocType(name: string, sortOrder = 99) {
  const existing = findDocTypeByName(name)
  if (existing) return existing.id
  return upsertDocType({ name, sort_order: sortOrder })
}

export function reseedIfEmpty() {
  seedDefaults()
}
