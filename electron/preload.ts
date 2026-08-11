import { contextBridge, ipcRenderer } from 'electron'

export type TxType = '收入' | '支出'

const api = {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  listAllAccounts: () => ipcRenderer.invoke('accounts:listAll'),
  upsertAccount: (input: {
    id?: number
    name: string
    opening_balance: number
    sort_order?: number
    active?: number
  }) => ipcRenderer.invoke('accounts:upsert', input),

  listCategories: () => ipcRenderer.invoke('categories:list'),
  upsertCategory: (input: { id?: number; name: string; sort_order?: number }) =>
    ipcRenderer.invoke('categories:upsert', input),
  deleteCategory: (id: number) => ipcRenderer.invoke('categories:delete', id),

  listDocTypes: () => ipcRenderer.invoke('docTypes:list'),
  upsertDocType: (input: { id?: number; name: string; sort_order?: number }) =>
    ipcRenderer.invoke('docTypes:upsert', input),
  deleteDocType: (id: number) => ipcRenderer.invoke('docTypes:delete', id),

  listTransactions: (filters?: Record<string, unknown>) =>
    ipcRenderer.invoke('transactions:list', filters),
  queryTransactions: (filters?: Record<string, unknown>) =>
    ipcRenderer.invoke('transactions:query', filters),
  getTransaction: (id: number) => ipcRenderer.invoke('transactions:get', id),
  createTransaction: (input: {
    date: string
    period_start?: string | null
    period_end?: string | null
    account_id: number
    category_id?: number | null
    type: TxType
    amount: number
    doc_type_id?: number | null
    note?: string | null
    checked?: boolean
  }) => ipcRenderer.invoke('transactions:create', input),
  updateTransaction: (
    id: number,
    input: {
      date: string
      period_start?: string | null
      period_end?: string | null
      account_id: number
      category_id?: number | null
      type: TxType
      amount: number
      doc_type_id?: number | null
      note?: string | null
      checked?: boolean
    },
  ) => ipcRenderer.invoke('transactions:update', id, input),
  deleteTransaction: (id: number) => ipcRenderer.invoke('transactions:delete', id),

  getAccountSummary: (range?: string | { start?: string; end?: string; month?: string }) =>
    ipcRenderer.invoke('stats:accounts', range),
  getCategoryStats: (range?: string | { start?: string; end?: string; month?: string }) =>
    ipcRenderer.invoke('stats:categories', range),
  listMonths: () => ipcRenderer.invoke('months:list'),
  listYears: () => ipcRenderer.invoke('years:list'),

  addAttachments: (transactionId: number) =>
    ipcRenderer.invoke('attachments:add', transactionId),
  deleteAttachment: (id: number) => ipcRenderer.invoke('attachments:delete', id),
  openAttachment: (storedName: string) => ipcRenderer.invoke('attachments:open', storedName),

  exportMonth: (month: string) =>
    ipcRenderer.invoke('export:month', month) as Promise<{
      filePath: string
      skippedImages: number
    } | null>,
  exportRange: (range: { start: string; end: string }) =>
    ipcRenderer.invoke('export:range', range) as Promise<{
      filePath: string
      skippedImages: number
    } | null>,
  exportReceipts: (month: string) => ipcRenderer.invoke('export:receipts', month),
  exportReceiptsRange: (range: { start: string; end: string }) =>
    ipcRenderer.invoke('export:receipts-range', range),
  importExcel: (mode: 'merge' | 'replace' = 'merge') =>
    ipcRenderer.invoke('import:excel', mode),
  getDataPath: () => ipcRenderer.invoke('app:dataPath'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  getVersion: () => ipcRenderer.invoke('app:version'),

  onMenu: (channel: string, handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type LedgerApi = typeof api
