import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs') as typeof import('exceljs')
import {
  getAccountSummary,
  getBalanceBeforeDate,
  getCategoryStats,
  listAccounts,
  listCategories,
  listDocTypes,
  listTransactionsForExportRange,
  type TransactionRow,
} from './db'
import {
  categoryPathLabel,
  formatDateRangeTitle,
  periodPathLabel,
  validateDateRange,
} from './period'
import { excelImageExt, getImagePath, isPdfName } from './paths'

/** Excel 工作表名：最多 31 字，禁 \ / ? * [ ] */
function excelSheetName(raw: string, used: Set<string>): string {
  let base = String(raw || '未分类')
    .replace(/[\\/*?:[\]]/g, '_')
    .trim()
    .slice(0, 31)
  if (!base) base = '未分类'
  let name = base
  let i = 2
  while (used.has(name)) {
    const suffix = `_${i}`
    name = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`
    i += 1
  }
  used.add(name)
  return name
}

function sortKey(tx: TransactionRow) {
  const cat = categoryPathLabel(tx.category_name)
  const period = periodPathLabel(tx.period_start, tx.period_end)
  return `${cat}\0${period}\0${tx.date}\0${String(tx.id).padStart(10, '0')}`
}

function sortTxs(txs: TransactionRow[]) {
  return [...txs].sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'zh-CN'))
}

const DETAIL_HEADERS = [
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
  '凭证',
]

function styleHeaderRow(sheet: ExcelJS.Worksheet, row: number, cols: number) {
  for (let i = 1; i <= cols; i++) {
    const cell = sheet.getCell(row, i)
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2F6F5E' },
    }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  }
}

function setDetailColumns(sheet: ExcelJS.Worksheet) {
  sheet.getColumn(1).width = 12
  sheet.getColumn(2).width = 14
  sheet.getColumn(3).width = 12
  sheet.getColumn(4).width = 12
  sheet.getColumn(5).width = 8
  sheet.getColumn(6).width = 16
  sheet.getColumn(7).width = 18
  sheet.getColumn(8).width = 12
  sheet.getColumn(9).width = 28
  sheet.getColumn(10).width = 8
  sheet.getColumn(11).width = 18
}

export type ExportExcelResult = {
  filePath: string
  skippedImages: number
}

export async function exportDateRangeToExcel(
  start: string,
  end: string,
  targetPath: string,
): Promise<ExportExcelResult> {
  validateDateRange(start, end)
  const rangeTitle = formatDateRangeTitle(start, end)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '印尼盾记账'
  workbook.created = new Date()
  const skippedImageNames = new Set<string>()
  const usedSheetNames = new Set<string>()

  const txs = sortTxs(listTransactionsForExportRange(start, end))
  const accounts = listAccounts()
  const categories = listCategories()
  const docTypes = listDocTypes()
  const summary = getAccountSummary({ start, end })
  const stats = getCategoryStats({ start, end })
  const opening = getBalanceBeforeDate(start)
  const accountNames = accounts.map((a) => a.name).filter((n) => n !== '月余额')

  async function embedFirstImage(sheet: ExcelJS.Worksheet, tx: TransactionRow, rowIdx: number) {
    const firstImg = tx.attachments?.find((a) => excelImageExt(a.stored_name))
    if (!firstImg) return
    try {
      const imgPath = getImagePath(firstImg.stored_name)
      const excelExt = excelImageExt(firstImg.stored_name)
      if (excelExt && fs.existsSync(imgPath)) {
        const imageId = workbook.addImage({
          filename: imgPath,
          extension: excelExt,
        })
        sheet.addImage(imageId, {
          tl: { col: 10.1, row: rowIdx - 1 + 0.1 },
          ext: { width: 96, height: 64 },
          editAs: 'oneCell',
        })
      } else {
        skippedImageNames.add(firstImg.stored_name)
      }
    } catch (err) {
      skippedImageNames.add(firstImg.stored_name)
      console.warn('[导出 Excel] 明细缩略图跳过', firstImg.stored_name, err)
    }
  }

  async function writeTxRow(sheet: ExcelJS.Worksheet, rowIdx: number, tx: TransactionRow) {
    const row = sheet.getRow(rowIdx)
    const hasImage = tx.attachments?.some((a) => excelImageExt(a.stored_name))
    row.height = hasImage ? 72 : 18
    const periodText = periodPathLabel(tx.period_start, tx.period_end)
    const attLabel = tx.attachments?.length
      ? tx.attachments.map((a) => (isPdfName(a.stored_name) ? 'PDF' : '图')).join('+')
      : ''
    row.values = [
      tx.date,
      periodText === '未填期间' ? '' : periodText,
      tx.account_name,
      tx.category_name ?? '',
      tx.type,
      tx.amount,
      tx.balance ?? 0,
      tx.doc_type_name ?? '',
      tx.note ?? '',
      tx.checked ? '✅️' : '',
      attLabel,
    ]
    sheet.getCell(rowIdx, 6).numFmt = '#,##0.00'
    sheet.getCell(rowIdx, 7).numFmt = '#,##0.00'
    if (tx.amount < 0) {
      sheet.getCell(rowIdx, 6).font = { color: { argb: 'FFB42318' } }
    } else if (tx.amount > 0) {
      sheet.getCell(rowIdx, 6).font = { color: { argb: 'FF067647' } }
    }
    await embedFirstImage(sheet, tx, rowIdx)
  }

  // —— 记账明细（完整清单，按 分类 → 几号到几号 排序，便于导入） ——
  const detail = workbook.addWorksheet(excelSheetName('记账明细', usedSheetNames), {
    views: [{ state: 'frozen', ySplit: 3 }],
  })
  detail.mergeCells('A1:K1')
  detail.getCell('A1').value = `日记账 · ${accountNames.join(' / ')} · ${rangeTitle}（按分类 → 几号到几号）`
  detail.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F4E3D' } }
  DETAIL_HEADERS.forEach((h, i) => {
    detail.getCell(3, i + 1).value = h
  })
  styleHeaderRow(detail, 3, DETAIL_HEADERS.length)
  setDetailColumns(detail)

  let rowIdx = 4
  detail.getRow(rowIdx).values = [
    start,
    '',
    '月余额',
    '余额',
    '收入',
    opening,
    opening,
    '',
    '期初余额',
    '',
    '',
  ]
  detail.getCell(rowIdx, 6).numFmt = '#,##0.00'
  detail.getCell(rowIdx, 7).numFmt = '#,##0.00'
  rowIdx++

  for (const tx of txs) {
    await writeTxRow(detail, rowIdx, tx)
    rowIdx++
  }

  // —— 各分类工作表：内按「几号到几号」分组 ——
  const byCategory = new Map<string, TransactionRow[]>()
  for (const tx of txs) {
    const key = categoryPathLabel(tx.category_name)
    const list = byCategory.get(key) || []
    list.push(tx)
    byCategory.set(key, list)
  }

  for (const [catName, catTxs] of byCategory) {
    const sheet = workbook.addWorksheet(excelSheetName(catName, usedSheetNames), {
      views: [{ state: 'frozen', ySplit: 3 }],
    })
    sheet.mergeCells('A1:K1')
    sheet.getCell('A1').value = `${rangeTitle} · ${catName}（按几号到几号分组）`
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F4E3D' } }
    DETAIL_HEADERS.forEach((h, i) => {
      sheet.getCell(3, i + 1).value = h
    })
    styleHeaderRow(sheet, 3, DETAIL_HEADERS.length)
    setDetailColumns(sheet)

    let r = 4
    let lastPeriod = ''
    for (const tx of catTxs) {
      const period = periodPathLabel(tx.period_start, tx.period_end)
      if (period !== lastPeriod) {
        lastPeriod = period
        sheet.mergeCells(r, 1, r, 11)
        const cell = sheet.getCell(r, 1)
        cell.value = `几号到几号：${period}`
        cell.font = { bold: true, color: { argb: 'FF1F4E3D' } }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE7F1EC' },
        }
        r += 1
      }
      await writeTxRow(sheet, r, tx)
      r += 1
    }
  }

  // —— 凭证图片（分类 → 几号到几号） ——
  const receiptSheet = workbook.addWorksheet(excelSheetName('凭证图片', usedSheetNames))
  receiptSheet.getCell('A1').value =
    `${rangeTitle} 凭证（按分类 → 几号到几号；图片嵌入 / PDF 仅列文件名）`
  receiptSheet.getCell('A1').font = { bold: true, size: 14 }
  receiptSheet.getColumn(1).width = 12
  receiptSheet.getColumn(2).width = 14
  receiptSheet.getColumn(3).width = 12
  receiptSheet.getColumn(4).width = 12
  receiptSheet.getColumn(5).width = 14
  receiptSheet.getColumn(6).width = 36
  receiptSheet.getColumn(7).width = 40
  ;['分类', '业务期间', '报账日期', '支付方式', '金额', '备注/文件', '预览'].forEach((h, i) => {
    const cell = receiptSheet.getCell(3, i + 1)
    cell.value = h
    cell.font = { bold: true }
  })

  let rIdx = 4
  let lastReceiptGroup = ''
  for (const tx of txs) {
    if (!tx.attachments?.length) continue
    const cat = categoryPathLabel(tx.category_name)
    const period = periodPathLabel(tx.period_start, tx.period_end)
    const groupKey = `${cat}/${period}`
    if (groupKey !== lastReceiptGroup) {
      lastReceiptGroup = groupKey
      receiptSheet.mergeCells(rIdx, 1, rIdx, 7)
      const cell = receiptSheet.getCell(rIdx, 1)
      cell.value = `${cat} / ${period}`
      cell.font = { bold: true, color: { argb: 'FF1F4E3D' } }
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE7F1EC' },
      }
      rIdx += 1
    }
    for (const att of tx.attachments) {
      const isPdf = isPdfName(att.stored_name)
      receiptSheet.getRow(rIdx).height = isPdf ? 22 : 120
      receiptSheet.getRow(rIdx).values = [
        cat,
        period,
        tx.date,
        tx.account_name,
        tx.amount,
        `${tx.note ?? ''} · ${att.file_name}${isPdf ? '（PDF）' : ''}`,
        isPdf ? path.basename(att.file_name) : '',
      ]
      receiptSheet.getCell(rIdx, 5).numFmt = '#,##0.00'
      const excelExt = !isPdf ? excelImageExt(att.stored_name) : null
      if (excelExt) {
        try {
          const imgPath = getImagePath(att.stored_name)
          if (fs.existsSync(imgPath)) {
            const imageId = workbook.addImage({
              filename: imgPath,
              extension: excelExt,
            })
            receiptSheet.addImage(imageId, {
              tl: { col: 6.05, row: rIdx - 1 + 0.05 },
              ext: { width: 180, height: 110 },
              editAs: 'oneCell',
            })
          } else {
            skippedImageNames.add(att.stored_name)
          }
        } catch (err) {
          skippedImageNames.add(att.stored_name)
          console.warn('[导出 Excel] 凭证图跳过', att.stored_name, err)
        }
      }
      rIdx += 1
    }
  }

  const sumSheet = workbook.addWorksheet(excelSheetName('账户汇总', usedSheetNames))
  sumSheet.getCell('A1').value = '账户余额汇总'
  sumSheet.getCell('A1').font = { bold: true, size: 14 }
  ;['支付方式', '期初余额', '本期收入', '本期支出', '净变动', '当前余额'].forEach((h, i) => {
    const cell = sumSheet.getCell(3, i + 1)
    cell.value = h
    cell.font = { bold: true }
  })
  summary.forEach((a, i) => {
    const r = 4 + i
    sumSheet.getRow(r).values = [
      a.name,
      a.opening_balance,
      a.income,
      a.expense,
      a.net,
      a.current_balance,
    ]
    for (let c = 2; c <= 6; c++) sumSheet.getCell(r, c).numFmt = '#,##0.00'
  })

  const setSheet = workbook.addWorksheet(excelSheetName('设置', usedSheetNames))
  setSheet.getCell('A1').value = '支付方式'
  setSheet.getCell('B1').value = '期初余额'
  accounts
    .filter((a) => a.name !== '月余额')
    .forEach((a, i) => {
      setSheet.getCell(i + 2, 1).value = a.name
      setSheet.getCell(i + 2, 2).value = a.opening_balance
      setSheet.getCell(i + 2, 2).numFmt = '#,##0.00'
    })
  setSheet.getCell('D1').value = '分类'
  categories.forEach((c, i) => {
    setSheet.getCell(i + 2, 4).value = c.name
  })
  setSheet.getCell('F1').value = '单据类型'
  docTypes.forEach((d, i) => {
    setSheet.getCell(i + 2, 6).value = d.name
  })

  const catSheet = workbook.addWorksheet(excelSheetName('分类统计', usedSheetNames))
  ;['分类', '支出合计', '收入合计', '笔数'].forEach((h, i) => {
    const cell = catSheet.getCell(1, i + 1)
    cell.value = h
    cell.font = { bold: true }
  })
  stats.forEach((s, i) => {
    const r = i + 2
    catSheet.getRow(r).values = [s.name, s.expense, s.income, s.count]
    catSheet.getCell(r, 2).numFmt = '#,##0.00'
    catSheet.getCell(r, 3).numFmt = '#,##0.00'
  })

  await workbook.xlsx.writeFile(targetPath)
  return { filePath: targetPath, skippedImages: skippedImageNames.size }
}

/** 保留旧按月接口，供已有调用兼容。 */
export function exportMonthToExcel(month: string, targetPath: string): Promise<ExportExcelResult> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('请选择有效的年份和月份')
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return exportDateRangeToExcel(
    `${month}-01`,
    `${month}-${String(lastDay).padStart(2, '0')}`,
    targetPath,
  )
}
