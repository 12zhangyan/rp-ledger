import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  addAttachment,
  beginBulk,
  clearLedgerData,
  createTransaction,
  endBulk,
  ensureAccount,
  ensureCategory,
  ensureDocType,
  findDuplicateTransaction,
  reseedIfEmpty,
  type TxType,
} from './db'
import { parsePeriodFolderText } from './period'
import { excelImageExt, getImagesDir } from './paths'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs') as typeof import('exceljs')

export interface ImportResult {
  mode: 'merge' | 'replace'
  accounts: number
  categories: number
  docTypes: number
  transactions: number
  images: number
  skipped: number
  duplicates: number
  fileName: string
}

function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object' && value !== null && 'text' in (value as object)) {
    return String((value as { text: string }).text ?? '').trim()
  }
  if (typeof value === 'object' && value !== null && 'richText' in (value as object)) {
    const rt = (value as { richText: Array<{ text: string }> }).richText
    return rt.map((x) => x.text).join('').trim()
  }
  if (typeof value === 'object' && value !== null && 'result' in (value as object)) {
    return cellText((value as { result: unknown }).result)
  }
  return String(value).trim()
}

function cellNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && value !== null && 'result' in (value as object)) {
    return cellNumber((value as { result: unknown }).result)
  }
  const s = cellText(value).replace(/,/g, '').replace(/Rp/gi, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type DetailCols = {
  date: number
  period: number | null
  account: number
  category: number
  type: number
  amount: number
  doc: number
  note: number
  checked: number
}

function findDetailHeader(sheet: ExcelJS.Worksheet): { headerRow: number; cols: DetailCols } {
  const legacy: DetailCols = {
    date: 1,
    period: null,
    account: 2,
    category: 3,
    type: 4,
    amount: 5,
    doc: 7,
    note: 8,
    checked: 9,
  }
  for (let r = 1; r <= 12; r++) {
    const map = new Map<string, number>()
    for (let c = 1; c <= 16; c++) {
      const h = cellText(sheet.getCell(r, c).value)
      if (h) map.set(h, c)
    }
    const dateCol = map.get('报账日期') ?? map.get('日期')
    const accountCol = map.get('支付方式')
    const amountCol = map.get('金额')
    if (!dateCol || !accountCol || !amountCol) continue
    return {
      headerRow: r,
      cols: {
        date: dateCol,
        period: map.get('业务期间') ?? null,
        account: accountCol,
        category: map.get('分类') ?? accountCol + 1,
        type: map.get('类型') ?? amountCol - 1,
        amount: amountCol,
        doc: map.get('单据类型') ?? amountCol + 2,
        note: map.get('备注') ?? amountCol + 3,
        checked: map.get('核对') ?? amountCol + 4,
      },
    }
  }
  return { headerRow: 3, cols: legacy }
}

function findReceiptHeader(sheet: ExcelJS.Worksheet): {
  headerRow: number
  date: number
  account: number
  amount: number
} {
  for (let r = 1; r <= 12; r++) {
    const map = new Map<string, number>()
    for (let c = 1; c <= 10; c++) {
      const h = cellText(sheet.getCell(r, c).value)
      if (h) map.set(h, c)
    }
    const dateCol = map.get('报账日期') ?? map.get('日期')
    const accountCol = map.get('支付方式')
    const amountCol = map.get('金额')
    if (dateCol && accountCol && amountCol) {
      return { headerRow: r, date: dateCol, account: accountCol, amount: amountCol }
    }
  }
  // 旧版：日期 / 支付方式 / 金额
  return { headerRow: 3, date: 1, account: 2, amount: 3 }
}

function parseExcelDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel 序列日（以 1899-12-30 为起点）
    const utc = Date.UTC(1899, 11, 30) + Math.round(value * 86400) * 1000
    const dt = new Date(utc)
    const y = dt.getUTCFullYear()
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const d = String(dt.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const s = cellText(value)
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-')
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(s)) {
    const [y, m, d] = s.split(/[/\s]/)
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const [a, b, y] = s.split(/[/\s]/)
    // 默认按 月/日/年（Excel 常见），若日>12 则交换
    let month = Number(a)
    let day = Number(b)
    if (month > 12 && day <= 12) {
      ;[month, day] = [day, month]
    }
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return null
}

function isChecked(value: unknown): boolean {
  const s = cellText(value)
  return Boolean(s) && /✅|✔|✓|是|已核|true|1/i.test(s)
}

function normalizeType(value: unknown, amount: number): TxType {
  const s = cellText(value)
  if (s.includes('收入')) return '收入'
  if (s.includes('支出')) return '支出'
  return amount < 0 ? '支出' : '收入'
}

function sheetByNames(workbook: ExcelJS.Workbook, names: string[]) {
  for (const name of names) {
    const ws = workbook.getWorksheet(name)
    if (ws) return ws
  }
  // 模糊匹配
  for (const ws of workbook.worksheets) {
    if (names.some((n) => ws.name.includes(n))) return ws
  }
  return undefined
}

function saveImageBuffer(buffer: Buffer, ext: string, fileName: string) {
  const excelExt = excelImageExt(`x.${ext.replace(/^\./, '')}`)
  if (!excelExt) return null
  const normalized = excelExt === 'jpeg' ? '.jpg' : `.${excelExt}`
  const stored = `${randomUUID()}${normalized}`
  fs.writeFileSync(path.join(getImagesDir(), stored), buffer)
  return {
    stored,
    fileName,
    mime: `image/${normalized.replace('.', '')}`,
  }
}

function getWorkbookImage(
  workbook: ExcelJS.Workbook,
  imageId: number,
): { buffer: Buffer; extension: string } | null {
  try {
    const img = workbook.getImage(imageId) as {
      buffer?: Buffer | Uint8Array
      extension?: string
    }
    if (!img?.buffer) return null
    const buffer = Buffer.isBuffer(img.buffer) ? img.buffer : Buffer.from(img.buffer)
    return { buffer, extension: img.extension || 'png' }
  } catch {
    return null
  }
}

export async function importLedgerExcel(
  filePath: string,
  mode: 'merge' | 'replace' = 'merge',
): Promise<ImportResult> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  if (mode === 'replace') {
    // 清空图片目录与数据
    const imgDir = getImagesDir()
    for (const f of fs.readdirSync(imgDir)) {
      try {
        fs.unlinkSync(path.join(imgDir, f))
      } catch {
        /* ignore */
      }
    }
    clearLedgerData()
  }

  const result: ImportResult = {
    mode,
    accounts: 0,
    categories: 0,
    docTypes: 0,
    transactions: 0,
    images: 0,
    skipped: 0,
    duplicates: 0,
    fileName: path.basename(filePath),
  }

  beginBulk()
  try {
    // —— 设置 ——
    const settings = sheetByNames(workbook, ['设置'])
    if (settings) {
      for (let r = 2; r <= Math.max(settings.rowCount, 2); r++) {
        const acc = cellText(settings.getCell(r, 1).value)
        const cat = cellText(settings.getCell(r, 2).value)
        const doc = cellText(settings.getCell(r, 3).value)
        if (acc && acc !== '支付方式' && acc !== '合计') {
          ensureAccount(acc, { sortOrder: r })
          result.accounts++
        }
        if (cat && cat !== '分类') {
          ensureCategory(cat, r)
          result.categories++
        }
        if (doc && doc !== '单据类型') {
          ensureDocType(doc, r)
          result.docTypes++
        }
      }
    }

    // —— 账户期初 ——
    const summary = sheetByNames(workbook, ['账户汇总'])
    if (summary) {
      for (let r = 3; r <= Math.max(summary.rowCount, 3); r++) {
        const name = cellText(summary.getCell(r, 1).value)
        if (!name || name === '支付方式' || name === '合计' || name.includes('总账')) continue
        const opening = cellNumber(summary.getCell(r, 2).value) ?? 0
        ensureAccount(name, { opening, sortOrder: r })
        result.accounts++
      }
    }

    // —— 记账明细（兼容旧「日期」列布局与新「报账日期+业务期间」布局） ——
    const detail = sheetByNames(workbook, ['记账明细', '日记账'])
    const rowToTxId = new Map<number, number>()
    let detailCols: DetailCols | null = null

    if (detail) {
      const found = findDetailHeader(detail)
      const headerRow = found.headerRow
      detailCols = found.cols

      for (let r = headerRow + 1; r <= detail.rowCount; r++) {
        const accountName = cellText(detail.getCell(r, detailCols.account).value)
        const amount = cellNumber(detail.getCell(r, detailCols.amount).value)
        if (!accountName || amount == null) {
          if (accountName || amount != null) result.skipped++
          continue
        }
        const categoryName = cellText(detail.getCell(r, detailCols.category).value)
        // 月余额行跳过
        if (accountName === '月余额' || categoryName === '余额') {
          result.skipped++
          continue
        }

        const date = parseExcelDate(detail.getCell(r, detailCols.date).value)
        if (!date) {
          result.skipped++
          continue
        }

        const type = normalizeType(detail.getCell(r, detailCols.type).value, amount)
        const docName = cellText(detail.getCell(r, detailCols.doc).value)
        const note = cellText(detail.getCell(r, detailCols.note).value) || null
        const checked = isChecked(detail.getCell(r, detailCols.checked).value)
        const periodRaw = detailCols.period
          ? cellText(detail.getCell(r, detailCols.period).value)
          : ''
        // 短格式 7.3–7.24 用报账日期补年份
        const period = parsePeriodFolderText(periodRaw, date)

        const accountId = ensureAccount(accountName)
        const categoryId = categoryName ? ensureCategory(categoryName) : null
        const docTypeId = docName ? ensureDocType(docName) : null
        const signed = type === '支出' ? -Math.abs(amount) : Math.abs(amount)

        if (mode === 'merge') {
          const dup = findDuplicateTransaction({
            date,
            account_id: accountId,
            amount: signed,
            note,
          })
          if (dup?.id) {
            rowToTxId.set(r, Number(dup.id))
            result.duplicates++
            continue
          }
        }

        const txId = createTransaction({
          date,
          period_start: period.period_start,
          period_end: period.period_end,
          account_id: accountId,
          category_id: categoryId,
          type,
          amount,
          doc_type_id: docTypeId,
          note,
          checked,
        })
        rowToTxId.set(r, txId)
        result.transactions++
      }

      try {
        const images = (detail as ExcelJS.Worksheet & { getImages?: () => Array<{ imageId: string | number; range: { tl: { nativeRow: number } } }> }).getImages?.() || []
        for (const img of images) {
          const row = Math.floor(Number(img.range?.tl?.nativeRow ?? -1)) + 1
          const txId = rowToTxId.get(row)
          if (!txId) continue
          const media = getWorkbookImage(workbook, Number(img.imageId))
          if (!media) continue
          const saved = saveImageBuffer(media.buffer, media.extension, `明细_R${row}.${media.extension}`)
          if (!saved) continue
          addAttachment({
            transaction_id: txId,
            file_name: saved.fileName,
            stored_name: saved.stored,
            mime_type: saved.mime,
          })
          result.images++
        }
      } catch {
        /* 无图片也可 */
      }
    }

    // —— 凭证图片页 ——
    const receipts = sheetByNames(workbook, ['凭证图片'])
    if (receipts) {
      const receiptHeader = findReceiptHeader(receipts)
      const keyToTx = new Map<string, number>()
      if (detail && detailCols) {
        for (const [row, txId] of rowToTxId) {
          const date = parseExcelDate(detail.getCell(row, detailCols.date).value)
          const accountName = cellText(detail.getCell(row, detailCols.account).value)
          const amount = cellNumber(detail.getCell(row, detailCols.amount).value)
          if (date && accountName && amount != null) {
            keyToTx.set(`${date}|${accountName}|${amount}`, txId)
          }
        }
      }

      try {
        const images = (receipts as ExcelJS.Worksheet & { getImages?: () => Array<{ imageId: string | number; range: { tl: { nativeRow: number } } }> }).getImages?.() || []
        for (const img of images) {
          const row = Math.floor(Number(img.range?.tl?.nativeRow ?? -1)) + 1
          const date = parseExcelDate(receipts.getCell(row, receiptHeader.date).value)
          const accountName = cellText(receipts.getCell(row, receiptHeader.account).value)
          const amount = cellNumber(receipts.getCell(row, receiptHeader.amount).value)
          let txId =
            date && accountName && amount != null
              ? keyToTx.get(`${date}|${accountName}|${amount}`)
              : undefined

          if (!txId && date && amount != null) {
            for (const [k, id] of keyToTx) {
              if (k.startsWith(`${date}|`) && k.endsWith(`|${amount}`)) {
                txId = id
                break
              }
            }
          }
          if (!txId) continue

          const media = getWorkbookImage(workbook, Number(img.imageId))
          if (!media) continue
          const saved = saveImageBuffer(media.buffer, media.extension, `凭证_R${row}.${media.extension}`)
          if (!saved) continue
          addAttachment({
            transaction_id: txId,
            file_name: saved.fileName,
            stored_name: saved.stored,
            mime_type: saved.mime,
          })
          result.images++
        }
      } catch {
        /* ignore */
      }
    }

    reseedIfEmpty()
  } finally {
    endBulk()
  }

  return result
}
