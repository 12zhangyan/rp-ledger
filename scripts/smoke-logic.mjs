/**
 * 轻量逻辑冒烟：余额累计、LIKE 转义、路径安全（不启动 Electron）
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function escapeLike(raw) {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function withRunningBalance(rows, opening = 0, prior = 0) {
  let balance = opening + prior
  return rows.map((row) => {
    balance += Number(row.amount)
    return { ...row, balance }
  })
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

// balance
const bal = withRunningBalance(
  [
    { amount: -100 },
    { amount: 50 },
    { amount: -20 },
  ],
  1000,
  0,
)
assert.equal(bal[0].balance, 900)
assert.equal(bal[1].balance, 950)
assert.equal(bal[2].balance, 930)

// like escape
assert.equal(escapeLike('100%'), '100\\%')
assert.equal(escapeLike('a_b'), 'a\\_b')

// path
assert.equal(safeStoredName('abc-123.png'), 'abc-123.png')
assert.throws(() => safeStoredName('../secret.txt'))
assert.throws(() => safeStoredName('a/b.png'))

// pageSize whitelist
function clampPageSize(n) {
  const v = Number(n)
  return v === 10 || v === 20 || v === 50 ? v : 10
}
assert.equal(clampPageSize(20), 20)
assert.equal(clampPageSize(3), 10)
assert.equal(clampPageSize('50'), 50)
assert.equal(clampPageSize('nope'), 10)

// 嵌套 localStorage 合并（与 src/lib/storage.ts 同策略）
function loadJsonMerge(fallback, parsed) {
  const out = { ...fallback, ...parsed }
  for (const k of Object.keys(fallback)) {
    const base = fallback[k]
    const next = parsed[k]
    if (
      base &&
      next &&
      typeof base === 'object' &&
      typeof next === 'object' &&
      !Array.isArray(base) &&
      !Array.isArray(next)
    ) {
      out[k] = { ...base, ...next }
    }
  }
  return out
}
const merged = loadJsonMerge(
  { query: { year: '2026', month: '', keyword: '' }, pageSize: 10 },
  { query: { month: '08' }, pageSize: 20 },
)
assert.equal(merged.pageSize, 20)
assert.equal(merged.query.year, '2026')
assert.equal(merged.query.month, '08')

// 请求序号：旧响应应被丢弃
let latest = 0
const results = []
function applyIfLatest(reqId, value) {
  if (reqId !== latest) return
  results.push(value)
}
latest = 1
applyIfLatest(1, 'a')
latest = 2
applyIfLatest(1, 'stale')
applyIfLatest(2, 'b')
assert.deepEqual(results, ['a', 'b'])

// sql.js：export 会清空 last_insert_rowid，插入后必须先取 id
{
  const { createRequire } = await import('node:module')
  const path = await import('node:path')
  const require = createRequire(import.meta.url)
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/sql.js/dist', f),
  })
  const db = new SQL.Database()
  db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)')
  db.run('INSERT INTO t (v) VALUES (1)')
  const before = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0])
  db.export()
  const after = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0])
  assert.equal(before, 1)
  assert.equal(after, 0)
  db.close()
}

// 业务期间（与 electron/period.ts 对齐）
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
assert.equal(formatPeriodFolder('2026-07-03', '2026-07-24'), '2026.7.3-7.24')
assert.equal(formatPeriodFolder('2026-07-24', '2026-07-03'), '2026.7.3-7.24')
assert.equal(formatPeriodFolder('2026-07-06', '2026-07-06'), '2026.7.6')
assert.equal(formatPeriodFolder(null, null), '未填期间')

function sanitizeFilePart(raw) {
  return String(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
}
assert.equal(sanitizeFilePart('油费.'), '油费')
assert.equal(sanitizeFilePart('a/b'), 'a_b')

function isValidYmd(ymd) {
  const parsed = parseYmd(ymd)
  if (!parsed) return false
  const date = new Date(Date.UTC(parsed.y, parsed.mo - 1, parsed.d))
  return (
    date.getUTCFullYear() === parsed.y &&
    date.getUTCMonth() + 1 === parsed.mo &&
    date.getUTCDate() === parsed.d
  )
}
function validateDateRange(start, end) {
  if (!isValidYmd(start) || !isValidYmd(end)) {
    throw new Error('请选择有效的开始日期和结束日期')
  }
  if (start > end) throw new Error('开始日期不能晚于结束日期')
  return { start, end }
}
assert.deepEqual(validateDateRange('2025-12-31', '2026-01-01'), {
  start: '2025-12-31',
  end: '2026-01-01',
})
assert.throws(() => validateDateRange('2026-02-31', '2026-03-01'))
assert.throws(() => validateDateRange('2026-08-02', '2026-08-01'))

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
assert.deepEqual(parsePeriodFolderText('2026.7.3-7.24'), {
  period_start: '2026-07-03',
  period_end: '2026-07-24',
})
assert.deepEqual(parsePeriodFolderText('2026.7.6'), {
  period_start: '2026-07-06',
  period_end: '2026-07-06',
})
assert.deepEqual(parsePeriodFolderText('7.3–7.24', '2026-08-01'), {
  period_start: '2026-07-03',
  period_end: '2026-07-24',
})
assert.deepEqual(parsePeriodFolderText('7.6', '2026-07-15'), {
  period_start: '2026-07-06',
  period_end: '2026-07-06',
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
assert.deepEqual(parsePeriodFolderText('7.3–7.24'), {
  period_start: null,
  period_end: null,
})
// skippedImages：去重 + 仅可嵌入格式失败才计数（webp 不计）
{
  const names = new Set()
  function noteSkip(stored, embeddable) {
    if (embeddable) names.add(stored)
  }
  noteSkip('a.png', true)
  noteSkip('a.png', true)
  noteSkip('b.webp', false)
  noteSkip('c.jpg', true)
  assert.equal(names.size, 2)
}

function formatAmountForFile(amount) {
  const abs = Math.abs(Number(amount) || 0)
  if (!Number.isFinite(abs)) return '0'
  if (Math.abs(abs - Math.round(abs)) < 1e-9) return String(Math.round(abs))
  return abs.toFixed(2).replace(/\.?0+$/, '').replace('.', '_')
}
assert.equal(formatAmountForFile(1204999), '1204999')
assert.equal(formatAmountForFile(12.5), '12_5')

// 表头映射：新版含业务期间
function mapDetailHeaders(headers) {
  const map = new Map(headers.map((h, i) => [h, i + 1]))
  const dateCol = map.get('报账日期') ?? map.get('日期')
  const accountCol = map.get('支付方式')
  const amountCol = map.get('金额')
  return { dateCol, accountCol, amountCol, periodCol: map.get('业务期间') ?? null }
}
const newLayout = mapDetailHeaders([
  '报账日期',
  '业务期间',
  '支付方式',
  '分类',
  '类型',
  '金额',
  '当前余额',
  '单据类型',
  '备注',
  '核对',
])
assert.equal(newLayout.dateCol, 1)
assert.equal(newLayout.periodCol, 2)
assert.equal(newLayout.accountCol, 3)
assert.equal(newLayout.amountCol, 6)
const oldLayout = mapDetailHeaders(['日期', '支付方式', '分类', '类型', '金额', '当前余额', '单据类型', '备注', '核对'])
assert.equal(oldLayout.dateCol, 1)
assert.equal(oldLayout.accountCol, 2)
assert.equal(oldLayout.amountCol, 5)
assert.equal(oldLayout.periodCol, null)

console.log('smoke-logic ok', fileURLToPath(import.meta.url))
