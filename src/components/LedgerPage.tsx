import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { friendlyError } from '../lib/errors'
import {
  attachmentUrl,
  currentMonth,
  formatAmount,
  formatPeriodLabel,
  formatRp,
  isPdfAttachment,
} from '../lib/format'
import { loadJson, saveJson } from '../lib/storage'
import type { Account, Attachment, Category, DocType, Transaction, TxType } from '../types'
import Icon from './Icon'

type QueryForm = {
  year: string
  month: string
  account_id: string
  category_id: string
  type: '' | TxType
  keyword: string
}

const PAGE_SIZES = [10, 20, 50] as const

function clampPageSize(n: unknown): number {
  const v = Number(n)
  return PAGE_SIZES.includes(v as (typeof PAGE_SIZES)[number]) ? v : 10
}

const emptyEdit = {
  date: new Date().toISOString().slice(0, 10),
  period_start: '',
  period_end: '',
  account_id: 0,
  category_id: 0,
  type: '支出' as TxType,
  amount: '',
  doc_type_id: 0,
  note: '',
  checked: false,
}

function currentYear() {
  return String(new Date().getFullYear())
}

const defaultQuery = (): QueryForm => ({
  year: currentYear(),
  month: '',
  account_id: '',
  category_id: '',
  type: '',
  keyword: '',
})

export default function LedgerPage({
  accounts,
  categories,
  docTypes,
  years,
  months,
  busy,
  setBusy,
  showToast,
  onOpenExport,
  onOpenExportReceipts,
  onMetaChange,
}: {
  accounts: Account[]
  categories: Category[]
  docTypes: DocType[]
  years: string[]
  months: string[]
  busy: boolean
  setBusy: (v: boolean) => void
  showToast: (msg: string) => void
  onOpenExport: (year?: string, month?: string) => void
  onOpenExportReceipts: (year?: string, month?: string) => void
  onMetaChange: () => Promise<void>
}) {
  const saved = useMemo(
    () =>
      loadJson('ledger-query', {
        query: defaultQuery(),
        pageSize: 10,
      }),
    [],
  )

  const [query, setQuery] = useState<QueryForm>({ ...defaultQuery(), ...saved.query })
  const [applied, setApplied] = useState<QueryForm>({ ...defaultQuery(), ...saved.query, keyword: saved.query?.keyword || '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => clampPageSize(saved.pageSize))
  const [jumpPage, setJumpPage] = useState('1')
  const [list, setList] = useState<Transaction[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [income, setIncome] = useState(0)
  const [expense, setExpense] = useState(0)
  const [loading, setLoading] = useState(false)
  const listReqId = useRef(0)

  const [detail, setDetail] = useState<Transaction | null>(null)
  const [preview, setPreview] = useState<{ url: string; att?: Attachment } | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyEdit)

  const payAccounts = useMemo(
    () => accounts.filter((a) => a.name !== '月余额'),
    [accounts],
  )

  const yearOptions = useMemo(() => {
    const set = new Set<string>([currentYear(), ...years])
    months.forEach((m) => set.add(m.slice(0, 4)))
    return Array.from(set).sort((a, b) => Number(b) - Number(a))
  }, [years, months])

  async function loadList(nextPage = page, nextApplied = applied, nextSize = pageSize) {
    const reqId = ++listReqId.current
    const size = clampPageSize(nextSize)
    setLoading(true)
    try {
      const result = await window.api.queryTransactions({
        year: nextApplied.year || undefined,
        month: nextApplied.month || undefined,
        account_id: nextApplied.account_id ? Number(nextApplied.account_id) : undefined,
        category_id: nextApplied.category_id ? Number(nextApplied.category_id) : undefined,
        type: nextApplied.type || undefined,
        keyword: nextApplied.keyword || undefined,
        page: nextPage,
        pageSize: size,
        order: 'desc',
      })
      if (reqId !== listReqId.current) return
      setList(result.list)
      setTotal(result.total)
      setPage(result.page)
      setPageSize(clampPageSize(result.pageSize))
      setTotalPages(result.totalPages)
      setIncome(result.income)
      setExpense(result.expense)
      setJumpPage(String(result.page))
    } catch (err) {
      if (reqId !== listReqId.current) return
      showToast(friendlyError(err))
    } finally {
      if (reqId === listReqId.current) setLoading(false)
    }
  }

  useEffect(() => {
    void loadList(1, applied, pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, pageSize])

  useEffect(() => {
    saveJson('ledger-query', { query: applied, pageSize: clampPageSize(pageSize) })
  }, [applied, pageSize])

  // Esc 关闭弹层（保存中不关表单）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (preview) {
        setPreview(null)
        return
      }
      if (formOpen) {
        if (!busy) setFormOpen(false)
        return
      }
      if (detail) setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, formOpen, detail, busy])

  function applyQuery(next: QueryForm) {
    setPage(1)
    setApplied(next)
  }

  function search() {
    applyQuery({ ...query })
  }

  function resetQuery() {
    const q = defaultQuery()
    setQuery(q)
    applyQuery(q)
  }

  function patchQuery(patch: Partial<QueryForm>, auto = false) {
    const next = { ...query, ...patch }
    setQuery(next)
    if (auto) applyQuery(next)
  }

  async function openDetail(id: number) {
    try {
      const row = await window.api.getTransaction(id)
      if (!row) {
        showToast('流水不存在或已删除')
        return
      }
      setDetail(row)
    } catch (err) {
      showToast(friendlyError(err))
    }
  }

  function openCreate() {
    setEditingId(null)
    setForm({
      ...emptyEdit,
      account_id: payAccounts[0]?.id || 0,
      category_id: categories[0]?.id || 0,
      doc_type_id: docTypes[0]?.id || 0,
    })
    setFormOpen(true)
  }

  function openEdit(tx: Transaction) {
    setEditingId(tx.id)
    setForm({
      date: tx.date,
      period_start: tx.period_start || '',
      period_end: tx.period_end || '',
      account_id: tx.account_id,
      category_id: tx.category_id || 0,
      type: tx.type,
      amount: String(Math.abs(tx.amount)),
      doc_type_id: tx.doc_type_id || 0,
      note: tx.note || '',
      checked: !!tx.checked,
    })
    setFormOpen(true)
  }

  async function openAttachment(att: Attachment) {
    try {
      if (isPdfAttachment(att)) {
        await window.api.openAttachment(att.stored_name)
        return
      }
      setPreview({ url: attachmentUrl(att.stored_name), att })
    } catch (err) {
      showToast(friendlyError(err))
    }
  }

  async function submitForm(e: FormEvent) {
    e.preventDefault()
    const amount = Number(String(form.amount).replace(/,/g, ''))
    if (!form.account_id || form.amount.trim() === '' || Number.isNaN(amount)) {
      showToast('请填写账户和金额')
      return
    }
    const payload = {
      date: form.date,
      period_start: form.period_start || null,
      period_end: form.period_end || null,
      account_id: form.account_id,
      category_id: form.category_id || null,
      type: form.type,
      amount,
      doc_type_id: form.doc_type_id || null,
      note: form.note || null,
      checked: form.checked,
    }
    setBusy(true)
    try {
      if (editingId) {
        await window.api.updateTransaction(editingId, payload)
        showToast('已保存修改')
        if (detail?.id === editingId) await openDetail(editingId)
      } else {
        const id = await window.api.createTransaction(payload)
        showToast('已新增流水，可继续导入凭证图片')
        await openDetail(id)
      }
      setFormOpen(false)
      await loadList(page, applied, pageSize)
      await onMetaChange()
    } catch (err) {
      showToast(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function removeTx(tx: Transaction) {
    const tip = `确认删除？\n${tx.date} · ${tx.account_name} · ${formatRp(tx.amount)}\n${tx.note || '无备注'}\n将同时删除凭证图片。`
    if (!confirm(tip)) return
    setBusy(true)
    try {
      await window.api.deleteTransaction(tx.id)
      if (detail?.id === tx.id) setDetail(null)
      showToast('已删除')
      await loadList(page, applied, pageSize)
      await onMetaChange()
    } catch (err) {
      showToast(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function addImages(txId: number) {
    try {
      const saved = await window.api.addAttachments(txId)
      if (saved?.length) {
        showToast(`已导入 ${saved.length} 个凭证（图片或 PDF）`)
        if (detail?.id === txId) await openDetail(txId)
        await loadList(page, applied, pageSize)
      }
    } catch (err) {
      showToast(friendlyError(err))
    }
  }

  async function removeImage(att: Attachment) {
    if (!confirm(`删除图片「${att.file_name}」？`)) return
    try {
      await window.api.deleteAttachment(att.id)
      showToast('已删除图片')
      if (preview?.att?.id === att.id) setPreview(null)
      if (detail) await openDetail(detail.id)
      await loadList(page, applied, pageSize)
    } catch (err) {
      showToast(friendlyError(err))
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制')
    } catch {
      showToast('复制失败')
    }
  }

  function goJump() {
    const n = Math.max(1, Math.min(totalPages, Number(jumpPage) || 1))
    void loadList(n)
  }

  const exportYear = applied.year || currentYear()
  const exportMonth =
    applied.month ||
    (currentMonth().startsWith(exportYear) ? currentMonth().slice(5) : '01')
  const net = income - expense
  const attCount = (tx: Transaction) =>
    Number(tx.attachment_count ?? tx.attachments?.length ?? 0)

  return (
    <>
      <div className="stats-grid">
        <div className="stat stat-income">
          <div className="stat-head">
            <span>筛选结果 · 收入</span>
            <span className="stat-glyph" aria-hidden="true">↗</span>
          </div>
          <strong className="amount-pos" title={formatRp(income)}>
            {formatRp(income)}
          </strong>
        </div>
        <div className="stat stat-expense">
          <div className="stat-head">
            <span>筛选结果 · 支出</span>
            <span className="stat-glyph" aria-hidden="true">↘</span>
          </div>
          <strong className="amount-neg" title={formatRp(expense)}>
            {formatRp(expense)}
          </strong>
        </div>
        <div className="stat stat-net">
          <div className="stat-head">
            <span>共 {total} 笔 · 净额</span>
            <span className="stat-glyph" aria-hidden="true">≈</span>
          </div>
          <strong className={net < 0 ? 'amount-neg' : 'amount-pos'} title={formatRp(net)}>
            {formatRp(net)}
          </strong>
        </div>
      </div>

      <div className="panel filter-panel">
        <div className="filter-head">
          <div>
            <strong>筛选流水</strong>
            <span>组合条件定位账目</span>
          </div>
          <span className="filter-status">{loading ? '读取中' : `共 ${total} 笔`}</span>
        </div>
        <div className="filter-grid">
          <div className="field">
            <label htmlFor="q-year">年份</label>
            <select
              id="q-year"
              value={query.year}
              onChange={(e) => patchQuery({ year: e.target.value }, true)}
            >
              <option value="">全部年份</option>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-month">月份</label>
            <select
              id="q-month"
              value={query.month}
              onChange={(e) => patchQuery({ month: e.target.value }, true)}
            >
              <option value="">全年</option>
              {Array.from({ length: 12 }, (_, i) => {
                const m = String(i + 1).padStart(2, '0')
                return (
                  <option key={m} value={m}>
                    {Number(m)}月
                  </option>
                )
              })}
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-account">支付方式</label>
            <select
              id="q-account"
              value={query.account_id}
              onChange={(e) => patchQuery({ account_id: e.target.value }, true)}
            >
              <option value="">全部</option>
              {payAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-cat">分类</label>
            <select
              id="q-cat"
              value={query.category_id}
              onChange={(e) => patchQuery({ category_id: e.target.value }, true)}
            >
              <option value="">全部</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-type">类型</label>
            <select
              id="q-type"
              value={query.type}
              onChange={(e) => patchQuery({ type: e.target.value as '' | TxType }, true)}
            >
              <option value="">全部</option>
              <option value="支出">支出</option>
              <option value="收入">收入</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="q-kw">关键词</label>
            <input
              id="q-kw"
              placeholder="备注 / 分类 / 账户"
              value={query.keyword}
              onChange={(e) => setQuery({ ...query, keyword: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
          </div>
          <div className="filter-actions">
            <button className="btn" type="button" disabled={busy || loading} onClick={search}>
              <Icon name="search" size={16} />
              查询
            </button>
            <button className="btn secondary" type="button" disabled={busy || loading} onClick={resetQuery}>
              <Icon name="reset" size={16} />
              重置
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={openCreate} aria-label="新增流水">
              <Icon name="add" size={16} />
              新增流水
            </button>
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={() => onOpenExport(exportYear, exportMonth)}
              aria-label="导出当前筛选年月 Excel"
            >
              <Icon name="export" size={16} />
              导出 Excel
            </button>
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={() => onOpenExportReceipts(exportYear, exportMonth)}
              aria-label="导出票据日期范围文件夹"
            >
              <Icon name="receipt" size={16} />
              导出票据
            </button>
            {loading && <span className="loading-dot">加载中…</span>}
          </div>
        </div>
      </div>

      <div className={`table-wrap panel ${loading ? 'is-loading' : ''}`}>
        {list.length === 0 && !loading ? (
          <div className="empty empty-ledger">
            <div className="empty-visual" aria-hidden="true">
              <Icon name="ledger" size={27} />
            </div>
            <div className="empty-title">还没有流水</div>
            <p>可以先「新增流水」，或从旧 Excel 导入日记账。</p>
            <div className="toolbar" style={{ justifyContent: 'center' }}>
              <button className="btn" type="button" onClick={openCreate}>
                新增一笔
              </button>
              <button className="btn secondary" type="button" onClick={resetQuery}>
                清空筛选
              </button>
            </div>
          </div>
        ) : (
          <table className="list-table">
            <colgroup>
              <col style={{ width: 100 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 72 }} />
              <col style={{ width: 64 }} />
              <col style={{ width: 130 }} />
              <col />
              <col style={{ width: 148 }} />
              <col style={{ width: 150 }} />
            </colgroup>
            <thead>
              <tr>
                <th>报账日期</th>
                <th>业务期间</th>
                <th>支付方式</th>
                <th>分类</th>
                <th>类型</th>
                <th className="col-num">金额 (Rp)</th>
                <th>备注</th>
                <th>凭证</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((tx) => (
                <tr
                  key={tx.id}
                  className="clickable-row"
                  onClick={() => void openDetail(tx.id)}
                  onDoubleClick={() => openEdit(tx)}
                  title="单击详情 · 双击编辑"
                >
                  <td>{tx.date}</td>
                  <td title={formatPeriodLabel(tx.period_start, tx.period_end)}>
                    {formatPeriodLabel(tx.period_start, tx.period_end)}
                  </td>
                  <td>{tx.account_name}</td>
                  <td>{tx.category_name || '-'}</td>
                  <td>
                    <span className={tx.type === '支出' ? 'tag tag-out' : 'tag tag-in'}>{tx.type}</span>
                  </td>
                  <td className={`col-num ${tx.amount < 0 ? 'amount-neg' : 'amount-pos'}`}>
                    {formatAmount(tx.amount)}
                  </td>
                  <td className="note-cell" title={tx.note || ''}>
                    {tx.note || '-'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row-voucher">
                      <div className="thumbs">
                        {(tx.attachments || []).slice(0, 3).map((att) => (
                          <div key={att.id} className="thumb-wrap">
                            {isPdfAttachment(att) ? (
                              <button
                                type="button"
                                className="pdf-thumb"
                                title={att.file_name}
                                onClick={() => void openAttachment(att)}
                              >
                                PDF
                              </button>
                            ) : (
                              <img
                                src={attachmentUrl(att.stored_name)}
                                alt={att.file_name}
                                title={att.file_name}
                                onClick={() => void openAttachment(att)}
                              />
                            )}
                            <button
                              type="button"
                              className="img-del"
                              title="删除凭证"
                              aria-label={`删除凭证 ${att.file_name}`}
                              disabled={busy}
                              onClick={() => void removeImage(att)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        {attCount(tx) > 3 && (
                          <span className="more-count">+{attCount(tx) - 3}</span>
                        )}
                        {attCount(tx) === 0 && <span className="muted-mini">无凭证</span>}
                      </div>
                      <button
                        type="button"
                        className="btn-upload-row"
                        disabled={busy}
                        aria-label={`为 ${tx.date} 导入凭证`}
                        onClick={() => void addImages(tx.id)}
                      >
                        导入凭证
                      </button>
                    </div>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="row-actions">
                      <button type="button" onClick={() => void openDetail(tx.id)}>
                        详情
                      </button>
                      <button type="button" onClick={() => openEdit(tx)}>
                        编辑
                      </button>
                      <button type="button" onClick={() => void removeTx(tx)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="pagination">
        <div className="pager-left">
          <div className="field" style={{ minWidth: 96 }}>
            <label htmlFor="page-size">每页</label>
            <select
              id="page-size"
              value={pageSize}
              onChange={(e) => {
                setPageSize(clampPageSize(e.target.value))
                setPage(1)
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} 条
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 110 }}>
            <label htmlFor="page-jump">跳到</label>
            <div className="jump-row">
              <input
                id="page-jump"
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && goJump()}
              />
              <button className="btn secondary" type="button" onClick={goJump}>
                Go
              </button>
            </div>
          </div>
        </div>
        <div className="pager-btns">
          <button
            className="btn secondary"
            type="button"
            disabled={busy || loading || page <= 1}
            onClick={() => void loadList(page - 1)}
          >
            上一页
          </button>
          <span>
            {page} / {totalPages}
          </span>
          <button
            className="btn secondary"
            type="button"
            disabled={busy || loading || page >= totalPages}
            onClick={() => void loadList(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal detail-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="detail-head">
              <div>
                <h3>流水详情</h3>
                <p>
                  {detail.date} · {detail.account_name} · {detail.type}
                </p>
              </div>
              <button className="btn secondary" type="button" onClick={() => setDetail(null)}>
                关闭 (Esc)
              </button>
            </div>

            <div className="detail-grid">
              <div>
                <label>报账日期</label>
                <strong>{detail.date}</strong>
              </div>
              <div>
                <label>业务期间（几号到几号）</label>
                <strong>{formatPeriodLabel(detail.period_start, detail.period_end)}</strong>
              </div>
              <div>
                <label>金额</label>
                <strong className={detail.amount < 0 ? 'amount-neg' : 'amount-pos'}>
                  {formatRp(detail.amount)}
                </strong>
              </div>
              <div>
                <label>分类</label>
                <strong>{detail.category_name || '-'}</strong>
              </div>
              <div>
                <label>单据类型</label>
                <strong>{detail.doc_type_name || '-'}</strong>
              </div>
              <div>
                <label>核对 / 录入时间</label>
                <strong>
                  {detail.checked ? '已核对' : '未核对'}
                  {detail.created_at ? ` · ${detail.created_at}` : ''}
                </strong>
              </div>
              <div className="span-2">
                <label>备注</label>
                <strong className="detail-note">
                  {detail.note || '无'}
                  {detail.note && (
                    <button type="button" className="link-btn" onClick={() => void copyText(detail.note || '')}>
                      复制
                    </button>
                  )}
                </strong>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-section-head">
                <h4>凭证（{detail.attachments?.length || 0}）</h4>
                <button className="btn secondary" type="button" onClick={() => void addImages(detail.id)}>
                  上传图片/PDF
                </button>
              </div>
              {!detail.attachments?.length ? (
                <div className="empty" style={{ padding: 18 }}>
                  暂无凭证。可上传小票照片或 PDF，导出时按分类与几号到几号归档。
                </div>
              ) : (
                <div className="detail-gallery">
                  {detail.attachments.map((att) => (
                    <div key={att.id} className="gallery-item">
                      <div className="gallery-img-wrap">
                        {isPdfAttachment(att) ? (
                          <button
                            type="button"
                            className="pdf-card"
                            title={att.file_name}
                            onClick={() => void openAttachment(att)}
                          >
                            <span>PDF</span>
                            <small>点击打开</small>
                          </button>
                        ) : (
                          <img
                            src={attachmentUrl(att.stored_name)}
                            alt={att.file_name}
                            onClick={() => void openAttachment(att)}
                          />
                        )}
                        <button
                          type="button"
                          className="img-del img-del-lg"
                          title="删除凭证"
                          aria-label={`删除凭证 ${att.file_name}`}
                          disabled={busy}
                          onClick={() => void removeImage(att)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="gallery-meta">
                        <span title={att.file_name}>{att.file_name}</span>
                        <button type="button" onClick={() => void removeImage(att)}>
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="toolbar" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button className="btn secondary" type="button" onClick={() => openEdit(detail)}>
                编辑
              </button>
              <button className="btn danger" type="button" onClick={() => void removeTx(detail)}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {formOpen && (
        <div className="modal-backdrop" onClick={() => !busy && setFormOpen(false)}>
          <div className="modal export-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 style={{ marginTop: 0 }}>{editingId ? '编辑流水' : '新增流水'}</h3>
            <form onSubmit={submitForm}>
              <div className="form-grid">
                <div className="field">
                  <label>报账日期</label>
                  <input
                    type="date"
                    required
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>业务期间起</label>
                  <input
                    type="date"
                    value={form.period_start}
                    onChange={(e) => setForm({ ...form, period_start: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>业务期间止</label>
                  <input
                    type="date"
                    value={form.period_end}
                    onChange={(e) => setForm({ ...form, period_end: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>支付方式</label>
                  <select
                    value={form.account_id}
                    onChange={(e) => setForm({ ...form, account_id: Number(e.target.value) })}
                  >
                    {payAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>分类</label>
                  <select
                    value={form.category_id}
                    onChange={(e) => setForm({ ...form, category_id: Number(e.target.value) })}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>类型</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as TxType })}
                  >
                    <option value="支出">支出</option>
                    <option value="收入">收入</option>
                  </select>
                </div>
                <div className="field">
                  <label>金额 (Rp)</label>
                  <input
                    required
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    placeholder="例如 150000"
                    inputMode="decimal"
                  />
                </div>
                <div className="field">
                  <label>单据类型</label>
                  <select
                    value={form.doc_type_id}
                    onChange={(e) => setForm({ ...form, doc_type_id: Number(e.target.value) })}
                  >
                    {docTypes.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field span-2">
                  <label>备注</label>
                  <input
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="商户 / 说明"
                  />
                </div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={form.checked}
                    onChange={(e) => setForm({ ...form, checked: e.target.checked })}
                  />
                  已核对
                </label>
              </div>
              <div className="toolbar" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
                <button className="btn secondary" type="button" onClick={() => setFormOpen(false)}>
                  取消
                </button>
                <button className="btn" disabled={busy} type="submit">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {preview && preview.att && !isPdfAttachment(preview.att) && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
              <strong>凭证预览</strong>
              <div className="toolbar" style={{ gap: 8 }}>
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void removeImage(preview.att!)}
                >
                  删除凭证
                </button>
                <button className="btn secondary" type="button" onClick={() => setPreview(null)}>
                  关闭 (Esc)
                </button>
              </div>
            </div>
            <div className="preview-img-wrap">
              <img src={preview.url} alt="凭证" />
              <button
                type="button"
                className="img-del img-del-lg"
                title="删除凭证"
                aria-label="删除当前预览凭证"
                disabled={busy}
                onClick={() => void removeImage(preview.att!)}
              >
                ×
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="hint-line">
        报账日期用于筛选和日期范围导出；导出票据为「日期范围 / 分类 / 几号到几号」。凭证支持图片与 PDF。
        当前：{applied.year ? `${applied.year}年` : '全部年份'}
        {applied.month ? ` · ${Number(applied.month)}月` : ' · 全年'}。
      </p>
    </>
  )
}
