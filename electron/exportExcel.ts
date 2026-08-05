import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs') as typeof import('exceljs')
import {
  getAccountSummary,
  getCategoryStats,
  getOpeningBalanceTotal,
  listAccounts,
  listCategories,
  listDocTypes,
  listTransactionsForExport,
} from './db'
import { formatPeriodFolder } from './period'
import { excelImageExt, getImagePath, isPdfName } from './paths'

function formatMonthTitle(month: string) {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}

export type ExportExcelResult = {
  filePath: string
  skippedImages: number
}

export async function exportMonthToExcel(month: string, targetPath: string): Promise<ExportExcelResult> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '印尼盾记账'
  workbook.created = new Date()
  const skippedImageNames = new Set<string>()

  const txs = listTransactionsForExport(month)
  const accounts = listAccounts()
  const categories = listCategories()
  const docTypes = listDocTypes()
  const summary = getAccountSummary(month)
  const stats = getCategoryStats(month)
  const opening = getOpeningBalanceTotal()
  const accountNames = accounts.map((a) => a.name).filter((n) => n !== '月余额')

  const detail = workbook.addWorksheet('记账明细', {
    views: [{ state: 'frozen', ySplit: 3 }],
  })
  detail.mergeCells('A1:K1')
  detail.getCell('A1').value = `日记账 · ${accountNames.join(' / ')} · ${formatMonthTitle(month)}`
  detail.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F4E3D' } }

  const headers = [
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
  headers.forEach((h, i) => {
    const cell = detail.getCell(3, i + 1)
    cell.value = h
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2F6F5E' },
    }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  detail.getColumn(1).width = 12
  detail.getColumn(2).width = 14
  detail.getColumn(3).width = 12
  detail.getColumn(4).width = 12
  detail.getColumn(5).width = 8
  detail.getColumn(6).width = 16
  detail.getColumn(7).width = 18
  detail.getColumn(8).width = 12
  detail.getColumn(9).width = 28
  detail.getColumn(10).width = 8
  detail.getColumn(11).width = 18

  let rowIdx = 4
  detail.getRow(rowIdx).values = [
    `${month}-01`,
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
    const row = detail.getRow(rowIdx)
    const hasImage = tx.attachments?.some((a) => excelImageExt(a.stored_name))
    row.height = hasImage ? 72 : 18
    const periodText =
      tx.period_start || tx.period_end
        ? formatPeriodFolder(tx.period_start, tx.period_end)
        : ''
    const attLabel = tx.attachments?.length
      ? tx.attachments.map((a) => (isPdfName(a.stored_name) ? 'PDF' : '图')).join('+')
      : ''
    row.values = [
      tx.date,
      periodText,
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
    detail.getCell(rowIdx, 6).numFmt = '#,##0.00'
    detail.getCell(rowIdx, 7).numFmt = '#,##0.00'
    if (tx.amount < 0) {
      detail.getCell(rowIdx, 6).font = { color: { argb: 'FFB42318' } }
    } else if (tx.amount > 0) {
      detail.getCell(rowIdx, 6).font = { color: { argb: 'FF067647' } }
    }

    const firstImg = tx.attachments?.find((a) => excelImageExt(a.stored_name))
    if (firstImg) {
      try {
        const imgPath = getImagePath(firstImg.stored_name)
        const excelExt = excelImageExt(firstImg.stored_name)
        if (excelExt && fs.existsSync(imgPath)) {
          const imageId = workbook.addImage({
            filename: imgPath,
            extension: excelExt,
          })
          detail.addImage(imageId, {
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
    rowIdx++
  }

  const receiptSheet = workbook.addWorksheet('凭证图片')
  receiptSheet.getCell('A1').value = `${formatMonthTitle(month)} 凭证（图片嵌入 / PDF 仅列文件名）`
  receiptSheet.getCell('A1').font = { bold: true, size: 14 }
  receiptSheet.getColumn(1).width = 12
  receiptSheet.getColumn(2).width = 14
  receiptSheet.getColumn(3).width = 12
  receiptSheet.getColumn(4).width = 14
  receiptSheet.getColumn(5).width = 36
  receiptSheet.getColumn(6).width = 40
  ;['报账日期', '业务期间', '支付方式', '金额', '备注/文件', '预览'].forEach((h, i) => {
    const cell = receiptSheet.getCell(3, i + 1)
    cell.value = h
    cell.font = { bold: true }
  })

  let rIdx = 4
  for (const tx of txs) {
    if (!tx.attachments?.length) continue
    const periodText =
      tx.period_start || tx.period_end
        ? formatPeriodFolder(tx.period_start, tx.period_end)
        : ''
    for (const att of tx.attachments) {
      const isPdf = isPdfName(att.stored_name)
      receiptSheet.getRow(rIdx).height = isPdf ? 22 : 120
      receiptSheet.getRow(rIdx).values = [
        tx.date,
        periodText,
        tx.account_name,
        tx.amount,
        `${tx.note ?? ''} · ${att.file_name}${isPdf ? '（PDF）' : ''}`,
        isPdf ? path.basename(att.file_name) : '',
      ]
      receiptSheet.getCell(rIdx, 4).numFmt = '#,##0.00'
      // 仅统计「本可嵌入却失败」的 jpg/png/gif；webp/PDF 等为设计上不嵌入，不计 skipped
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
              tl: { col: 5.05, row: rIdx - 1 + 0.05 },
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
      rIdx++
    }
  }

  const sumSheet = workbook.addWorksheet('账户汇总')
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

  const setSheet = workbook.addWorksheet('设置')
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

  const catSheet = workbook.addWorksheet('分类统计')
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
