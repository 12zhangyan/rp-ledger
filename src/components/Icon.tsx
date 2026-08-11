export type IconName =
  | 'ledger'
  | 'accounts'
  | 'stats'
  | 'settings'
  | 'import'
  | 'export'
  | 'search'
  | 'reset'
  | 'add'
  | 'receipt'

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  }

  if (name === 'ledger') {
    return <svg {...common}><path d="M6 3.5h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
  }
  if (name === 'accounts') {
    return <svg {...common}><path d="M4 6.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a3 3 0 0 1 3-3h11"/><path d="M15 11h5v4h-5a2 2 0 0 1 0-4Z"/></svg>
  }
  if (name === 'stats') {
    return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
  }
  if (name === 'settings') {
    return <svg {...common}><path d="M4 6h7M15 6h5M4 12h3M11 12h9M4 18h10M18 18h2"/><circle cx="13" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></svg>
  }
  if (name === 'import') {
    return <svg {...common}><path d="M12 3v11M8 10l4 4 4-4M5 20h14"/></svg>
  }
  if (name === 'export') {
    return <svg {...common}><path d="M12 15V4M8 8l4-4 4 4M5 20h14"/></svg>
  }
  if (name === 'search') {
    return <svg {...common}><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
  }
  if (name === 'reset') {
    return <svg {...common}><path d="M4 5v5h5M5.5 15a7 7 0 1 0 .2-7.8L4 10"/></svg>
  }
  if (name === 'add') {
    return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>
  }
  return <svg {...common}><path d="M6 3.5h12v17H6zM9 7h6M9 11h6M9 15h3"/><path d="M4 6v14h12"/></svg>
}
