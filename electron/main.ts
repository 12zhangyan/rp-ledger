import { app, BrowserWindow, dialog, ipcMain, protocol, net, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { electronDir } from './dirname'
import {
  addAttachment,
  countTransactions,
  createTransaction,
  deleteAttachment,
  deleteCategory,
  deleteDocType,
  deleteTransaction,
  getAccountSummary,
  getCategoryStats,
  getMonthsWithData,
  getTransactionById,
  getYearsWithData,
  initDb,
  listAccounts,
  listAllAccounts,
  listAttachments,
  listCategories,
  listDocTypes,
  listTransactions,
  queryTransactions,
  updateTransaction,
  upsertAccount,
  upsertCategory,
  upsertDocType,
} from './db'
import { exportDateRangeToExcel, exportMonthToExcel } from './exportExcel'
import { exportReceiptFolders } from './exportReceipts'
import { importLedgerExcel } from './importExcel'
import { openPath, setupChineseMenu } from './menu'
import { getDataDir, getImagePath, getImagesDir, mimeForExt } from './paths'
import { validateDateRange } from './period'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null

type WindowState = {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
}

let windowSaveTimer: ReturnType<typeof setTimeout> | null = null

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

/** 保证标题栏至少落在某个显示器工作区内，避免恢复到屏外 */
function ensureOnScreen(state: WindowState): WindowState {
  const width = Math.max(1024, Number(state.width) || 1280)
  const height = Math.max(680, Number(state.height) || 840)
  const base: WindowState = { width, height, isMaximized: !!state.isMaximized }

  if (typeof state.x !== 'number' || typeof state.y !== 'number' || Number.isNaN(state.x) || Number.isNaN(state.y)) {
    return base
  }

  const probe = { x: state.x, y: state.y, width, height }
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const titleH = 48
    return (
      probe.x + probe.width > a.x + 40 &&
      probe.x < a.x + a.width - 40 &&
      probe.y + titleH > a.y &&
      probe.y < a.y + a.height - 40
    )
  })
  if (!visible) return base

  const area = screen.getDisplayMatching(probe).workArea
  const x = Math.min(Math.max(probe.x, area.x - width + 80), area.x + area.width - 80)
  const y = Math.min(Math.max(probe.y, area.y), area.y + area.height - 80)
  return { ...base, x, y }
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1280, height: 840 }
  try {
    const raw = fs.readFileSync(windowStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as WindowState
    return ensureOnScreen({
      ...fallback,
      ...parsed,
      width: Number(parsed.width) || fallback.width,
      height: Number(parsed.height) || fallback.height,
    })
  } catch {
    return fallback
  }
}

function saveWindowState(win: BrowserWindow) {
  try {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    }
    fs.writeFileSync(windowStatePath(), JSON.stringify(state), 'utf8')
  } catch {
    /* ignore */
  }
}

function scheduleSaveWindowState(win: BrowserWindow) {
  if (windowSaveTimer) clearTimeout(windowSaveTimer)
  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = null
    saveWindowState(win)
  }, 350)
}

function flushSaveWindowState(win: BrowserWindow) {
  if (windowSaveTimer) {
    clearTimeout(windowSaveTimer)
    windowSaveTimer = null
  }
  saveWindowState(win)
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ledger-img',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
])

function resolvePreloadPath() {
  const candidates = ['preload.cjs', 'preload.js', 'preload.mjs']
  for (const name of candidates) {
    const full = path.join(electronDir, name)
    if (fs.existsSync(full)) return full
  }
  return path.join(electronDir, 'preload.cjs')
}

function createWindow() {
  const preloadPath = resolvePreloadPath()
  console.log('[印尼盾记账] preload =', preloadPath)
  const state = loadWindowState()

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: '印尼盾记账',
    backgroundColor: '#FFF6F8',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (state.isMaximized) mainWindow?.maximize()
    mainWindow?.show()
  })

  mainWindow.on('resize', () => {
    if (mainWindow) scheduleSaveWindowState(mainWindow)
  })
  mainWindow.on('move', () => {
    if (mainWindow) scheduleSaveWindowState(mainWindow)
  })
  mainWindow.on('close', () => {
    if (mainWindow) flushSaveWindowState(mainWindow)
  })

  mainWindow.webContents.on('preload-error', (_event, preload, error) => {
    console.error('[印尼盾记账] preload 加载失败', preload, error)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents
      .executeJavaScript('typeof window.api')
      .then((t) => console.log('[印尼盾记账] window.api typeof =', t))
      .catch((err) => console.error('[印尼盾记账] 检查 api 失败', err))
  })

  if (isDev) {
    const url = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
    mainWindow.loadURL(url)
  } else {
    mainWindow.loadFile(path.join(electronDir, '../dist/index.html'))
  }
}

function registerIpc() {
  ipcMain.handle('accounts:list', () => listAccounts())
  ipcMain.handle('accounts:listAll', () => listAllAccounts())
  ipcMain.handle('accounts:upsert', (_e, input) => upsertAccount(input))

  ipcMain.handle('categories:list', () => listCategories())
  ipcMain.handle('categories:upsert', (_e, input) => upsertCategory(input))
  ipcMain.handle('categories:delete', (_e, id: number) => deleteCategory(id))

  ipcMain.handle('docTypes:list', () => listDocTypes())
  ipcMain.handle('docTypes:upsert', (_e, input) => upsertDocType(input))
  ipcMain.handle('docTypes:delete', (_e, id: number) => deleteDocType(id))

  ipcMain.handle('transactions:list', (_e, filters) => listTransactions(filters))
  ipcMain.handle('transactions:query', (_e, filters) => queryTransactions(filters))
  ipcMain.handle('transactions:get', (_e, id: number) => getTransactionById(id))
  ipcMain.handle('transactions:create', (_e, input) => createTransaction(input))
  ipcMain.handle('transactions:update', (_e, id: number, input) => updateTransaction(id, input))
  ipcMain.handle('transactions:delete', (_e, id: number) => {
    const files = listAttachments(id)
    deleteTransaction(id)
    for (const f of files) {
      const p = getImagePath(f.stored_name)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    return true
  })

  ipcMain.handle('stats:accounts', (_e, range?: string | { start?: string; end?: string; month?: string }) =>
    getAccountSummary(range),
  )
  ipcMain.handle(
    'stats:categories',
    (_e, range?: string | { start?: string; end?: string; month?: string }) => getCategoryStats(range),
  )
  ipcMain.handle('months:list', () => getMonthsWithData())
  ipcMain.handle('years:list', () => getYearsWithData())

  ipcMain.handle('attachments:add', async (_e, transactionId: number) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择凭证（图片或 PDF）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '凭证文件',
          extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'],
        },
        { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'PDF', extensions: ['pdf'] },
      ],
    })
    if (result.canceled || !result.filePaths.length) return []

    if (!getTransactionById(transactionId)) {
      throw new Error('流水不存在，无法添加凭证')
    }

    const allowed = ['.jpg', '.png', '.gif', '.webp', '.pdf']
    const saved = []
    for (const filePath of result.filePaths) {
      let ext = path.extname(filePath).toLowerCase() || '.jpg'
      if (ext === '.jpeg') ext = '.jpg'
      if (!allowed.includes(ext)) continue
      const stored = `${randomUUID()}${ext}`
      const dest = path.join(getImagesDir(), stored)
      fs.copyFileSync(filePath, dest)
      const mime = mimeForExt(ext)
      const id = addAttachment({
        transaction_id: transactionId,
        file_name: path.basename(filePath),
        stored_name: stored,
        mime_type: mime,
      })
      saved.push({
        id,
        transaction_id: transactionId,
        file_name: path.basename(filePath),
        stored_name: stored,
        mime_type: mime,
        url: `ledger-img://local/${stored}`,
      })
    }
    return saved
  })

  ipcMain.handle('attachments:delete', (_e, id: number) => {
    const row = deleteAttachment(id)
    if (row) {
      const p = getImagePath(row.stored_name)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    return true
  })

  ipcMain.handle('attachments:open', async (_e, storedName: string) => {
    const p = getImagePath(storedName)
    if (!fs.existsSync(p)) throw new Error('文件不存在')
    const err = await openPath(p)
    if (err) throw new Error(err)
    return true
  })

  ipcMain.handle('export:month', async (_e, month: string) => {
    const defaultName = `日记账_${month}.xlsx`
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出月度 Excel',
      defaultPath: defaultName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    })
    if (result.canceled || !result.filePath) return null
    return exportMonthToExcel(month, result.filePath)
  })

  ipcMain.handle('export:range', async (_e, range: { start: string; end: string }) => {
    const { start, end } = range || ({} as { start: string; end: string })
    validateDateRange(start, end)
    const defaultName = `日记账_${start}_至_${end}.xlsx`
    const e2eExportDir = process.env.RP_LEDGER_E2E_EXPORT_DIR
    if (e2eExportDir) {
      fs.mkdirSync(e2eExportDir, { recursive: true })
      return exportDateRangeToExcel(start, end, path.join(e2eExportDir, defaultName))
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出日期范围 Excel',
      defaultPath: defaultName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    })
    if (result.canceled || !result.filePath) return null
    return exportDateRangeToExcel(start, end, result.filePath)
  })

  ipcMain.handle('export:receipts', async (_e, month: string) => {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new Error('请选择有效的年份和月份')
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: `选择导出目录（分类 → 几号到几号）· ${month}`,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const targetDir = path.join(result.filePaths[0], `票据_${month}`)
    return exportReceiptFolders(month, targetDir)
  })

  ipcMain.handle('import:excel', async (_e, mode: 'merge' | 'replace' = 'merge') => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择要导入的旧版日记账 Excel',
      properties: ['openFile'],
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx', 'xlsm'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null

    if (mode === 'replace') {
      const confirm = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: '确认覆盖导入',
        message: '将清空当前全部账本数据后再导入，此操作不可撤销。',
        detail: '建议先导出备份。是否继续？',
        buttons: ['取消', '清空并导入'],
        defaultId: 0,
        cancelId: 0,
      })
      if (confirm.response !== 1) return null
    } else if (countTransactions() > 0) {
      const confirm = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        title: '合并导入',
        message: '将把 Excel 中的流水合并到现有账本。',
        detail: '支付方式 / 分类 / 期初余额会自动同步；相同「日期+账户+金额+备注」的流水会自动跳过。',
        buttons: ['取消', '开始导入'],
        defaultId: 1,
        cancelId: 0,
      })
      if (confirm.response !== 1) return null
    }

    try {
      return await importLedgerExcel(result.filePaths[0], mode)
    } catch (err) {
      await dialog.showMessageBox(mainWindow!, {
        type: 'error',
        title: '导入失败',
        message: '无法读取该 Excel，请确认是本软件支持的日记账格式。',
        detail: String(err),
        buttons: ['知道了'],
      })
      throw err
    }
  })

  ipcMain.handle('app:dataPath', () => getDataDir())
  ipcMain.handle('app:openDataFolder', async () => openPath(getDataDir()))
  ipcMain.handle('app:version', () => app.getVersion())
}

app.setName('印尼盾记账')

app.whenReady().then(async () => {
  app.setAppUserModelId('com.rpledger.app')

  protocol.handle('ledger-img', (request) => {
    try {
      const url = new URL(request.url)
      const stored = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const filePath = getImagePath(stored)
      // 仅允许图片经自定义协议展示；PDF 走 attachments:open
      const ext = path.extname(filePath).toLowerCase()
      if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        return new Response('Unsupported Media Type', { status: 415 })
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 })
      }
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })

  await initDb()
  registerIpc()
  setupChineseMenu(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
