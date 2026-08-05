export type TxType = '收入' | '支出'

export interface Account {
  id: number
  name: string
  opening_balance: number
  sort_order: number
  active: number
}

export interface Category {
  id: number
  name: string
  sort_order: number
}

export interface DocType {
  id: number
  name: string
  sort_order: number
}

export interface Attachment {
  id: number
  transaction_id: number
  file_name: string
  stored_name: string
  mime_type: string | null
  created_at: string
}

export interface Transaction {
  id: number
  date: string
  period_start?: string | null
  period_end?: string | null
  account_id: number
  account_name: string
  category_id: number | null
  category_name: string | null
  type: TxType
  amount: number
  doc_type_id: number | null
  doc_type_name: string | null
  note: string | null
  checked: number
  created_at: string
  balance?: number
  attachment_count?: number
  attachments?: Attachment[]
}

export interface AccountSummary {
  id: number
  name: string
  opening_balance: number
  income: number
  expense: number
  net: number
  current_balance: number
}

export interface CategoryStat {
  id: number
  name: string
  expense: number
  income: number
  count: number
}
