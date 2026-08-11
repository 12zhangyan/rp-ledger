import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import LedgerPage from './components/LedgerPage'
import Icon, { type IconName } from './components/Icon'
import { friendlyError } from './lib/errors'
import {
  currentMonth,
  formatAmount,
  formatDateRangeLabel,
  formatMonthLabel,
  formatPeriodLabel,
} from './lib/format'
import type { Account, AccountSummary, Category, CategoryStat, DocType } from './types'

type Tab = 'ledger' | 'accounts' | 'stats' | 'settings'

function monthBounds(month = currentMonth()) {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return {
    start: `${month}-01`,
    end: `${month}-${String(last).padStart(2, '0')}`,
  }
}

export default function App() {
  const initialBounds = monthBounds()
  const [tab, setTab] = useState<Tab>('ledger')
  const [viewStart, setViewStart] = useState(initialBounds.start)
  const [viewEnd, setViewEnd] = useState(initialBounds.end)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [docTypes, setDocTypes] = useState<DocType[]>([])
  const [summary, setSummary] = useState<AccountSummary[]>([])
  const [stats, setStats] = useState<CategoryStat[]>([])
  const [months, setMonths] = useState<string[]>([])
  const [years, setYears] = useState<string[]>([])
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportMode, setExportMode] = useState<'excel' | 'receipts'>('excel')
  const [exportStart, setExportStart] = useState(initialBounds.start)
  const [exportEnd, setExportEnd] = useState(initialBounds.end)
  const [exportCount, setExportCount] = useState<number | null>(null)
  const [appVersion, setAppVersion] = useState('')

  const apiReady = typeof window !== 'undefined' && !!window.api
  const exportRangeValid =
    /^\d{4}-\d{2}-\d{2}$/.test(exportStart) &&
    /^\d{4}-\d{2}-\d{2}$/.test(exportEnd) &&
    exportStart <= exportEnd
  const statsRange = useMemo(
    () => ({ start: viewStart || null, end: viewEnd || null }),
    [viewStart, viewEnd],
  )
  const rangeLabel = formatPeriodLabel(viewStart, viewEnd)
  const summaryTotal = useMemo(
    () =>
      summary.reduce(
        (acc, a) => ({
          opening_balance: acc.opening_balance + Number(a.opening_balance || 0),
          income: acc.income + Number(a.income || 0),
          expense: acc.expense + Number(a.expense || 0),
          net: acc.net + Number(a.net || 0),
          current_balance: acc.current_balance + Number(a.current_balance || 0),
        }),
        { opening_balance: 0, income: 0, expense: 0, net: 0, current_balance: 0 },
      ),
    [summary],
  )
  const statsTotal = useMemo(
    () =>
      stats.reduce(
        (acc, s) => ({
          expense: acc.expense + Number(s.expense || 0),
          income: acc.income + Number(s.income || 0),
          count: acc.count + Number(s.count || 0),
        }),
        { expense: 0, income: 0, count: 0 },
      ),
    [stats],
  )
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = window.setTimeout(() => {
      setToast('')
      toastTimer.current = null
    }, 3200)
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  async function refreshMeta() {
    if (!apiReady) return
    const [acc, cats, docs, monthList, yearList] = await Promise.all([
      window.api.listAccounts(),
      window.api.listCategories(),
      window.api.listDocTypes(),
      window.api.listMonths(),
      window.api.listYears(),
    ])
    setAccounts(acc)
    setCategories(cats)
    setDocTypes(docs)
    setMonths(monthList.map((m: { month: string }) => m.month))
    setYears(yearList.map((y: { year: string }) => y.year))
  }

  async function refreshStats(range = statsRange) {
    if (!apiReady) return
    const [sum, catStats] = await Promise.all([
      window.api.getAccountSummary(range),
      window.api.getCategoryStats(range),
    ])
    setSummary(sum)
    setStats(catStats)
  }

  useEffect(() => {
    if (!apiReady) return
    refreshMeta().catch((e) => showToast(friendlyError(e)))
    window.api.getVersion().then(setAppVersion).catch(() => setAppVersion(''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady])

  useEffect(() => {
    if (!apiReady) return
    if (tab === 'accounts' || tab === 'stats') {
      refreshStats(statsRange).catch((e) => showToast(friendlyError(e)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, viewStart, viewEnd, apiReady])

  useEffect(() => {
    if (!exportOpen || !apiReady) return
    if (!exportRangeValid) {
      setExportCount(null)
      return
    }
    let cancelled = false
    setExportCount(null)
    window.api
      .queryTransactions({ start: exportStart, end: exportEnd, page: 1, pageSize: 1 })
      .then((r) => {
        if (!cancelled) setExportCount(r.total)
      })
      .catch(() => {
        if (!cancelled) setExportCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [
    exportOpen,
    exportMode,
    exportStart,
    exportEnd,
    exportRangeValid,
    apiReady,
  ])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && exportOpen && !busy) setExportOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exportOpen, busy])

  useEffect(() => {
    if (!apiReady) return
    const offs = [
      window.api.onMenu('menu:import-excel', () => {
        void importExcel('merge')
      }),
      window.api.onMenu('menu:export-month', () => {
        openExportDialog(undefined, undefined, 'excel')
      }),
      window.api.onMenu('menu:export-receipts', () => {
        openExportDialog(undefined, undefined, 'receipts')
      }),
      window.api.onMenu('menu:open-data', () => {
        void window.api.openDataFolder()
      }),
      window.api.onMenu('menu:about', () => {
        void showAbout()
      }),
    ]
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady])

  async function showAbout() {
    const ver = await window.api.getVersion()
    alert(
      `印尼盾记账\n版本 ${ver}\n\n本地账本软件，数据保存在本机，货币单位为印尼盾（Rp）。\n支持报账日期、业务期间、图片/PDF 凭证；导出票据按「日期范围 / 分类 / 几号到几号」分文件夹。`,
    )
  }

  function openExportDialog(
    year?: string,
    month?: string,
    mode: 'excel' | 'receipts' = 'excel',
  ) {
    const selectedMonth = year && month ? `${year}-${month}` : currentMonth()
    const bounds = monthBounds(selectedMonth)
    setExportMode(mode)
    setExportStart(bounds.start)
    setExportEnd(bounds.end)
    setExportOpen(true)
  }

  async function confirmExport() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exportStart) || !/^\d{4}-\d{2}-\d{2}$/.test(exportEnd)) {
      showToast('请选择有效的开始日期和结束日期')
      return
    }
    if (exportStart > exportEnd) {
      showToast('开始日期不能晚于结束日期')
      return
    }
    setBusy(true)
    try {
      if (exportMode === 'receipts') {
        const result = await window.api.exportReceiptsRange({ start: exportStart, end: exportEnd })
        if (result) {
          setExportOpen(false)
          if (result.files === 0) {
            const why =
              result.skippedMissing || result.skippedError
                ? `（缺失 ${result.skippedMissing || 0}，失败 ${result.skippedError || 0}）`
                : ''
            showToast(
              result.skipped > 0
                ? `未导出任何文件${why}`
                : '所选日期范围没有可导出的凭证文件',
            )
          } else {
            const parts: string[] = []
            if (result.skippedMissing) parts.push(`缺失 ${result.skippedMissing}`)
            if (result.skippedError) parts.push(`失败 ${result.skippedError}`)
            const skipTip = parts.length ? `，跳过：${parts.join('、')}` : ''
            showToast(
              `已导出 ${result.files} 个文件到 ${result.folders} 个期间文件夹${skipTip}：${result.targetDir}`,
            )
          }
        }
      } else {
        const file = await window.api.exportRange({ start: exportStart, end: exportEnd })
        if (file) {
          setExportOpen(false)
          const skipTip =
            file.skippedImages > 0 ? `（${file.skippedImages} 张凭证图未能嵌入）` : ''
          showToast(
            `已导出 ${formatDateRangeLabel(exportStart, exportEnd)}${skipTip}：${file.filePath}`,
          )
        }
      }
    } catch (err) {
      showToast(`导出失败：${friendlyError(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function importExcel(mode: 'merge' | 'replace' = 'merge') {
    setBusy(true)
    try {
      const result = await window.api.importExcel(mode)
      if (!result) {
        showToast('已取消导入')
        return
      }
      await refreshMeta()
      const monthList = await window.api.listMonths()
      if (monthList[0]?.month) setViewMonth(monthList[0].month)
      alert(
        `导入完成：${result.fileName}\n\n` +
          `方式：${result.mode === 'replace' ? '清空后导入' : '合并导入'}\n` +
          `流水 ${result.transactions} 笔\n` +
          `凭证图片 ${result.images} 张\n` +
          `重复跳过 ${result.duplicates || 0} 笔\n` +
          `其他跳过 ${result.skipped} 行`,
      )
      showToast(`已导入 ${result.transactions} 笔流水`)
      setTab('ledger')
    } catch (err) {
      showToast(`导入失败：${friendlyError(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function saveAccount(acc: Account, opening: string) {
    await window.api.upsertAccount({
      id: acc.id,
      name: acc.name,
      opening_balance: Number(opening) || 0,
      sort_order: acc.sort_order,
      active: acc.active,
    })
    showToast('账户已保存')
    await refreshMeta()
    await refreshStats(statsRange)
  }

  async function addNamed(kind: 'account' | 'category' | 'doc', name: string) {
    const n = name.trim()
    if (!n) return
    if (kind === 'account') await window.api.upsertAccount({ name: n, opening_balance: 0 })
    if (kind === 'category') await window.api.upsertCategory({ name: n })
    if (kind === 'doc') await window.api.upsertDocType({ name: n })
    showToast('已添加')
    await refreshMeta()
  }

  if (!apiReady) {
    return (
      <div className="main">
        <div className="panel empty">
          <p style={{ marginTop: 0, fontSize: 18, fontWeight: 600 }}>桌面接口未就绪</p>
          <p>请执行 <code>npm run dev</code>，使用弹出的「印尼盾记账」窗口，不要用浏览器打开。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-emblem" aria-hidden="true">Rp</div>
          <div>
            <div className="brand-mark">印尼盾记账</div>
            <div className="brand-sub">LOCAL LEDGER · IDR</div>
          </div>
        </div>
        <nav className="nav">
          {(
            [
              ['ledger', '记账明细', 'ledger'],
              ['accounts', '账户汇总', 'accounts'],
              ['stats', '分类统计', 'stats'],
              ['settings', '设置', 'settings'],
            ] as const
          ).map(([key, label, icon]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              <Icon name={icon as IconName} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="side-actions">
          <div className="side-label">数据工具</div>
          <button className="btn ghost" disabled={busy} type="button" onClick={() => importExcel('merge')}>
            <Icon name="import" size={16} />
            从旧 Excel 导入
          </button>
          <button
            className="btn secondary"
            disabled={busy}
            type="button"
            onClick={() => openExportDialog(undefined, undefined, 'excel')}
          >
            <Icon name="export" size={16} />
            导出 Excel
          </button>
          <button
            className="btn secondary"
            disabled={busy}
            type="button"
            onClick={() => openExportDialog(undefined, undefined, 'receipts')}
          >
            <Icon name="receipt" size={16} />
            导出票据文件夹
          </button>
          {appVersion && <div className="version-pill">v{appVersion}</div>}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="page-heading">
            <div className="page-kicker">WORKSPACE · 本地账本</div>
            <h1>
              {tab === 'ledger' && '记账明细'}
              {tab === 'accounts' && '账户汇总'}
              {tab === 'stats' && '分类统计'}
              {tab === 'settings' && '设置'}
            </h1>
            <p>
              {tab === 'ledger'
                ? '报账日期 · 业务期间 · 图片/PDF 凭证 · 按分类与几号到几号导出'
                : `汇总区间 ${rangeLabel === '-' ? '全部' : rangeLabel}`}
            </p>
          </div>
          <div className="toolbar">
            {(tab === 'accounts' || tab === 'stats') && (
              <>
                <div className="field">
                  <label>几号起</label>
                  <input
                    type="date"
                    value={viewStart}
                    onChange={(e) => setViewStart(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>几号止</label>
                  <input type="date" value={viewEnd} onChange={(e) => setViewEnd(e.target.value)} />
                </div>
              </>
            )}
            <button className="btn secondary" disabled={busy} onClick={() => importExcel('merge')}>
              <Icon name="import" size={16} />
              导入
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => openExportDialog(undefined, undefined, 'excel')}
            >
              <Icon name="export" size={16} />
              导出
            </button>
          </div>
        </div>

        {tab === 'ledger' && (
          <LedgerPage
            accounts={accounts}
            categories={categories}
            docTypes={docTypes}
            years={years}
            months={months}
            busy={busy}
            setBusy={setBusy}
            showToast={showToast}
            onOpenExport={(y, m) => openExportDialog(y, m, 'excel')}
            onOpenExportReceipts={(y, m) => openExportDialog(y, m, 'receipts')}
            onMetaChange={refreshMeta}
          />
        )}

        {tab === 'accounts' && (
          <div className="table-wrap panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>支付方式</th>
                  <th className="col-num">期初余额</th>
                  <th className="col-num">本期收入</th>
                  <th className="col-num">本期支出</th>
                  <th className="col-num">净变动</th>
                  <th className="col-num">当前余额</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td className="col-num amount-muted">{formatAmount(a.opening_balance)}</td>
                    <td className="col-num amount-pos">{formatAmount(a.income)}</td>
                    <td className="col-num amount-neg">{formatAmount(a.expense)}</td>
                    <td className={`col-num ${a.net < 0 ? 'amount-neg' : 'amount-pos'}`}>
                      {formatAmount(a.net)}
                    </td>
                    <td className="col-num num">{formatAmount(a.current_balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <td>合计</td>
                  <td className="col-num amount-muted">{formatAmount(summaryTotal.opening_balance)}</td>
                  <td className="col-num amount-pos">{formatAmount(summaryTotal.income)}</td>
                  <td className="col-num amount-neg">{formatAmount(summaryTotal.expense)}</td>
                  <td
                    className={`col-num ${summaryTotal.net < 0 ? 'amount-neg' : 'amount-pos'}`}
                  >
                    {formatAmount(summaryTotal.net)}
                  </td>
                  <td className="col-num num">{formatAmount(summaryTotal.current_balance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {tab === 'stats' && (
          <div className="table-wrap panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>分类</th>
                  <th className="col-num">支出合计</th>
                  <th className="col-num">收入合计</th>
                  <th className="col-num">笔数</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="col-num amount-neg">{formatAmount(s.expense)}</td>
                    <td className="col-num amount-pos">{formatAmount(s.income)}</td>
                    <td className="col-num num">{s.count}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <td>合计</td>
                  <td className="col-num amount-neg">{formatAmount(statsTotal.expense)}</td>
                  <td className="col-num amount-pos">{formatAmount(statsTotal.income)}</td>
                  <td className="col-num num">{statsTotal.count}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {tab === 'settings' && (
          <>
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="settings-about">
                <div>
                  <h3 style={{ marginTop: 0, marginBottom: 6 }}>数据与备份</h3>
                  <p style={{ color: 'var(--muted)', margin: 0 }}>
                    支持原「日记账_新版」格式。合并导入会自动跳过重复流水；清空后导入不可撤销。
                  </p>
                </div>
                {appVersion && <span className="version-pill">印尼盾记账 v{appVersion}</span>}
              </div>
              <div className="toolbar" style={{ marginTop: 14 }}>
                <button className="btn" disabled={busy} type="button" onClick={() => importExcel('merge')}>
                  合并导入
                </button>
                <button
                  className="btn danger"
                  disabled={busy}
                  type="button"
                  onClick={() => importExcel('replace')}
                >
                  清空后导入
                </button>
                <button className="btn secondary" type="button" onClick={() => window.api.openDataFolder()}>
                  打开数据文件夹
                </button>
                <button className="btn ghost" type="button" onClick={() => void showAbout()}>
                  关于
                </button>
              </div>
            </div>
            <div className="settings-cols">
              <SettingsList
                title="支付方式 / 期初余额"
                hint="期初余额用于推算当前余额；失焦或点保存生效"
                items={accounts.filter((a) => a.name !== '月余额')}
                renderItem={(a: Account) => (
                  <AccountEditor key={a.id} account={a} onSave={saveAccount} />
                )}
                onAdd={(name) => addNamed('account', name)}
              />
              <SettingsList
                title="分类"
                hint="已被流水引用的分类无法删除"
                items={categories}
                renderItem={(c: Category) => (
                  <div className="item" key={c.id}>
                    <input
                      defaultValue={c.name}
                      aria-label={`分类 ${c.name}`}
                      onBlur={async (e) => {
                        if (e.target.value.trim() && e.target.value !== c.name) {
                          await window.api.upsertCategory({ id: c.id, name: e.target.value.trim() })
                          showToast('分类已更新')
                          await refreshMeta()
                        }
                      }}
                    />
                    <button
                      className="btn secondary"
                      type="button"
                      aria-label={`删除分类 ${c.name}`}
                      onClick={async () => {
                        if (!confirm(`删除分类「${c.name}」？`)) return
                        try {
                          await window.api.deleteCategory(c.id)
                          showToast('已删除分类')
                          await refreshMeta()
                        } catch (err) {
                          showToast(friendlyError(err))
                        }
                      }}
                    >
                      删
                    </button>
                  </div>
                )}
                onAdd={(name) => addNamed('category', name)}
              />
              <SettingsList
                title="单据类型"
                hint="已被流水引用的单据类型无法删除"
                items={docTypes}
                renderItem={(d: DocType) => (
                  <div className="item" key={d.id}>
                    <input
                      defaultValue={d.name}
                      aria-label={`单据类型 ${d.name}`}
                      onBlur={async (e) => {
                        if (e.target.value.trim() && e.target.value !== d.name) {
                          await window.api.upsertDocType({ id: d.id, name: e.target.value.trim() })
                          showToast('单据类型已更新')
                          await refreshMeta()
                        }
                      }}
                    />
                    <button
                      className="btn secondary"
                      type="button"
                      aria-label={`删除单据类型 ${d.name}`}
                      onClick={async () => {
                        if (!confirm(`删除单据类型「${d.name}」？`)) return
                        try {
                          await window.api.deleteDocType(d.id)
                          showToast('已删除单据类型')
                          await refreshMeta()
                        } catch (err) {
                          showToast(friendlyError(err))
                        }
                      }}
                    >
                      删
                    </button>
                  </div>
                )}
                onAdd={(name) => addNamed('doc', name)}
              />
            </div>
          </>
        )}
      </main>

      {exportOpen && (
        <div className="modal-backdrop" onClick={() => !busy && setExportOpen(false)}>
          <div
            className="modal export-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="导出"
          >
            <h3 style={{ marginTop: 0 }}>
              {exportMode === 'receipts' ? '导出票据文件夹' : '按日期范围导出 Excel'}
            </h3>
            <p style={{ color: 'var(--muted)', marginTop: 0 }}>
              {exportMode === 'receipts'
                ? '选择开始日期和结束日期，可跨月、跨年；再按「分类 → 几号到几号」建文件夹，放入范围内全部图片/PDF。Esc 关闭。'
                : '选择开始日期和结束日期，可跨月、跨年；导出范围包含起止当天。Esc 关闭。'}
            </p>
            <div className="toolbar" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className={exportMode === 'excel' ? 'chip active' : 'chip'}
                onClick={() => setExportMode('excel')}
              >
                Excel
              </button>
              <button
                type="button"
                className={exportMode === 'receipts' ? 'chip active' : 'chip'}
                onClick={() => setExportMode('receipts')}
              >
                票据文件夹
              </button>
            </div>
            <div className="filter-grid export-range-grid" style={{ marginBottom: 8 }}>
              <div className="field">
                <label htmlFor="export-start">开始日期（含）</label>
                <input
                  id="export-start"
                  type="date"
                  value={exportStart}
                  onChange={(e) => setExportStart(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="export-end">结束日期（含）</label>
                <input
                  id="export-end"
                  type="date"
                  value={exportEnd}
                  onChange={(e) => setExportEnd(e.target.value)}
                />
              </div>
            </div>
            <div className="export-preview">
              {!exportRangeValid
                ? exportStart && exportEnd && exportStart > exportEnd
                  ? '开始日期不能晚于结束日期。'
                  : '请选择有效的开始日期和结束日期。'
                : exportCount === null
                ? '正在统计所选日期范围的流水…'
                : exportCount === 0
                  ? exportMode === 'receipts'
                    ? '所选日期范围暂无流水，无可导出凭证。'
                    : '所选日期范围暂无流水，仍可导出空表模板。'
                  : exportMode === 'receipts'
                    ? `将导出所选日期范围 ${exportCount} 笔流水的凭证，按分类与几号到几号分文件夹。`
                    : `将导出 ${exportCount} 笔流水：总表排序 + 按分类分表（内按几号到几号分组）。`}
            </div>
            {months.length > 0 && (
              <div className="month-chips">
                <span className="month-chips-label">
                  有数据的月份（点击快速选择整月）：
                </span>
                {months.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={(() => {
                      const bounds = monthBounds(m)
                      return bounds.start === exportStart && bounds.end === exportEnd
                        ? 'chip active'
                        : 'chip'
                    })()}
                    onClick={() => {
                      const bounds = monthBounds(m)
                      setExportStart(bounds.start)
                      setExportEnd(bounds.end)
                    }}
                  >
                    {formatMonthLabel(m)}
                  </button>
                ))}
              </div>
            )}
            <div className="toolbar" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => setExportOpen(false)}>
                取消
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => void confirmExport()}>
                {busy
                  ? '导出中…'
                  : exportMode === 'receipts'
                    ? `导出票据 ${formatDateRangeLabel(exportStart, exportEnd)}`
                    : `导出 Excel ${formatDateRangeLabel(exportStart, exportEnd)}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function SettingsList<T>({
  title,
  hint,
  items,
  renderItem,
  onAdd,
}: {
  title: string
  hint?: string
  items: T[]
  renderItem: (item: T) => ReactNode
  onAdd: (name: string) => void
}) {
  const [name, setName] = useState('')
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {hint && <p style={{ color: 'var(--muted)', marginTop: 0 }}>{hint}</p>}
      <div className="list-editor">
        {items.map((item) => renderItem(item))}
        <div className="item">
          <input
            placeholder="新增…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onAdd(name)
                setName('')
              }
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => {
              onAdd(name)
              setName('')
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}

function AccountEditor({
  account,
  onSave,
}: {
  account: Account
  onSave: (acc: Account, opening: string) => void
}) {
  const [opening, setOpening] = useState(String(account.opening_balance))
  useEffect(() => setOpening(String(account.opening_balance)), [account.opening_balance])
  return (
    <div className="item">
      <strong style={{ width: 64 }}>{account.name}</strong>
      <input value={opening} onChange={(e) => setOpening(e.target.value)} />
      <button className="btn secondary" type="button" onClick={() => onSave(account, opening)}>
        保存
      </button>
    </div>
  )
}
