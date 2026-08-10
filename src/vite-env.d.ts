/// <reference types="vite/client" />

type TxType = '收入' | '支出'

interface TxQueryResult {
  list: any[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  income: number
  expense: number
}

interface TxInput {
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
}

interface LedgerApi {
  listAccounts: () => Promise<any[]>
  listAllAccounts: () => Promise<any[]>
  upsertAccount: (input: {
    id?: number
    name: string
    opening_balance: number
    sort_order?: number
    active?: number
  }) => Promise<number>
  listCategories: () => Promise<any[]>
  upsertCategory: (input: { id?: number; name: string; sort_order?: number }) => Promise<number>
  deleteCategory: (id: number) => Promise<void>
  listDocTypes: () => Promise<any[]>
  upsertDocType: (input: { id?: number; name: string; sort_order?: number }) => Promise<number>
  deleteDocType: (id: number) => Promise<void>
  listTransactions: (filters?: Record<string, unknown>) => Promise<any[]>
  queryTransactions: (filters?: Record<string, unknown>) => Promise<TxQueryResult>
  getTransaction: (id: number) => Promise<any | null>
  createTransaction: (input: TxInput) => Promise<number>
  updateTransaction: (id: number, input: TxInput) => Promise<void>
  deleteTransaction: (id: number) => Promise<boolean>
  getAccountSummary: (
    range?: string | { start?: string; end?: string; month?: string },
  ) => Promise<any[]>
  getCategoryStats: (
    range?: string | { start?: string; end?: string; month?: string },
  ) => Promise<any[]>
  listMonths: () => Promise<{ month: string }[]>
  listYears: () => Promise<{ year: string }[]>
  addAttachments: (transactionId: number) => Promise<any[]>
  deleteAttachment: (id: number) => Promise<boolean>
  openAttachment: (storedName: string) => Promise<boolean>
  exportMonth: (month: string) => Promise<{
    filePath: string
    skippedImages: number
  } | null>
  exportReceipts: (month: string) => Promise<{
    folders: number
    files: number
    skipped: number
    skippedMissing: number
    skippedError: number
    targetDir: string
  } | null>
  importExcel: (mode?: 'merge' | 'replace') => Promise<{
    mode: 'merge' | 'replace'
    accounts: number
    categories: number
    docTypes: number
    transactions: number
    images: number
    skipped: number
    duplicates: number
    fileName: string
  } | null>
  getDataPath: () => Promise<string>
  openDataFolder: () => Promise<string>
  getVersion: () => Promise<string>
  onMenu: (channel: string, handler: () => void) => () => void
}

declare global {
  interface Window {
    api: LedgerApi
  }
}

export {}
