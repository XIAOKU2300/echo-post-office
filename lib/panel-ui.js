const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const panelStyle = `
.lead.summary-strip{display:flex;flex-wrap:wrap;gap:0;padding:0;border:1px solid #c8d7df;border-left:4px solid #47788f;background:#fff}
.summary-item{flex:1 1 170px;padding:18px 22px;white-space:normal}.summary-item+.summary-item{border-left:1px solid #e1e9ed}.summary-item strong{font-size:30px;color:#23485e;font-weight:700;line-height:1.35}.summary-item span{display:block;color:#566f7d;font-size:18px;margin-bottom:4px}
.progress-note{margin:18px 0 0;display:flex;align-items:center;gap:16px;font-size:18px;color:#4e6878}.progress-track{height:8px;flex:1;background:#d7e2e8;border-radius:4px;overflow:hidden}.progress-fill{height:100%;background:#527f99;border-radius:4px}.golden .progress-fill{background:#ae853d}
`

export function summaryHtml(lead) {
  const text = String(lead || '')
  const parts = text.split(/\s*[·｜]\s*/)
  const fields = parts.map(part => /^([^\d+\n]+?)\s*([+]?\d+(?:\/\d+)?)(.*)$/.exec(part.trim()))
  if (parts.length >= 2 && parts.length <= 6 && fields.every(field => field && field[3].length < 16) && !text.includes('\n')) {
    return `<div class="lead summary-strip">${fields.map(field => `<div class="summary-item"><span>${escape(field[1])}</span><strong>${escape(field[2])}</strong>${field[3] ? ` ${escape(field[3])}` : ''}</div>`).join('')}</div>`
  }
  return `<p class="lead">${escape(text)}</p>`
}

export function progressHtml(footer) {
  const match = /(保底进度|同行进度|揭晓)\s*(\d+)\/(\d+)/.exec(String(footer || ''))
  if (!match || Number(match[3]) <= 0) return ''
  const percent = Math.min(100, Math.max(0, Number(match[2]) / Number(match[3]) * 100))
  return `<div class="progress-note"><span>${escape(match[1])} ${match[2]}/${match[3]}</span><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div></div>`
}
