import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { segment } from 'oicq'
import { randomUUID } from 'node:crypto'
import { compressScreenshot } from './image-compression.js'

export const settings = { callbackButtons: true, cooldownSeconds: 2 }
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let assets = path.join(pluginRoot, 'assets')
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const ID_RE = /^[a-z0-9_-]+$/i
let browserLaunch = null
export function setAssetRoot(next) {
  assets = path.resolve(next)
}

const rarityNames = {
  gold: '金色回响',
  SSR: '金色回响',
  传说: '金色回响',
  金色回响: '金色回响',
  purple: '紫蜡封',
  SR: '紫蜡封',
  稀有: '紫蜡封',
  紫蜡封: '紫蜡封',
  R: '蓝漆封',
  精良: '蓝漆封',
  N: '素纸',
  普通: '素纸'
}

export function rarityClass(value) {
  const name = rarityNames[value] || ''
  if (value === 'gold' || name === '金色回响') return 'gold'
  if (value === 'purple' || name === '紫蜡封') return 'purple'
  if (value === 'R' || name === '蓝漆封') return 'blue'
  return ''
}

function hashId(id) {
  let hash = 2166136261
  const text = String(id || 'echo')
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function motif(type) {
  const name = String(type || '')
  if (/角色|人物|character/i.test(name)) return 'person'
  if (/信物|道具|item|relic/i.test(name)) return 'relic'
  if (/场景|地点|scene|location/i.test(name)) return 'scene'
  if (/彩蛋|easter/i.test(name)) return 'egg'
  if (/地点素材|locations/i.test(name)) return 'scene'
  return 'letter'
}

/** 每张卡按 id + 类型画出不同图案，不依赖外部图片模型。 */
export function cardSvg({ id = 'echo', type = '', rarity = '', hidden = false } = {}) {
  const seed = hashId(`${type}:${id}`)
  const hue = seed % 360
  const accent = (seed >>> 8) % 360
  const kind = motif(type)
  const tier = rarityClass(rarity)
  const wash = hidden
    ? '#8ea0a6'
    : tier === 'gold' ? '#c9842a' : tier === 'purple' ? '#8d63b5' : '#527f99'
  const paper = hidden ? '#d5dbdd' : tier === 'gold' ? '#fff1cc' : tier === 'purple' ? '#f4e9f8' : '#eaf1f5'
  const ink = hidden ? '#5d6d74' : '#243746'
  const x = 18 + (seed % 28)
  const y = 22 + ((seed >>> 5) % 24)
  const spin = (seed % 40) - 20
  const marks = []
  for (let index = 0; index < 4; index++) {
    const px = 16 + ((seed >>> (index * 3)) % 92)
    const py = 18 + ((seed >>> (index * 5 + 2)) % 70)
    marks.push(`<circle cx="${px}" cy="${py}" r="${1.4 + (index % 3)}" fill="${wash}" opacity="${hidden ? 0.25 : 0.85}"/>`)
  }
  const shapes = {
    person: `<circle cx="62" cy="46" r="16" fill="none" stroke="${ink}" stroke-width="3"/><path d="M34 104c6-24 18-34 28-34s22 10 28 34" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/><path d="M46 42c4-10 28-10 32 2" fill="none" stroke="${wash}" stroke-width="3"/>`,
    relic: `<rect x="38" y="34" width="48" height="58" rx="6" fill="none" stroke="${ink}" stroke-width="3"/><path d="M38 48h48M50 34v58M74 34v58" stroke="${wash}" stroke-width="2"/><circle cx="62" cy="63" r="7" fill="${wash}"/>`,
    scene: `<path d="M16 92 L40 48 L58 74 L78 36 L112 92 Z" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/><circle cx="86" cy="30" r="8" fill="${wash}" opacity="0.9"/><path d="M18 92h92" stroke="${wash}" stroke-width="3"/>`,
    egg: `<ellipse cx="62" cy="64" rx="28" ry="36" fill="none" stroke="${ink}" stroke-width="3"/><path d="M40 58c8 8 36 8 44-2M38 74c10 6 38 4 46-6" fill="none" stroke="${wash}" stroke-width="2.5"/><path d="M62 28l3 8 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1z" fill="${wash}"/>`,
    letter: `<path d="M24 36h76v62H24z" fill="none" stroke="${ink}" stroke-width="3"/><path d="M24 36l38 30 38-30" fill="none" stroke="${wash}" stroke-width="3"/><path d="M24 98l28-24M100 98L72 74" stroke="${ink}" stroke-width="2"/>`
  }
  const veil = hidden
    ? `<rect width="124" height="132" fill="#243746" opacity="0.28"/><path d="M18 18h88M18 114h88M30 40h64M30 58h48M30 76h70" stroke="#f4f7f6" stroke-width="3" opacity="0.35"/>`
    : ''
  const foil = tier === 'gold' && !hidden
    ? `<rect x="3" y="3" width="118" height="126" fill="none" stroke="#f6d98a" stroke-width="3"/><path d="M8 12h108" stroke="#fff6d4" stroke-width="2" opacity="0.8"/>`
    : tier === 'purple' && !hidden
      ? `<rect x="3" y="3" width="118" height="126" fill="none" stroke="#d7b7ea" stroke-width="3" stroke-dasharray="4 3"/>`
      : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 124 132" role="img" aria-label="${escape(hidden ? '未收录' : id)}"><defs><linearGradient id="sky${seed}" x2="1" y2="1"><stop stop-color="${paper}"/><stop offset="1" stop-color="${wash}" stop-opacity=".38"/></linearGradient></defs><rect width="124" height="132" rx="10" fill="url(#sky${seed})"/><path d="M-4 98 Q 17 73 46 99 T 102 98 T 146 93" fill="none" stroke="${wash}" stroke-width="14" opacity=".14"/><circle cx="104" cy="20" r="18" fill="${wash}" opacity=".12"/><path d="M7 108h110M8 115h86" stroke="${wash}" stroke-width="1" opacity=".35"/><g transform="translate(${x - 18} ${y - 22}) rotate(${spin} 62 66)" opacity="${hidden ? 0.35 : 1}">${shapes[kind] || shapes.letter}</g>${marks.join('')}<circle cx="105" cy="111" r="12" fill="none" stroke="${wash}" stroke-width="1.7" opacity=".75"/><path d="M94 111h22M105 100v22" stroke="${wash}" opacity=".45"/>${foil}${veil}</svg>`
}

function dataUrl(body, mime) {
  return `data:${mime};base64,${Buffer.from(body).toString('base64')}`
}

function insideAssets(candidate) {
  const root = path.resolve(assets)
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return ''
  return resolved
}

async function readRaster(candidate) {
  const resolved = insideAssets(candidate)
  if (!resolved) return ''
  try {
    const data = await fs.readFile(resolved)
    const ext = path.extname(resolved).slice(1).toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/png'
    return dataUrl(data, mime)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return ''
  }
}

/** 用户 png/jpg 可覆盖程序卡面；路径必须落在 assets 内。 */
export async function art(kind, id) {
  if (!ID_RE.test(String(id || '')) || !ID_RE.test(String(kind || ''))) return ''
  for (const ext of ['png', 'webp', 'jpg', 'jpeg']) {
    const image = await readRaster(path.join(assets, kind, `${id}.${ext}`))
    if (image) return image
  }
  return ''
}

/** dossiers 可指定 silhouette 相对路径；拒绝跳出 assets。locations 素材同样只读本地目录。 */
export async function loadDossierArt(dossier = {}) {
  const requested = dossier.silhouette || dossier.silhouettePath || ''
  if (requested) {
    const normalized = String(requested).replace(/\\/g, '/')
    if (normalized.includes('\0') || path.win32.isAbsolute(requested) || path.posix.isAbsolute(normalized)) return { ok: false, reason: 'absolute' }
    const image = await readRaster(path.join(assets, normalized))
    if (image) return { ok: true, image, source: 'silhouette' }
    return { ok: false, reason: 'missing' }
  }
  if (dossier.locationId && ID_RE.test(String(dossier.locationId))) {
    const image = await art('locations', dossier.locationId)
    if (image) return { ok: true, image, source: 'locations' }
  }
  return { ok: false, reason: 'none' }
}

function button(label, command, owner = '*') {
  // type=1 的公开按钮也必须携带回调标记；返回菜单只有 #回响，无法从文字判断来源。
  const payload = owner === '*' ? (settings.callbackButtons ? `${command}|@cb` : command) : `${command}|${owner}`
  return {
    id: randomUUID(),
    render_data: { label: label.slice(0, 12), visited_label: label.slice(0, 12), style: 1 },
    action: { type: settings.callbackButtons ? 1 : 2, permission: { type: 2 }, data: payload, enter: !settings.callbackButtons }
  }
}
export function controls(rows) {
  return segment.raw({ type: 'keyboard', content: { rows: rows.slice(0, 5).map(row => ({ buttons: row.slice(0, 5).map(item => button(...item)) })) } })
}
export function menu(title, text, rows = []) {
  const safeTitle = String(title || '回响邮局').replace(/[\r\n]/g, ' ').replace(/([\\`*_{}\[\]<>!|])/g, '\\$1')
  const message = [segment.raw({ type: 'markdown', content: `# ${safeTitle}\n\n${text}` })]
  if (rows.length) message.push(controls(rows))
  return message
}
export function markdown(spec, rows = [], body = '') {
  return menu(spec.title || '回响邮局', body, rows)
}

const style = `
*{box-sizing:border-box}html,body{margin:0}body{font:22px/1.6 'Noto Sans CJK SC','Microsoft YaHei',sans-serif;color:#203c4b;background:#142f42}
.sheet{width:1280px;min-height:570px;padding:44px 48px 32px;background:#edf3f5;position:relative;border-top:12px solid #284e66}
.sheet:before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:repeating-linear-gradient(120deg,#47788f 0 28px,#edf3f5 28px 48px,#b96258 48px 76px,#edf3f5 76px 96px)}
.inside{position:relative}.brand{display:flex;align-items:center;gap:12px;font-size:21px;color:#496879;font-weight:600}.brand-mark{display:inline-grid;place-items:center;width:34px;height:28px;border:1.5px solid #496879;border-radius:3px;font-size:22px;line-height:1}.brand span:last-child{font-size:17px;font-weight:400;margin-left:auto;color:#607884}
.head{display:flex;align-items:center;justify-content:space-between;gap:28px;margin:22px 0 24px}.head h1{font:700 54px/1.35 'Noto Serif CJK SC',serif;margin:0;color:#193a50;overflow-wrap:anywhere;max-width:990px}
.stamp{flex:none;border:2px solid #668493;border-radius:50%;width:82px;height:82px;display:grid;place-content:center;transform:rotate(10deg);font:600 17px/1.6 'Noto Sans CJK SC',sans-serif;text-align:center;color:#526e7d;outline:1px solid #92a9b3;outline-offset:5px}
.lead{white-space:pre-wrap;font-size:23px;line-height:1.7;margin:0 0 28px;padding:18px 22px;background:#fff;border-left:4px solid #47788f;overflow-wrap:anywhere}.note{white-space:pre-wrap;font-size:28px;line-height:1.8;padding:30px;background:#fff;overflow-wrap:anywhere}
.row,.grid{display:grid;gap:18px;align-items:stretch}.row{grid-template-columns:repeat(5,minmax(0,1fr))}.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.ten{grid-template-columns:repeat(5,minmax(0,1fr));gap:20px}
.tile{--tier:#78909b;--wash:#f5f8fa;position:relative;min-width:0;padding:12px 12px 16px;background:#fff;border:1px solid #cedbe1;border-radius:8px;overflow:hidden;border-top:4px solid var(--tier)}
.tile.gold{--tier:#b17c29;--wash:#faf1da;border-color:#d9c497;border-top-color:var(--tier)}.tile.purple{--tier:#8c6bab;--wash:#f1eaf8;border-top-color:var(--tier)}.tile.blue{--tier:#56829e;--wash:#eaf2f7}
.art{height:176px;display:grid;place-items:center;overflow:hidden;background:var(--wash);border-radius:4px;margin-bottom:14px;color:var(--tier)}.art img,.art svg{display:block;width:100%;height:100%;object-fit:cover}.art svg{object-fit:contain}
.name{font-size:24px;font-weight:700;line-height:1.5;overflow-wrap:anywhere}.meta{font-size:19px;color:#536976;line-height:1.7;margin-top:7px;overflow-wrap:anywhere}.ten .art{height:168px}.ten .name{font-size:24px}.ten .meta{font-size:19px}
.tile-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;font-size:17px;line-height:1.4;color:var(--tier);font-weight:600}.position{color:#657b87;font-size:16px;font-weight:400}.grid .art{height:178px}
.scratch{width:900px;max-width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:0 auto}.scratch .tile{padding:16px;min-height:180px;text-align:center}.scratch .art{height:84px;margin-bottom:7px;background:transparent}.scratch .name{font-size:25px}.scratch .meta{font-size:19px;margin-top:3px}.scratch .tile.covered{background:#284e66;border:1px solid #456e86;border-top:4px solid #648fa7}.scratch .covered .name{color:#fff}.scratch .covered .meta{color:#c1d6e2}.scratch .covered .art{color:#d5e4ed}.scratch .covered .tile-label,.scratch .covered .position{color:#c1d6e2}.symbol{font:52px/1 'Noto Sans CJK SC',sans-serif}.scratch .covered .symbol{font-size:42px;border:1px dashed #83a4b8;border-radius:50%;width:64px;height:64px;display:grid;place-items:center}.covered .name{color:#607682}.foot{display:flex;align-items:flex-start;gap:16px;border-top:1px solid #bbcdd7;margin-top:30px;padding-top:20px;color:#4e6878;font-size:21px;white-space:pre-wrap;overflow-wrap:anywhere}.foot:before{content:'邮记';flex:none;color:#36566a;font-weight:700}.golden{border-top-color:#a27e3c}.golden .stamp{color:#8d672c;border-color:#aa8a51;outline-color:#c6b17b}
`
async function tileFigure(item) {
  const hidden = Boolean(item.hidden)
  if (item.kind === 'cells') return `<span class="symbol">${escape(hidden ? '？' : item.symbol || '✦')}</span>`
  const dossier = await loadDossierArt(item.dossier || {})
  const override = hidden ? '' : await art(item.kind || 'cards', item.id)
  const image = override || (hidden ? dossier.image : '') || ''
  if (image) return `<img src="${image}" alt="">`
  const svg = cardSvg({ id: item.id, type: item.type || item.kind, rarity: item.rarity, hidden })
  return svg
}
export async function renderHtml({ title, lead = '', tiles = [], mode = 'row', footer = '', golden = false }) {
  const items = await Promise.all(tiles.map(async (item, index) => {
    const rarity = rarityClass(item.rarity)
    const covered = item.hidden ? 'covered' : ''
    const figure = await tileFigure(item)
    const meta = item.hidden ? (mode === 'scratch' ? '轻点按钮揭晓' : '等待收录') : item.meta || rarityNames[item.rarity] || item.rarity || ''
    return `<div class="tile ${rarity} ${covered}"><div class="tile-label"><span>${escape(item.hidden ? (mode === 'scratch' ? '待刮开' : '尚未收录') : rarityNames[item.rarity] || '回响收藏')}</span><span class="position">${String(index + 1).padStart(2, '0')}</span></div><div class="art">${figure}</div><div class="name">${escape(item.hidden ? (mode === 'scratch' ? '待刮开' : '未收录') : item.name)}</div><div class="meta">${escape(meta)}</div></div>`
  }))
  const layout = tiles.length === 10 && /十连/.test(title) ? 'row ten' : ['row', 'grid', 'scratch'].includes(mode) ? mode : 'grid'
  const columns = mode === 'row' && !layout.includes('ten') ? ` style="grid-template-columns:repeat(${Math.min(5, Math.max(1, tiles.length))},minmax(0,1fr))"` : ''
  const body = tiles.length ? `<div class="${layout}"${columns}>${items.join('')}</div>` : `<div class="note">${escape(lead)}</div>`
  const goldFrame = golden || tiles.some(item => rarityClass(item.rarity) === 'gold' && !item.hidden)
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><style>${style}</style><body><div class="sheet ${goldFrame ? 'golden' : ''}"><div class="inside"><div class="brand"><span class="brand-mark">✉</span>回响邮局<span>云海投递处</span></div><div class="head"><h1>${escape(title)}</h1><div class="stamp">云海<br>邮政</div></div>${tiles.length ? `<p class="lead">${escape(lead)}</p>` : ''}${body}<div class="foot">${escape(footer || '把这一刻的回响，寄给明天的自己。')}</div></div></div></body></html>`
}

export async function render(spec) {
  const html = await renderHtml(spec)
  const browser = await sharedBrowser()
  if (!browser) return null
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
    await page.setContent(html, { waitUntil: 'load' })
    const height = await page.$eval('.sheet', node => node.getBoundingClientRect().height)
    if (!Number.isFinite(height) || height <= 0 || height > 16000) return null
    return await compressScreenshot(async ({ type, quality, scale }) => {
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: scale })
      return page.screenshot({ type, ...(quality ? { quality } : {}), clip: { x: 0, y: 0, width: 1280, height: Math.ceil(height) } })
    })
  } finally { await page.close() }
}

/** 复用 Yunzai / 已启动的 Browser；并发渲染只允许一次 launch。 */
export async function sharedBrowser() {
  const existing = globalThis.puppeteer?.browser || globalThis.Bot?.puppeteer?.browser || globalThis.__echoPostBrowser
  if (existing) return existing
  if (!browserLaunch) {
    browserLaunch = (async () => {
      const again = globalThis.puppeteer?.browser || globalThis.Bot?.puppeteer?.browser || globalThis.__echoPostBrowser
      if (again) return again
      try {
        const puppeteer = await import('puppeteer')
        const browser = await puppeteer.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
        globalThis.__echoPostBrowser = browser
        globalThis.puppeteer ||= {}
        if (!globalThis.puppeteer.browser) globalThis.puppeteer.browser = browser
        return browser
      } catch (error) {
        globalThis.logger?.warn?.(`[回响邮局] 无法渲染图片，使用文字：${error}`)
        return null
      } finally {
        if (!globalThis.__echoPostBrowser) browserLaunch = null
      }
    })()
  }
  return browserLaunch
}

export function image(buffer) {
  const file = Buffer.isBuffer(buffer) || buffer instanceof Uint8Array ? `base64://${Buffer.from(buffer).toString('base64')}` : buffer
  return segment.image(file)
}
