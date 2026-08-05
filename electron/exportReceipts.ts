import fs from 'node:fs'
import path from 'node:path'
import { listTransactionsForExport } from './db'
import { getImagePath } from './paths'
import { buildReceiptFileName, sanitizeFilePart } from './period'

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

function categoryFolderName(categoryName?: string | null): string {
  return sanitizeFilePart(categoryName || '') || '未分类'
}

/**
 * 按报账年月筛选流水，按「分类」建子文件夹，复制该月全部图片/PDF。
 * 例：票据_2026-08/交通费/…、票据_2026-08/生活费/…
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
        const folderName = categoryFolderName(tx.category_name)
        const folderPath = path.join(targetDir, folderName)
        fs.mkdirSync(folderPath, { recursive: true })
        folderSet.add(folderName)

        const ext = path.extname(att.stored_name || att.file_name || '').toLowerCase() || '.bin'
        // 分类已在文件夹名中，文件名带报账日 + 期间 + 备注 + 金额
        const fileName = buildReceiptFileName({
          date: tx.date,
          periodStart: tx.period_start,
          periodEnd: tx.period_end,
          note: tx.note,
          categoryName: null,
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
