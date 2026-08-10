/** 业务期间格式化、解析与导出文件名 */

function parseYmd(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
}

function pad2(n: number | string) {
  return String(n).padStart(2, '0')
}

function ymdKey(p: { y: number; mo: number; d: number }) {
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`
}

function orderPair(
  a: { y: number; mo: number; d: number },
  b: { y: number; mo: number; d: number },
) {
  return ymdKey(a) <= ymdKey(b) ? [a, b] : [b, a]
}

/** 文件夹名：2026.7.3-7.24 或单日 2026.7.6；无期间 → 未填期间 */
export function formatPeriodFolder(start?: string | null, end?: string | null): string {
  if (!start && !end) return '未填期间'
  let a = parseYmd(start || end || '')
  let b = parseYmd(end || start || '')
  if (!a || !b) return '未填期间'
  ;[a, b] = orderPair(a, b)
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) {
    return `${a.y}.${a.mo}.${a.d}`
  }
  if (a.y === b.y) {
    return `${a.y}.${a.mo}.${a.d}-${b.mo}.${b.d}`
  }
  return `${a.y}.${a.mo}.${a.d}-${b.y}.${b.mo}.${b.d}`
}

/** 列表短标签：7.3–7.24 */
export function formatPeriodLabel(start?: string | null, end?: string | null): string {
  if (!start && !end) return '-'
  let a = parseYmd(start || end || '')
  let b = parseYmd(end || start || '')
  if (!a || !b) return '-'
  ;[a, b] = orderPair(a, b)
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) {
    return `${a.mo}.${a.d}`
  }
  if (a.y === b.y) {
    return `${a.mo}.${a.d}–${b.mo}.${b.d}`
  }
  return `${a.y}.${a.mo}.${a.d}–${b.y}.${b.mo}.${b.d}`
}

/**
 * 解析期间文本（导出完整格式 + UI 短格式）。
 * yearHint：报账日期 YYYY-MM-DD，用于补全 `7.3–7.24` 的年份。
 */
export function parsePeriodFolderText(
  raw: string,
  yearHint?: string | null,
): { period_start: string | null; period_end: string | null } {
  const s0 = String(raw || '')
    .trim()
    .replace(/[\u2013\u2014]/g, '-') // en/em dash → -
  if (!s0 || s0 === '未填期间' || s0 === '-') {
    return { period_start: null, period_end: null }
  }

  const ordered = (start: string, end: string) =>
    start <= end
      ? { period_start: start, period_end: end }
      : { period_start: end, period_end: start }

  /** 仅年界附近（11–12 月 → 1–2 月）才推断跨年，避免 3.1–2.1 误判 */
  const looksLikeYearWrap = (mo1: number, mo2: number) => mo1 >= 11 && mo2 <= 2

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
    // 2026.12.28-1.3 → 2026-12-28 ~ 2027-01-03（年份挂在起始段）
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
      // 短格式：结束年=报账年，开始年=报账年-1（仅年界）
      // 例：12.28–1.3 + 2026 → 2025-12-28 ~ 2026-01-03
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

/** Windows 友好：去非法字符，并去掉尾部空格/点 */
export function sanitizeFilePart(raw: string): string {
  return String(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
}

/** 导出路径/分组用：分类名 → 未分类 */
export function categoryPathLabel(categoryName?: string | null): string {
  return sanitizeFilePart(categoryName || '') || '未分类'
}

/** 导出路径/分组用：几号到几号（7.3-7.24）；无期间 → 未填期间 */
export function periodPathLabel(start?: string | null, end?: string | null): string {
  const label = formatPeriodLabel(start, end).replace(/[\u2013\u2014]/g, '-')
  if (!label || label === '-') return '未填期间'
  return sanitizeFilePart(label) || '未填期间'
}

function formatAmountForFile(amount: number): string {
  const abs = Math.abs(Number(amount) || 0)
  if (!Number.isFinite(abs)) return '0'
  if (Math.abs(abs - Math.round(abs)) < 1e-9) return String(Math.round(abs))
  return abs.toFixed(2).replace(/\.?0+$/, '').replace('.', '_')
}

/** 2026-08-15 2026.7.3-7.24 grab打车 交通费 1204999.pdf */
export function buildReceiptFileName(opts: {
  date?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  note?: string | null
  categoryName?: string | null
  amount: number
  ext: string
}): string {
  const date = sanitizeFilePart(opts.date || '')
  // 仅在显式提供期间时写入文件名；都为空则省略（路径里已有「几号到几号」文件夹时用）
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
