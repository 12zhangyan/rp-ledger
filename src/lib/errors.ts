export function friendlyError(err: unknown) {
  const raw = String(err ?? '')
  return raw
    .replace(/^Error:\s*/i, '')
    .replace(/^Error invoking remote method [^:]+:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || '操作失败，请重试'
}
