const PREFIX = 'rp-ledger:'

export function loadJson<T extends Record<string, unknown>>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<T>
    const out = { ...fallback, ...parsed }
    // 浅合并一层嵌套对象（如 query）
    for (const k of Object.keys(fallback) as (keyof T)[]) {
      const base = fallback[k]
      const next = parsed[k]
      if (
        base &&
        next &&
        typeof base === 'object' &&
        typeof next === 'object' &&
        !Array.isArray(base) &&
        !Array.isArray(next)
      ) {
        out[k] = { ...(base as object), ...(next as object) } as T[keyof T]
      }
    }
    return out
  } catch {
    return fallback
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* ignore quota */
  }
}
