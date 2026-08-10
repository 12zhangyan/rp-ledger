import fs from 'node:fs'
import path from 'node:path'
import { listTransactionsForExport } from './db'
import { getImagePath } from './paths'
import { buildReceiptFileName, categoryPathLabel, periodPathLabel } from './period'

export type ExportReceiptsResult = {
  folders: number
  files: number
  skipped: number
  skippedMissing: number
  skippedError: number
  targetDir: string
}

function uniquePath(dir: string, fileName: string): string {
  let dest = path.join(dir, fileName)
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let i = 2
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}_${i}${ext}`)
    i += 1
  }
  return dest
}

/**
 * 按报账年月筛选流水，结构：分类 / 几号到几号 / 图片与 PDF。
 * 例：票据_2026-08/交通费/7.3-7.24/xxx.pdf
 */
export function exportReceiptFolders(month: string, targetDir: string): ExportReceiptsResult {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('月份格式无效，应为 YYYY-MM')
  }

  const txs = listTransactionsForExport(month)
  const folderSet = new Set<string>()
  let files = 0
  let skippedMissing = 0
  let skippedError = 0
  let rootCreated = false

  for (const tx of txs) {
    if (!tx.attachments?.length) continue

    for (const att of tx.attachments) {
      try {
        const src = getImagePath(att.stored_name)
        if (!fs.existsSync(src)) {
          skippedMissing += 1
          continue
        }
        if (!rootCreated) {
          fs.mkdirSync(targetDir, { recursive: true })
          rootCreated = true
        }
        const catFolder = categoryPathLabel(tx.category_name)
        const periodFolder = periodPathLabel(tx.period_start, tx.period_end)
        const folderPath = path.join(targetDir, catFolder, periodFolder)
        fs.mkdirSync(folderPath, { recursive: true })
        folderSet.add(`${catFolder}/${periodFolder}`)

        const ext = path.extname(att.stored_name || att.file_name || '').toLowerCase() || '.bin'
        const fileName = buildReceiptFileName({
          date: tx.date,
          note: tx.note,
          amount: tx.amount,
          ext,
        })
        const dest = uniquePath(folderPath, fileName)
        fs.copyFileSync(src, dest)
        files += 1
      } catch (err) {
        skippedError += 1
        console.warn('[导出票据] 跳过附件', att.stored_name, err)
      }
    }
  }

  return {
    folders: folderSet.size,
    files,
    skipped: skippedMissing + skippedError,
    skippedMissing,
    skippedError,
    targetDir,
  }
}
