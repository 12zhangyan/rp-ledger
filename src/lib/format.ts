/**
 * 印尼盾金额：账本常用样式
 * Rp -1,019,900.00（千分位 + 两位小数，符号在 Rp 后）
 */
export function formatRp(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return 'Rp 0.00'
  const n = Number(value)
  const neg = n < 0
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `Rp ${neg ? '-' : ''}${body}`
}

/** 纯数字（表格内更干净，列头已标明 Rp 时用） */
export function formatAmount(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '0.00'
  const n = Number(value)
  const neg = n < 0
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${neg ? '-' : ''}${body}`
}

export function currentMonth() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${d.getFullYear()}-${m}`
}

/** 2026-08 → 2026年8月 */
export function formatMonthLabel(month: string) {
  const [y, m] = month.split('-')
  if (!y || !m) return month
  return `${y}年${Number(m)}月`
}

export function attachmentUrl(storedName: string) {
  return `ledger-img://local/${encodeURIComponent(storedName)}`
}

function parseYmd(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
}

/** 列表短标签：7.3–7.24（与 electron/period.formatPeriodLabel 保持一致） */
export function formatPeriodLabel(start?: string | null, end?: string | null): string {
  if (!start && !end) return '-'
  let a = parseYmd(start || end || '')
  let b = parseYmd(end || start || '')
  if (!a || !b) return '-'
  const key = (p: { y: number; mo: number; d: number }) =>
    `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  if (key(a) > key(b)) [a, b] = [b, a]
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) return `${a.mo}.${a.d}`
  if (a.y === b.y) return `${a.mo}.${a.d}–${b.mo}.${b.d}`
  return `${a.y}.${a.mo}.${a.d}–${b.y}.${b.mo}.${b.d}`
}

export function isPdfAttachment(att: { mime_type?: string | null; stored_name?: string; file_name?: string }) {
  if (att.mime_type === 'application/pdf') return true
  const name = att.stored_name || att.file_name || ''
  return /\.pdf$/i.test(name)
}
