import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function getDataDir() {
  const dir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDbPath() {
  return path.join(getDataDir(), 'ledger.sqlite')
}

export function getImagesDir() {
  const dir = path.join(getDataDir(), 'images')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 仅允许 images 目录内的文件名，防止路径穿越 */
export function safeStoredName(storedName: string): string {
  const raw = String(storedName || '').replace(/\\/g, '/')
  const base = path.basename(raw)
  if (!base || base === '.' || base === '..' || base.includes('\0')) {
    throw new Error('非法图片文件名')
  }
  if (base !== raw && raw.includes('/')) {
    // 允许 ledger-img://local/xxx.png 这种仅文件名；拒绝含目录段
    if (raw.split('/').filter(Boolean).length > 1) {
      throw new Error('非法图片路径')
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error('非法图片文件名')
  }
  return base
}

export function getImagePath(storedName: string) {
  const base = safeStoredName(storedName)
  const dir = path.resolve(getImagesDir())
  const full = path.resolve(dir, base)
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error('非法图片路径')
  }
  return full
}

/** 导出可嵌入 Excel 的扩展名（PDF/webp 不嵌入） */
export function excelImageExt(fileName: string): 'jpeg' | 'png' | 'gif' | null {
  const ext = path.extname(fileName).toLowerCase().replace('.', '')
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'png') return 'png'
  if (ext === 'gif') return 'gif'
  return null
}

export function isPdfName(fileName: string) {
  return path.extname(fileName).toLowerCase() === '.pdf'
}

export function mimeForExt(ext: string) {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg'
  if (e === 'png') return 'image/png'
  if (e === 'gif') return 'image/gif'
  if (e === 'webp') return 'image/webp'
  if (e === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}
