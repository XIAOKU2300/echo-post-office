/**
 * 回响邮局 · TRSS-Yunzai 插件入口
 *
 * 安装位置：<TRSS-Yunzai>/plugins/echo-post-office/apps/index.js
 * 目录结构：
 *   echo-post-office/
 *     apps/index.js          本文件（入口：命令路由 + 按钮回调 + 面板/事务/定时器）
 *     lib/store.js           状态底座（事务 / Redis 优先 JSON 兜底）
 *     lib/presentation.js    渲染与键盘（markdown / keyboard / 图片）
 *     lib/rewards.js         纯逻辑：十连 / 刮刮乐 / 福袋 / 图鉴 / 兑换 / 佩戴（并行模块）
 *     lib/adventures.js      纯逻辑：档案 / 派遣 / 对战（并行模块）
 *     assets/{cards,dossiers,locations}/<id>.png   可选素材（缺省用占位符号）
 *
 * 本文件只做集成：路由、校验、原子冻结星屑、面板生命周期、超时结算、传输降级。
 * 两个纯逻辑模块的字段差异在下方「适配层」中集中处理，不改动其它文件。
 *
 * QQ 群环境待实测项（详见 README）：
 *   1. 键盘回调实际落在哪个字段（e.button.data / e.data.button.data / e.msg 回显）；
 *   2. QQ 官方适配器下定时结算时的主动群发链路（Bot.pickGroup / e.group.sendMsg）；
 *   3. 撤回自己发出的 markdown+keyboard 消息是否受时间窗限制。
 */

import { randomInt, randomUUID } from 'node:crypto'
import * as storeApi from '../lib/store.js'
import { sendQQMedia } from '../lib/qq-media.js'
import { loadCompanionRoster, meetCompanion, recordCompanionActivity, claimCompanionReward, companionPanel, companionCollection } from '../lib/companions.js'

/* ============================================================================
 * 1. 运行参数
 * ==========================================================================*/

export const config = {
  /** 命令前缀 */
  prefix: '#回响',
  /** 同一条消息最多被动回复次数，超出改为主动群发（QQ 官方限制） */
  maxPassiveReplies: 5,
  /** 防刷冷却秒数，与 presentation.settings.cooldownSeconds 对齐 */
  cooldownSeconds: 2,
  /** 对战超时自动结算（毫秒） */
  duelTimeoutMs: 60 * 1000,
  /** 兜底巡检间隔（毫秒），0 表示关闭 */
  sweepIntervalMs: 15 * 1000,
  /** 面板记录保留时间（毫秒），过期后不再尝试撤回 */
  panelTtlMs: 24 * 60 * 60 * 1000,
  /** 面板记录上限 */
  maxPanels: 400,
  /** 押注默认/最小/最大星屑 */
  defaultStake: 50,
  minStake: 10,
  maxStake: 1000,
  /** 同群同时存在的对战上限 */
  maxDuelsPerGroup: 3,
  /** 刮刮乐单张格子数与每日张数（仅用于 UI 与循环保护，真实次数由 rewards.js 决定） */
  scratchCells: 9,
  maxScratchRounds: 2,
  /** 单条文字消息长度上限 */
  replyCharLimit: 900,
  /** 星屑字段名，留空则自动探测 */
  walletKey: '',
  /** 视为 QQ 官方适配器的 adapter_id 片段 */
  qqAdapters: ['qqbot', 'qqofficial', 'qq_official', 'qq官方', 'guild'],
}

if (globalThis.echoPostOfficeConfig && typeof globalThis.echoPostOfficeConfig === 'object') {
  Object.assign(config, globalThis.echoPostOfficeConfig)
}

/* ============================================================================
 * 2. 基类与依赖装载（Yunzai 缺失时降级，保证独立可测）
 * ==========================================================================*/

const loggerShim = {
  info: (...args) => {
    const logger = globalThis.logger
    if (logger?.info) logger.info(...args)
    else if (config.verbose) console.log('[回响邮局]', ...args)
  },
  warn: (...args) => {
    const logger = globalThis.logger
    if (logger?.warn) logger.warn(...args)
    else console.log('[回响邮局]', ...args)
  },
  error: (...args) => {
    const logger = globalThis.logger
    if (logger?.error) logger.error(...args)
    else console.error('[回响邮局]', ...args)
  },
}

/** 无 Yunzai 环境时的渲染降级：只用文字，绝不因为缺依赖而崩 */
export const fallbackPresentation = {
  settings: { callbackButtons: true, cooldownSeconds: 2 },
  controls: () => null,
  menu: (title, text, rows = []) => [{ type: 'markdown', content: `# ${title}\n\n${text}` }, ...(rows.length ? [{ type: 'keyboard', content: { rows } }] : [])],
  render: async () => null,
  image: (buffer) => buffer,
  source: 'fallback',
}

/* eslint-disable-next-line no-unused-vars -- 版本位为兜底：内容解析由 `export class ... extends plugin` 决定 */
let plugin
const baseLoadNotes = []
for (const specifier of [
  '../../../lib/plugins/plugin.js',
  '../../lib/plugins/plugin.js',
  '../lib/plugins/plugin.js',
]) {
  try {
    const mod = await import(specifier)
    plugin = mod?.default || mod?.plugin
    if (plugin) break
  } catch (error) {
    baseLoadNotes.push(`${specifier}: ${error?.message || error}`)
  }
}
if (!plugin) {
  // 独立运行 / 测试环境：提供一个最小基类，保证类可以实例化。
  class PluginFallback {
    constructor(data = {}) {
      Object.assign(this, data)
    }
    async reply(message, quote = false) {
      if (typeof this.e?.reply === 'function') return this.e.reply(message, quote)
      return null
    }
  }
  Object.defineProperty(PluginFallback, 'name', { value: 'plugin' })
  plugin = PluginFallback
  // 生产环境里这通常意味着目录层级放错了：插件类没有继承 Yunzai 基类，
  // 部分加载器会因此跳过本插件，所以这里把尝试过的路径打进日志。
  loggerShim.warn(`[回响邮局] 未找到 Yunzai 基类（plugin.js），已使用内置兜底基类。尝试过：${baseLoadNotes.join('；')}`)
}

function normalizePresentation(mod) {
  const source = mod && typeof mod === 'object' ? mod : {}
  return {
    settings: source.settings && typeof source.settings === 'object' ? source.settings : fallbackPresentation.settings,
    controls: typeof source.controls === 'function' ? source.controls.bind(source) : fallbackPresentation.controls,
    menu: typeof source.menu === 'function' ? source.menu.bind(source) : fallbackPresentation.menu,
    markdown: typeof source.markdown === 'function' ? source.markdown.bind(source) : (spec, rows, body) => (source.menu || fallbackPresentation.menu)(spec.title || '回响邮局', body, rows),
    render: typeof source.render === 'function' ? source.render.bind(source) : fallbackPresentation.render,
    image: typeof source.image === 'function' ? source.image.bind(source) : fallbackPresentation.image,
    source: mod ? 'lib/presentation.js' : 'fallback',
  }
}

/* ============================================================================
 * 3. 通用工具
 * ==========================================================================*/

const WALLET_KEYS = [
  'stardust', '星屑', 'dust', 'starDust', 'star_dust',
  'echoes', 'echo', 'coins', 'coin', 'gold', 'balance', 'currency', 'points', 'point', 'money',
]

function pickFirst(source, keys) {
  if (!source || typeof source !== 'object') return undefined
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function asText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    const nested = pickFirst(value, ['text', 'message', 'data', 'content', 'title', 'name', 'label', 'value'])
    if (nested !== undefined && nested !== value) return asText(nested)
  }
  return ''
}

function firstLine(value, limit = 120) {
  const text = String(value ?? '').split('\n')[0].trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function entriesFrom(value) {
  if (Array.isArray(value)) return value.map((entry, index) => ({ entry, key: null, index }))
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, entry], index) => ({ entry, key, index }))
  }
  if (value === undefined || value === null) return []
  return [{ entry: value, key: null, index: 0 }]
}

function isAssetId(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value)
}

function safeKind(value, fallback = 'cards') {
  const text = asText(value).toLowerCase()
  return /^[a-z0-9_-]{1,16}$/.test(text) ? text : fallback
}

function symbolOf(kind) {
  if (kind === 'dossiers') return '📜'
  if (kind === 'locations') return '🗺️'
  return '✉'
}

function normalizeMode(value) {
  const text = asText(value).toLowerCase()
  return text === 'row' || text === 'grid' || text === 'scratch' ? text : ''
}

function randomToken(size = 8) {
  return randomUUID().replace(/-/g, '').slice(0, size)
}

/** mulberry32；既是函数（rng()）也带常用方法，兼容两种 rng 约定 */
export function makeRng(seed) {
  let state = (Number.isInteger(seed) ? seed : randomInt(1, 2 ** 31 - 1)) >>> 0
  const float = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng = () => float()
  rng.next = float
  rng.float = float
  rng.int = (min, max) => Math.floor(min + float() * (max - min + 1))
  rng.chance = (p) => float() < Number(p || 0)
  rng.pick = (list) => (Array.isArray(list) && list.length ? list[Math.min(list.length - 1, Math.floor(float() * list.length))] : undefined)
  rng.shuffle = (list) => {
    const out = [...(Array.isArray(list) ? list : [])]
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(float() * (i + 1))
      const swap = out[i]
      out[i] = out[j]
      out[j] = swap
    }
    return out
  }
  rng.reset = (value) => {
    state = (Number.isInteger(value) ? value : seed ?? 1) >>> 0
  }
  return rng
}

/* -------------------------------- 事件读取 -------------------------------- */

function candidateStrings(e) {
  const list = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) list.push(value.trim())
    else if (value && typeof value === 'object') {
      const nested = pickFirst(value, ['data', 'text', 'content', 'command', 'value', 'button_data'])
      if (typeof nested === 'string' && nested.trim()) list.push(nested.trim())
    }
  }
  push(e?.button)
  push(e?.button?.data)
  push(e?.data?.button)
  push(e?.data?.button?.data)
  push(e?.raw?.button)
  push(e?.raw?.button?.data)
  push(e?.event?.button)
  push(e?.buttonData)
  push(e?.button_data)
  push(e?.raw_button_data)
  push(typeof e?.msg === 'string' ? e.msg : e?.msg?.data)
  push(e?.raw_message)
  if (Array.isArray(e?.message)) {
    for (const seg of e.message) {
      push(seg)
      if (seg && typeof seg === 'object') push(seg.data)
    }
  }
  return list
}

/** 从事件里取出「按钮回调数据」（不包含普通聊天文本） */
export function extractButtonData(e) {
  const candidates = [
    e?.button, e?.button?.data, e?.data?.button, e?.data?.button?.data, e?.raw?.button,
    e?.raw?.button?.data, e?.event?.button, e?.buttonData, e?.button_data, e?.raw_button_data,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (candidate && typeof candidate === 'object') {
      const nested = pickFirst(candidate, ['data', 'text', 'command', 'value', 'button_data'])
      if (typeof nested === 'string' && nested.trim()) return nested.trim()
    }
  }
  return ''
}

/** 事件最终要处理的输入（按钮回调优先，其次消息文本） */
export function extractInput(e) {
  const candidates = candidateStrings(e)
  const button = extractButtonData(e)
  if (button) return button
  return candidates[0] || ''
}

export function isQQBot(e) {
  const values = [e?.adapter_id, e?.adapter, e?.bot?.adapter_id, e?.bot?.adapter?.id, e?.bot?.adapter?.name]
  const text = values.map((value) => asText(value).toLowerCase()).join('|')
  if (!text) return false
  return (config.qqAdapters || []).some((needle) => text.includes(String(needle).toLowerCase()))
}

function sceneId(e) {
  const gid = e?.group_id ?? e?.channel_id ?? e?.guild_id
  return gid === undefined || gid === null || gid === '' ? '0' : String(gid)
}

function actorId(e) {
  const uid = e?.user_id ?? e?.sender?.user_id ?? e?.sender?.id
  return uid === undefined || uid === null || uid === '' ? '' : String(uid)
}

function senderName(e) {
  return asText(
    pickFirst(e?.sender || {}, ['card', 'nickname', 'name']) ||
    pickFirst(e?.member || {}, ['card', 'nickname', 'name']) ||
    e?.nickname ||
    e?.sender?.user_id ||
    e?.user_id,
  ) || String(actorId(e))
}

function panelKey(gid, uid) {
  return `${gid}:${uid}`
}

function displayOf(echo, uid) {
  const id = String(uid)
  const name = echo?.names?.[id]
  return name ? `${name}(${id})` : id
}

/* -------------------------------- 星屑钱包 -------------------------------- */

function walletPath(profile) {
  if (!profile || typeof profile !== 'object') return null
  if (config.walletKey && typeof profile[config.walletKey] === 'number') return [config.walletKey]
  for (const key of WALLET_KEYS) if (typeof profile[key] === 'number') return [key]
  for (const holder of ['wallet', 'currency', 'bank', 'account', 'profile']) {
    const nested = profile[holder]
    if (!nested || typeof nested !== 'object') continue
    for (const key of WALLET_KEYS) if (typeof nested[key] === 'number') return [holder, key]
  }
  return null
}

function readPath(target, path) {
  let value = target
  for (const step of path) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined
    value = value[step]
  }
  return value
}

function writePath(target, path, value) {
  let cursor = target
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!cursor[path[i]] || typeof cursor[path[i]] !== 'object') cursor[path[i]] = {}
    cursor = cursor[path[i]]
  }
  cursor[path[path.length - 1]] = value
}

export function wallet(profile) {
  const path = walletPath(profile)
  if (!path) return 0
  const value = readPath(profile, path)
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

export function hasWallet(profile) {
  return walletPath(profile) !== null
}

function addWallet(profile, delta) {
  const path = walletPath(profile) || ['stardust']
  const current = typeof readPath(profile, path) === 'number' ? readPath(profile, path) : 0
  writePath(profile, path, Math.max(0, Math.round(current + delta)))
}

function setWallet(profile, value) {
  const path = walletPath(profile) || ['stardust']
  writePath(profile, path, Math.max(0, Math.round(value)))
}

/* -------------------------------- 结果适配 -------------------------------- */

function summarize(value, limit = 8) {
  if (!value || typeof value !== 'object') return asText(value)
  const parts = []
  for (const [key, entry] of Object.entries(value)) {
    if (parts.length >= limit) break
    if (entry === undefined || entry === null || entry === '') continue
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      parts.push(`${key}: ${entry}`)
    } else if (Array.isArray(entry) && entry.every((item) => typeof item !== 'object')) {
      parts.push(`${key}: ${entry.slice(0, 6).join('/')}`)
    }
  }
  return parts.join('｜')
}

function tileFrom(item, options = {}) {
  const { entry, key, index } = item
  const defaultKind = options.kind || 'cards'
  if (entry === undefined || entry === null) {
    return { kind: defaultKind, name: `#${index + 1}`, meta: '等待拆封', hidden: true, symbol: '？' }
  }
  // 逻辑模块已经给出渲染用 tile（pulls[].tile / cells[].tile / cards[].tile）时直接采用
  if (entry && typeof entry === 'object' && entry.tile && typeof entry.tile === 'object' && !Array.isArray(entry.tile)) {
    const tile = entry.tile
    const fallbackId = asText(pickFirst(entry, ['id', 'cardId', 'card_id']))
    return {
      kind: safeKind(tile.kind, defaultKind),
      id: isAssetId(tile.id) ? tile.id : (isAssetId(fallbackId) ? fallbackId : undefined),
      name: asText(tile.name) || asText(entry.name) || fallbackId || `#${index + 1}`,
      meta: asText(tile.meta) || asText(pickFirst(entry, ['rarityName', 'type', 'rarity'])),
      rarity: asText(tile.rarity) || asText(pickFirst(entry, ['rarityStyle', 'rarityName', 'rarity'])),
      hidden: tile.hidden === true || entry.revealed === false,
      symbol: asText(tile.symbol) || asText(pickFirst(entry, ['rarityGlyph', 'glyph'])) || symbolOf(defaultKind),
    }
  }
  if (typeof entry === 'number') {
    const name = key || String(entry)
    return { kind: defaultKind, id: isAssetId(key) ? key : undefined, name, meta: `×${entry}`, symbol: symbolOf(defaultKind) }
  }
  if (typeof entry === 'string') {
    return {
      kind: defaultKind,
      id: isAssetId(key) ? key : (isAssetId(entry) ? entry : undefined),
      name: entry,
      meta: key && key !== entry ? String(key) : '',
      symbol: symbolOf(defaultKind),
    }
  }
  const id = asText(pickFirst(entry, ['id', 'cardId', 'card_id', 'card', 'key', 'code', 'slug', 'itemId', 'locationId', 'roleId', 'uuid'])) || (isAssetId(key) ? key : '')
  const name = asText(pickFirst(entry, ['name', 'title', 'label', 'display', 'text', 'desc', 'cardName', 'role', 'character']))
    || (id ? id : `#${index + 1}`)
  const metaParts = [
    asText(pickFirst(entry, ['silhouette', 'meta', 'note', 'detail', 'effect', 'tip'])),
    asText(pickFirst(entry, ['progress', 'rarityName', 'rarity', 'quality', 'grade', 'star', 'rank', 'level', 'type'])),
  ]
  const clue = pickFirst(entry, ['clues', 'descriptions', 'sightings'])
  if (Array.isArray(clue) && clue.length) metaParts.push(String(clue[0]).slice(0, 42))
  const count = pickFirst(entry, ['count', 'num', 'amount', 'quantity', 'times', 'nums'])
  if (typeof count === 'number' && count > 1) metaParts.push(`×${count}`)
  const dust = pickFirst(entry, ['stardust'])
  if (typeof dust === 'number' && dust > 0) metaParts.push(`星屑 ${dust}`)
  const score = pickFirst(entry, ['score', 'points', 'value', 'power', 'durability'])
  if (typeof score === 'number') metaParts.push(`分 ${score}`)
  const hidden = entry.hidden === true || entry.covered === true || entry.revealed === false || entry.state === 'covered' || entry.open === false
  return {
    kind: safeKind(pickFirst(entry, ['kind', 'type', 'category', 'slot', 'group']), defaultKind),
    id: isAssetId(id) ? id : undefined,
    name: hidden ? '未收录' : name,
    meta: hidden ? '等待拆封' : metaParts.filter(Boolean).join('｜'),
    rarity: asText(pickFirst(entry, ['rarity', 'rarityName', 'quality'])),
    hidden,
    symbol: hidden ? '？' : asText(pickFirst(entry, ['symbol', 'icon', 'glyph', 'mark', 'rarityGlyph'])),
  }
}

function tilesFrom(result, options = {}) {
  const fields = [
    'tiles', 'pulls', 'links', 'cells', 'sets', 'cards', 'items', 'rewards', 'entries',
    'results', 'drops', 'prizes', 'list', 'grid', 'board', 'questions', 'ranking', 'ranks',
    'members', 'rows', 'locations', 'souvenirs', 'location', 'souvenir',
  ]
  for (const field of fields) {
    const value = result?.[field]
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && !value.length) continue
    // 单个对象（location / souvenir 之类）当成一张卡面，而不是 id→值 映射
    const single = !Array.isArray(value) && typeof value === 'object'
      && (value.name || value.title || value.id)
    const entries = single ? [{ entry: value, key: null, index: 0 }] : entriesFrom(value)
    if (!entries.length) continue
    if (!single && !Array.isArray(value) && typeof value === 'object' && entries.every((item) => item.entry === undefined)) continue
    const max = options.maxTiles ?? 24
    return entries.slice(0, max).map((item) => tileFrom(item, options))
  }
  if (Array.isArray(result) && result.length) {
    return result.slice(0, options.maxTiles ?? 24).map((entry, index) => tileFrom({ entry, key: null, index }, options))
  }
  return []
}

export function specFromResult(result, options = {}) {
  const object = result && typeof result === 'object' && !Array.isArray(result)
    ? result
    : (result === undefined || result === null ? {} : { text: String(result) })
  // 逻辑模块自带 view（rewards.js 的 result.view 就是 {title,lead,tiles,mode,footer,golden}）时优先采用
  const view = object.view && typeof object.view === 'object' && !Array.isArray(object.view) ? object.view : null
  const viewTiles = Array.isArray(view?.tiles) ? view.tiles.filter((tile) => tile && typeof tile === 'object') : []
  const tiles = options.tiles || (viewTiles.length ? viewTiles : tilesFrom(object, options))
  const title = asText(view?.title) || asText(pickFirst(object, ['title', 'heading'])) || options.title || '回响邮局'
  let lead = asText(view?.lead) || asText(pickFirst(object, ['lead', 'text', 'message', 'desc', 'description', 'summary', 'note', 'log', 'hint', 'tip', 'detail']))
  const extra = asText(pickFirst(object, ['text', 'lines']))
  if (!view && extra && extra !== lead && !lead.includes(extra) && extra.length <= 160) lead = [lead, extra].filter(Boolean).join('\n')
  if (!lead) lead = summarize(object, 8)
  if (!lead && !tiles.length) lead = '本条回响没有更多细节。'
  const viewFooter = asText(view?.footer)
  const ownFooter = asText(pickFirst(object, ['footer', 'foot'])) || options.footer || ''
  const footer = [viewFooter, ownFooter].filter((value, index, list) => value && list.indexOf(value) === index).join('｜').slice(0, 140)
  const golden = options.golden === true || view?.golden === true || object.golden === true || object.rare === true
    || /gold|金/i.test(asText(pickFirst(object, ['rarity', 'rarityName', 'quality'])))
  const mode = normalizeMode(view?.mode) || normalizeMode(pickFirst(object, ['mode', 'layout']))
    || options.mode || (tiles.length > 6 ? 'grid' : 'row')
  return { title, lead, tiles, mode, footer, golden }
}

const ERROR_TEXT = {
  daily_limit: '今日次数已用完，明天再来。',
  limit: '今日次数已用完，明天再来。',
  no_limit: '今日次数已用完，明天再来。',
  cooldown: '操作太快啦，稍后再试。',
  insufficient: '星屑不足。',
  no_money: '星屑不足。',
  not_found: '没有找到对应内容。',
  locked: '还没有解锁。',
  busy: '正在处理上一条操作。',
  invalid: '参数不正确。',
  taken: '已经被别人拿走了。',
  expired: '这一局已经过期了。',
  full: '已经满了。',
  equipped: '已经佩戴中。',
  duplicate: '已经拥有。',
}

function errorText(error) {
  if (!error) return ''
  const text = asText(error) || (typeof error === 'object' ? asText(pickFirst(error, ['message', 'msg', 'code', 'reason'])) : '')
  if (!text) return typeof error === 'string' ? error : '操作未成功。'
  if (/[\u4e00-\u9fa5]/.test(text)) return text
  const mapped = ERROR_TEXT[text.toLowerCase()]
  return mapped || `操作未成功（${text}）`
}

/** 兼容 3/4 参数差异：仅当被省略的参数本来就是 undefined 且报类型错时才降级重试 */
function looksLikeTypeError(error) {
  const text = String(error?.message || error || '')
  return /TypeError|undefined|not a function|Cannot read|参数|缺少/i.test(text)
}

const ALT_NAMES = {
  drawTen: ['draw10', 'tenPull', 'draw', 'pullTen'],
  scratch: ['scratchCard', 'scrape', 'scratchDaily'],
  bag: ['luckyBag', 'openBag', 'gift'],
  collection: ['collect', 'codex', 'album', 'cards'],
  equip: ['wear', 'setEquip'],
  redeem: ['exchange', 'claimReward'],
  sampleDossiers: ['samples', 'dossiers'],
  dossierView: ['viewDossier'],
  dossierGuess: ['guessDossier'],
  dossierRank: ['rankDossier', 'rank'],
  dispatchStart: ['startDispatch'],
  dispatchClaim: ['claimDispatch'],
  dispatchAlbum: ['albumDispatch'],
  duelCreate: ['createDuel'],
  duelAccept: ['acceptDuel'],
  duelPull: ['pullDuel', 'duelDraw'],
  duelExpire: ['expireDuel'],
}

function isResultish(value) {
  // 逻辑模块可能返回 {profile,result} / {profile,error} / {sets,...} / 纯数组（排行）
  return !!value && typeof value === 'object'
}

function unwrapResult(raw, fallbackProfile) {
  let result = raw.result
  if (result === undefined) {
    result = ('profile' in raw || 'error' in raw) ? {} : raw
  }
  const profile = raw.profile && typeof raw.profile === 'object' ? raw.profile : fallbackProfile
  const errorSource = raw.error !== undefined ? raw.error : (result && typeof result === 'object' ? result.error : undefined)
  const error = errorSource ? errorText(errorSource) : ''
  let duel = raw.duel
  if (!duel && result && typeof result === 'object' && result.duel) duel = result.duel
  return { profile, result: result ?? {}, error, duel, missing: false }
}

/* ============================================================================
 * 4. 命令表
 * ==========================================================================*/

/*
 * 每组：[命令名, family, 标题, 别名...]
 * 别名按整词匹配（取命令词的第一个词），因此不会互相抢占。
 */
const COMMAND_TABLE = [
  ['wife', 'wife', '今日老婆', '今日老婆', '老婆', 'wife'],
  ['wifeReward', 'wife', '同行奖励', '同行奖励'],
  ['wifeCollection', 'wife', '同行收藏', '同行收藏'],
  ['menu', 'menu', '回响邮局', '', '菜单', '面板', '回响邮局', 'menu'],
  ['help', 'menu', '玩法说明', '帮助', '玩法', '规则', 'help'],
  ['selfCheck', 'menu', '回响自检', '自检', '诊断', 'check', 'selfcheck'],
  ['draw', 'draw', '回响十连', '十连', '抽卡', '十抽', 'draw'],
  ['scratch', 'scratch', '回响刮刮乐', '刮刮乐', '刮卡', '刮一刮', 'scratch'],
  ['bag', 'bag', '回响福袋', '福袋', '开福袋', 'bag'],
  ['album', 'album', '回响图鉴', '图鉴', '收藏', '我的图鉴', 'cards', 'codex'],
  ['redeem', 'redeem', '奖励兑换', '兑换', '奖励兑换', 'redeem', 'exchange'],
  ['equip', 'equip', '佩戴回响', '佩戴', '装备', 'equip', 'wear'],
  ['dossier', 'dossier', '回声档案', '档案', '猜谜', 'dossier'],
  ['guess', 'dossier', '档案作答', '猜', '猜角色', '作答', 'answer', 'guess'],
  ['rank', 'rank', '回响排行', '排行', '榜单', 'rank'],
  ['dispatch', 'dispatch', '云海派遣', '派遣', '出发', 'dispatch'],
  ['claim', 'dispatch', '派遣领取', '领取', '收获', 'claim'],
  ['dispatchAlbum', 'dispatch', '派遣相册', '相册', '派遣相册', 'albums'],
  ['duelCreate', 'duel', '回响对战', '约战', '挑战', '对战', 'duel'],
  ['duelAccept', 'duel', '接受对战', '接受', '应战', 'accept'],
  ['duelPull', 'duel', '对战抽卡', '对决', '对战抽卡', '出牌', 'pull'],
]

const COMMANDS = new Map()
for (const [name, family, title, ...aliases] of COMMAND_TABLE) {
  const entry = { name, family, title }
  for (const alias of aliases) {
    if (!COMMANDS.has(alias)) COMMANDS.set(alias, entry)
  }
}

export function resolveCommandWord(word) {
  if (!word) return COMMANDS.get('') || null
  if (COMMANDS.has(word)) return COMMANDS.get(word)
  const lower = word.toLowerCase()
  if (COMMANDS.has(lower)) return COMMANDS.get(lower)
  return null
}

/** 解析命令文本，兼容按钮 payload「命令|操作人#面板令牌」与 type2 回显 */
export function parseCommand(raw) {
  const text = String(raw ?? '').replace(/^\s*#?今日老婆(?=\s|$|\|)/, '#回响今日老婆')
  if (!text.trim()) return null
  const [head, ...rest] = text.split('|')
  const body = head.trim()
  if (!body) return null
  const ownerRaw = rest.join('|').trim()
  const callback = ownerRaw === '@cb'
  let ownerId = ''
  let token = ''
  if (ownerRaw && !callback && ownerRaw !== '*') {
    const [maybeId, maybeToken] = ownerRaw.split('#')
    if (/^\d{3,}$/.test(maybeId) || /^\d+:[0-9a-f]{16,}$/i.test(maybeId)) {
      ownerId = maybeId
      token = (maybeToken || '').trim()
    } else if (/^[0-9a-f]{6,}$/i.test(ownerRaw)) {
      token = ownerRaw
    }
  }
  const firstWord = body.split(/\s+/)[0] || ''
  const hasPrefix = /(回响|echo)/i.test(firstWord)
  let cleaned = body.replace(/^[#/!！.。、,，]+/, '')
  cleaned = cleaned.replace(/^回响邮局/, '').replace(/^回响/, '')
  cleaned = cleaned.replace(/^echo[\s_-]*(post)?[\s_-]*(office)?/i, '')
  cleaned = cleaned.trim()
  const words = cleaned ? cleaned.split(/\s+/).filter(Boolean) : []
  const word = words.shift() || ''
  const entry = resolveCommandWord(word)
  if (!entry) return null
  if (!hasPrefix && !entry.bare) return null
  return {
    name: entry.name,
    family: entry.family,
    title: entry.title,
    args: words,
    rawArgs: words.join(' '),
    cleaned,
    hasPrefix,
    ownerId,
    token,
    callback,
  }
}

/* ============================================================================
 * 5. 冷却 / 被动回复计数（仿「进群退群通知.js」checkCd）
 * ==========================================================================*/

const localCd = new Map()

function pruneLocalCd(nowMs = Date.now()) {
  if (localCd.size < 400) return
  for (const [key, expireAt] of localCd) if (expireAt <= nowMs) localCd.delete(key)
}

async function checkCd(key, seconds) {
  if (!(seconds > 0)) return false
  try {
    const redis = globalThis.redis
    if (redis?.get && redis?.set) {
      const exists = await redis.get(key)
      if (exists) return true
      await redis.set(key, '1', { EX: seconds })
      return false
    }
  } catch (error) {
    loggerShim.warn(`[回响邮局] 冷却检查异常，改用本地计数：${error?.message || error}`)
  }
  const nowMs = Date.now()
  pruneLocalCd(nowMs)
  const expireAt = localCd.get(key)
  if (expireAt && expireAt > nowMs) return true
  localCd.set(key, nowMs + seconds * 1000)
  return false
}

function cooldownKey(gid, uid, family) {
  return `Yz:echo-post-office:cd:${gid}:${uid}:${family}`
}

/* ============================================================================
 * 6. 渲染与传输
 * ==========================================================================*/

export function plainText(spec = {}, rows = [], options = {}) {
  const lines = []
  if (spec.title) lines.push(`【${spec.title}】`)
  if (spec.lead) {
    const lead = options.compact ? spec.lead.split('\n').slice(0, 3).join('\n') : spec.lead
    lines.push(lead)
  }
  if (Array.isArray(spec.tiles) && spec.tiles.length) {
    const shown = spec.tiles.slice(0, options.compact ? 4 : 12)
    for (const [index, tile] of shown.entries()) {
      const meta = tile.meta ? ` —— ${tile.meta}` : ''
      lines.push(`· ${tile.hidden ? `第${index + 1}格未拆封` : (tile.name || '未收录')}${meta}`)
    }
    if (spec.tiles.length > shown.length) lines.push(`… 共 ${spec.tiles.length} 项`)
  }
  if (rows.length) {
    const tips = []
    for (const row of rows) {
      for (const cell of row) {
        const command = Array.isArray(cell) ? cell[1] : ''
        if (typeof command === 'string' && command.startsWith(config.prefix) && !tips.includes(command)) tips.push(command)
      }
    }
    if (tips.length) lines.push(`可用指令：${tips.slice(0, 8).join('　')}`)
  }
  if (!options.compact && spec.footer) lines.push(spec.footer)
  return lines.filter(Boolean).join('\n').slice(0, config.replyCharLimit)
}

function stampRows(rows, stampOwner) {
  return (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row : []).map((cell) => {
    if (!Array.isArray(cell) || typeof cell[1] !== 'string') return null
    const [label, command] = cell
    const owner = cell.length > 2 ? cell[2] : stampOwner
    return owner === undefined || owner === null ? [label, command] : [label, command, owner]
  }).filter(Boolean)).filter((row) => row.length)
}

/** QQBot 无图面板用简洁 Markdown；有图结果由 renderItem 合成图片。 */
export function markdownBody(spec = {}) {
  const escapeMd = text => String(text ?? '').replace(/([\\`*_{}\[\]<>!|])/g, '\\$1')
  const lines = []
  const lead = String(spec.lead || '').trim()
  if (lead) {
    const parts = lead.split('\n').map(line => line.trim()).filter(Boolean)
    if (spec.title === '回响邮局') {
      lines.push(`> ${escapeMd(parts[0] || '')}`)
      if (parts[1]) lines.push('', `**${escapeMd(parts[1])}**`)
      lines.push('', '点按钮开玩；规则见「玩法说明」。')
    } else lines.push(...parts.map(line => escapeMd(line)))
  }
  const tiles = Array.isArray(spec.tiles) ? spec.tiles : []
  if (tiles.length) {
    lines.push('', '## 本次回响')
    if (spec.mode === 'scratch' && tiles.length === 9) {
      for (let index = 0; index < 9; index += 3) {
        lines.push(tiles.slice(index, index + 3).map(tile => tile.hidden ? '▧ 未刮开' : escapeMd(tile.name || tile.symbol || '✉')).join('　/　'))
      }
    } else {
      for (const [index, tile] of tiles.entries()) {
        const rarity = String(tile.rarity || '').toUpperCase()
        const grade = rarity === 'SSR' || rarity === 'GOLD' || rarity === '金色回响' ? '🌟 ' : rarity === 'SR' || rarity === 'PURPLE' ? '✦ ' : ''
        const name = tile.hidden ? '未收录' : (tile.name || '未命名')
        const detail = tile.hidden ? '' : tile.meta ? ` · ${escapeMd(tile.meta)}` : ''
        lines.push(`${index + 1}. ${grade}**${escapeMd(name)}**${detail}`)
      }
    }
  }
  if (spec.footer) lines.push('', `> ${escapeMd(spec.footer)}`)
  return lines.join('\n').trim() || '点下方按钮开始投递。'
}
async function renderItem(deps, item, rows, e) {
  const presentation = deps.presentation
  const spec = item.spec || {}
  const tiles = Array.isArray(spec.tiles) ? spec.tiles : []
  const qqBot = item.qq ?? isQQBot(e)
  const resultImage = tiles.length > 0 || item.kind === 'duel'
  if (qqBot && !resultImage) return presentation.markdown(spec, rows, markdownBody(spec))
  let buffer = null
  if (resultImage) {
    try {
      buffer = await presentation.render({ title: spec.title, lead: spec.lead, tiles, mode: spec.mode, footer: spec.footer, golden: spec.golden })
    } catch (error) {
      deps.logger.warn(`[回响邮局] 图片渲染失败，改用 Markdown：${error?.message || error}`)
    }
  }
  if (buffer) {
    if (qqBot) {
      const keyboard = rows.length ? presentation.controls(rows) : null
      return keyboard ? [presentation.image(buffer), keyboard] : [presentation.image(buffer)]
    }
    const caption = plainText(spec, rows, { compact: true })
    return caption ? [presentation.image(buffer), caption] : [presentation.image(buffer)]
  }
  if (qqBot) return presentation.markdown(spec, rows, markdownBody(spec))
  return plainText(spec, rows)
}

function pickMessageId(sent) {
  if (!sent) return null
  if (Array.isArray(sent)) {
    for (const item of sent) {
      const id = pickMessageId(item)
      if (id) return id
    }
    return null
  }
  if (typeof sent === 'object') {
    const direct = pickFirst(sent, ['message_id', 'msg_id', 'messageId', 'messageID', 'id'])
    if (direct !== undefined && direct !== null && direct !== '') return String(direct)
    if (sent.data) return pickMessageId(sent.data)
  }
  return null
}

function pickPlatformId(value) {
  if (value === undefined || value === null || value === '') return value
  const text = String(value)
  return /^\d+$/.test(text) && text.length > 6 ? Number(text) : value
}

function createTransport(deps) {
  const counters = new Map()

  function bump(msgId, nowMs) {
    if (!msgId) return Number.MAX_SAFE_INTEGER
    const key = String(msgId)
    const entry = counters.get(key) || { count: 0, at: nowMs }
    entry.count += 1
    entry.at = nowMs
    counters.set(key, entry)
    if (counters.size > 500) {
      for (const [key2, value] of counters) if (nowMs - value.at > 5 * 60 * 1000) counters.delete(key2)
    }
    return entry.count
  }

  async function activeSend(e, item, message) {
    const gid = item.gid ?? sceneId(e)
    const uid = item.uid ?? actorId(e)
    const bot = globalThis.Bot
    const attempts = gid && gid !== '0' ? [
      () => e?.group?.sendMsg?.(message),
      () => bot?.pickGroup?.(pickPlatformId(gid))?.sendMsg?.(message),
      () => e?.bot?.pickGroup?.(pickPlatformId(gid))?.sendMsg?.(message),
      () => bot?.sendGroupMsg?.(pickPlatformId(gid), message),
    ] : [
      () => e?.friend?.sendMsg?.(message),
      () => bot?.pickFriend?.(pickPlatformId(uid))?.sendMsg?.(message),
      () => e?.bot?.pickFriend?.(pickPlatformId(uid))?.sendMsg?.(message),
    ]
    for (const attempt of attempts) {
      let out
      try {
        out = attempt()
      } catch (error) {
        deps.logger.warn(`[回响邮局] 主动发送失败，尝试下一条链路：${error?.message || error}`)
        continue
      }
      if (out && typeof out.then === 'function') {
        try {
          return await out
        } catch (error) {
          deps.logger.warn(`[回响邮局] 主动发送被拒绝，尝试下一条链路：${error?.message || error}`)
          continue
        }
      }
      if (out !== undefined && out !== null && out !== false) return out
    }
    deps.logger.warn(`[回响邮局] 没有可用的主动发送链路（group=${gid}），本轮消息已放弃`)
    return null
  }

  async function send(e, item, message) {
    if (message === null || message === undefined) return null
    if (isQQBot(e)) {
      const fallback = deps.presentation.markdown(item.spec || {}, stampRows(item.rows, item.stampOwner), markdownBody(item.spec || {}))
      const direct = await sendQQMedia(e, item, message, fallback)
      if (direct.handled) return direct.result
    }
    const command = parseCommand(extractInput(e))
    // QQBot 按钮事件的 msg_id 是交互 ID，不能用作 e.reply 的被动回复 ID。
    const callback = isQQBot(e) && (!!extractButtonData(e) || !!command?.callback || !!command?.ownerId || command?.name === 'menu')
    const msgId = e?.message_id ?? e?.msg_id
    const count = callback ? 0 : bump(msgId, Date.now())
    const passive = !!e && typeof e.reply === 'function' && !callback && !item.forceActive && count <= deps.config.maxPassiveReplies
    if (passive) {
      try {
        return await e.reply(message, false)
      } catch (error) {
        deps.logger.warn(`[回响邮局] 被动回复失败，改主动发送：${error?.message || error}`)
      }
    }
    return activeSend(e, item, message)
  }

  async function recall(e, gid, messageId) {
    if (!messageId) return false
    const bot = globalThis.Bot
    const valuableId = pickPlatformId(messageId)
    const attempts = []
    if (e) {
      attempts.push(() => e?.group?.recallMsg?.(valuableId))
      attempts.push(() => e?.deleteMessage?.(valuableId))
      attempts.push(() => e?.bot?.deleteMessage?.(valuableId))
      attempts.push(() => e?.bot?.recallMsg?.(valuableId))
    }
    if (gid && gid !== '0') {
      attempts.push(() => bot?.pickGroup?.(pickPlatformId(gid))?.recallMsg?.(valuableId))
    }
    for (const attempt of attempts) {
      let out
      try {
        out = attempt()
      } catch (error) {
        continue
      }
      if (out && typeof out.then === 'function') {
        try {
          const result = await out
          if (result !== false) return true
        } catch (error) {
          continue
        }
      } else if (out !== undefined && out !== null && out !== false) {
        return true
      }
    }
    deps.logger.warn(`[回响邮局] 撤回旧面板失败（可能超出撤回时限）：${messageId}`)
    return false
  }

  return { send, recall, activeSend, bump, counters }
}

/* ============================================================================
 * 7. 状态辅助（全部落在 store 提供的 users / groups / duels / panels 内）
 * ==========================================================================*/

function recordPresence(state, gid, uid, name, nowMs) {
  if (!gid || gid === '0') return
  const record = storeApi.group(state, gid)
  const presence = (record.presence && typeof record.presence === 'object') ? record.presence : (record.presence = {})
  presence[uid] = { name: name || uid, at: nowMs }
  const keys = Object.keys(presence)
  if (keys.length > 300) {
    keys.sort((a, b) => (presence[a]?.at || 0) - (presence[b]?.at || 0))
    for (const key of keys.slice(0, keys.length - 300)) delete presence[key]
  }
}

function collectProfiles(state, gid) {
  const out = []
  const seen = new Set()
  const record = state.groups?.[gid]
  for (const source of [record?.presence, record?.members]) {
    if (!source || typeof source !== 'object') continue
    const list = Array.isArray(source)
      ? source.map((value, index) => [String(value?.id ?? index), value])
      : Object.entries(source)
    for (const [id, value] of list) {
      if (seen.has(String(id))) continue
      const profile = state.users?.[id]
      if (profile && typeof profile === 'object') {
        if (!profile.id) profile.id = String(id)
        seen.add(String(id))
        out.push(profile)
      } else if (value && typeof value === 'object' && Object.keys(value).length > 1) {
        if (!value.id) value.id = String(id)
        seen.add(String(id))
        out.push(value)
      }
    }
    if (out.length) break
  }
  if (!out.length) {
    for (const [id, profile] of Object.entries(state.users || {})) {
      if (!profile || typeof profile !== 'object') continue
      const belongs = profile.gid === gid || profile.groupId === gid || profile.group_id === gid
        || profile.groups?.[gid] || profile.groupIds?.includes?.(gid) || profile.scene === gid
      if (!belongs) continue
      if (!profile.id) profile.id = String(id)
      out.push(profile)
    }
  }
  if (!out.length) {
    for (const [id, profile] of Object.entries(state.users || {})) {
      if (!profile || typeof profile !== 'object') continue
      if (!profile.id) profile.id = String(id)
      out.push(profile)
      if (out.length >= 60) break
    }
  }
  return out.slice(0, 100)
}

function prunePanels(state, nowMs) {
  const panels = state.panels || {}
  const keys = Object.keys(panels)
  if (!keys.length) return false
  let changed = false
  for (const key of keys) {
    const record = panels[key]
    const at = Number(record?.at) || 0
    if (nowMs - at > config.panelTtlMs) {
      delete panels[key]
      changed = true
    }
  }
  const rest = Object.keys(panels)
  if (rest.length > config.maxPanels) {
    rest.sort((a, b) => (Number(panels[a]?.at) || 0) - (Number(panels[b]?.at) || 0))
    for (const key of rest.slice(0, rest.length - config.maxPanels)) {
      delete panels[key]
      changed = true
    }
  }
  return changed
}

/* ============================================================================
 * 8. 对战：原子冻结 / 结算 / 超时
 * ==========================================================================*/

function duelEcho(duel) {
  if (!duel || typeof duel !== 'object') return null
  if (!duel.echo || typeof duel.echo !== 'object') {
    duel.echo = {
      phase: 'open',
      escrow: {},
      names: {},
      createdAt: Date.now(),
    }
  }
  const echo = duel.echo
  if (!echo.escrow || typeof echo.escrow !== 'object') echo.escrow = {}
  if (!echo.names || typeof echo.names !== 'object') echo.names = {}
  if (!echo.phase) echo.phase = 'open'
  return echo
}

/** 模块可能返回新的 duel 对象；把上一轮的托管/面板信息继承过来，避免押注丢失 */
function inheritEcho(record, previous) {
  const echo = duelEcho(record)
  const old = (previous && typeof previous === 'object' && previous.echo) ? previous.echo : {}
  echo.escrow = { ...(old.escrow || {}), ...(echo.escrow || {}) }
  echo.names = { ...(old.names || {}), ...(echo.names || {}) }
  echo.groupId = echo.groupId || old.groupId
  echo.initiator = echo.initiator || old.initiator
  echo.opponent = echo.opponent || old.opponent
  echo.stake = old.stake || echo.stake
  echo.createdAt = old.createdAt || echo.createdAt
  echo.messageId = echo.messageId || old.messageId
  echo.qq = echo.qq ?? old.qq
  return echo
}

function stakeOf(duel) {
  const value = Number(duel?.stake ?? duel?.echo?.stake)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function freezeStake(state, echo, uid, amount) {
  const profile = storeApi.user(state, uid)
  if (!hasWallet(profile)) return 'unknown'
  if (wallet(profile) < amount) return 'poor'
  setWallet(profile, wallet(profile) - amount)
  echo.escrow[uid] = (Number(echo.escrow[uid]) || 0) + amount
  return 'ok'
}

function refundEscrow(state, echo) {
  const refunded = []
  for (const [uid, amount] of Object.entries(echo.escrow || {})) {
    const value = Number(amount) || 0
    if (value <= 0) continue
    addWallet(storeApi.user(state, uid), value)
    refunded.push(`${displayOf(echo, uid)} +${value}`)
  }
  echo.escrow = {}
  return refunded
}

function awardWinner(state, echo, winnerId, pot) {
  if (!winnerId || !(winnerId in (echo.escrow || {}))) return false
  addWallet(storeApi.user(state, winnerId), pot)
  return true
}

/** 新模块用 winnerId / loserId / done 直接给出终局；旧桩仍可能只给 forceJudge */
function winnerFrom(duel, result, actorId) {
  const r = result && typeof result === 'object' ? result : {}
  const d = duel && typeof duel === 'object' ? duel : {}
  const explicit = pickFirst(r, ['winnerId', 'winner_id', 'winner', 'victor', 'champion'])
    ?? pickFirst(d, ['winnerId', 'winner_id', 'winner', 'victor'])
  if (explicit !== undefined && explicit !== null && explicit !== '') return String(explicit)
  if (r.forceJudge === true || r.force === true) return 'judge'
  const status = asText(pickFirst(r, ['status', 'state', 'phase'])) || asText(pickFirst(d, ['status', 'state']))
  const finished = r.done === true || r.finished === true || r.over === true || r.settled === true
    || d.done === true || d.finished === true || d.settled === true
    || /settled|finished|done|end|结算|结束/i.test(status)
  if (!finished) return undefined
  if (r.won === true || r.win === true || r.victory === true) return String(actorId)
  if (r.won === false || r.win === false) return 'other'
  if (r.draw === true || r.tie === true || d.draw === true) return null
  return null
}

/** 旧桩模块没给赢家时，按入口记录的抽卡明细判定：命中次数 → 抽数 → 出手次数 */
function judgeDuel(echo) {
  const pulls = echo?.pulls || {}
  const ids = Object.keys(pulls)
  if (ids.length < 2) return null
  const scored = ids.map((id) => {
    const entry = pulls[id] || {}
    return {
      id,
      success: Number(entry.success) || 0,
      pullCount: Number(entry.pullCount) || 0,
      count: Number(entry.count) || 0,
    }
  }).sort((a, b) => (b.success - a.success) || (b.pullCount - a.pullCount) || (b.count - a.count))
  const best = scored[0]
  const second = scored[1]
  if (!best || !second) return null
  if (best.success === second.success && best.pullCount === second.pullCount && best.count === second.count) return null
  return best.id
}

function resolveWinnerId(duel, winner, actorId) {
  if (winner === undefined) return undefined
  if (winner === 'judge') return judgeDuel(duel.echo || {}) || null
  if (winner === 'other') {
    const echo = duel.echo || {}
    return actorId === echo.initiator ? echo.opponent : echo.initiator
  }
  return winner
}

function settleDuel(state, duel, winnerId, options = {}) {
  const echo = duelEcho(duel)
  if (!echo || echo.phase === 'settled') return []
  const pot = Object.values(echo.escrow || {}).reduce((sum, amount) => sum + (Number(amount) || 0), 0)
  const lines = []
  const reasonText = options.reason === 'timeout' ? '（超时自动结算）' : ''
  if (winnerId && awardWinner(state, echo, String(winnerId), pot)) {
    lines.push(`${displayOf(echo, String(winnerId))} 赢下本局，彩池 +${pot}`)
  } else {
    const refunded = refundEscrow(state, echo)
    lines.push(refunded.length ? `本局流局，押注已原路退还：${refunded.join('、')}` : '本局流局，没有需要退还的押注')
  }
  echo.phase = 'settled'
  echo.winner = winnerId ? String(winnerId) : null
  echo.pot = pot
  echo.settledAt = options.nowMs || Date.now()
  echo.reason = options.reason || 'settled'
  echo.escrow = {}
  const tally = Object.entries(echo.pulls || {})
    .map(([id, entry]) => `${displayOf(echo, id)} ${Number(entry.count) || 0} 抽/命中 ${Number(entry.success) || 0}`)
    .join('｜')
  const spec = {
    title: '回响对战 · 结算',
    lead: [`${lines.join('\n')}`, tally, `押注 ${stakeOf(duel)}｜彩池 ${pot}`, reasonText].filter(Boolean).join('\n'),
    tiles: [],
    mode: 'row',
    footer: '本局按钮已失效，可发送 #回响约战 再开一局。',
    golden: !!winnerId,
  }
  const item = {
    kind: 'duel',
    duelId: String(duel.id),
    gid: echo.groupId || '0',
    uid: echo.initiator,
    qq: echo.qq,
    recall: [...(echo.messageId ? [String(echo.messageId)] : []), ...(echo.extraMessageIds || [])],
    spec,
    rows: [],
    stampOwner: null,
    forceActive: options.forceActive === true,
  }
  delete state.duels[duel.id]
  return [item]
}

function duelPanelSpec(duel, options = {}) {
  const echo = duel.echo || {}
  const stake = stakeOf(duel)
  const initiator = displayOf(echo, echo.initiator)
  const opponent = echo.opponent ? displayOf(echo, echo.opponent) : ''
  if (echo.phase === 'open') {
    return {
      title: '回响对战 · 约战',
      lead: [
        `${initiator} 挂出一场对战，押注 ${stake} 星屑。`,
        '群内任意成员都可以接受（不能接受自己的对战）。',
        `${Math.max(1, Math.round((echo.deadline - Date.now()) / 1000))} 秒内无人接受则自动退还押注。`,
      ].join('\n'),
      tiles: [],
      mode: 'row',
      footer: '押注在约战时就已冻结，结算或流局后原路处理。',
    }
  }
  const next = duel.nextPlayerId ? displayOf(echo, duel.nextPlayerId) : ''
  const turn = Number(duel.turn) || Number(duel.turns) || 0
  return {
    title: '回响对战 · 抽卡',
    lead: [
      `${initiator} 对 ${opponent || '对手'}`,
      next ? `轮到 ${next}。` : '轮流单抽，抽到歪的一方输。',
      `押注 ${stake}｜彩池 ${stake * 2}`,
      `已抽 ${turn} 抽。每抽约 5% 起、每抽 +8%，第 12 抽强制歪；60 秒内没有新操作则当前轮玩家判负。`,
    ].filter(Boolean).join('\n'),
    tiles: [],
    mode: 'row',
    footer: '抽卡按钮只能由轮到的本人按下。',
  }
}

/* ============================================================================
 * 9. 引擎
 * ==========================================================================*/

export function createEngine(options = {}) {
  const deps = {
    store: options.store || storeApi,
    presentation: options.presentation ? normalizePresentation(options.presentation) : null,
    games: {
      rewards: options.games?.rewards || null,
      adventures: options.games?.adventures || null,
    },
    transport: null,
    timers: options.timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    now: options.now || (() => new Date()),
    rng: options.rng || (() => makeRng()),
    logger: options.logger || loggerShim,
    config: { ...config, ...(options.config || {}) },
    autoSweep: options.autoSweep !== false,
    explicitCooldown: options.config?.cooldownSeconds !== undefined,
  }
  deps.transport = options.transport || createTransport(deps)

  const duelTimers = new Map()
  let sweepHandle = null
  let disposed = false
  let ready = null
  let loadNotes = []

  async function ensure() {
    if (!ready) {
      ready = (async () => {
        if (!deps.presentation) {
          try {
            const mod = await import('../lib/presentation.js')
            deps.presentation = normalizePresentation(mod)
          } catch (error) {
            loadNotes.push(`presentation: ${error?.message || error}`)
            deps.presentation = normalizePresentation(null)
          }
        }
        if (!deps.explicitCooldown && Number(deps.presentation.settings?.cooldownSeconds) > 0) {
          deps.config.cooldownSeconds = Number(deps.presentation.settings.cooldownSeconds)
        }
        if (!deps.games.rewards) {
          try {
            deps.games.rewards = await import('../lib/rewards.js')
            deps.rewardsSource = 'lib/rewards.js'
          } catch (error) {
            deps.games.rewards = null
            loadNotes.push(`rewards: ${error?.message || error}`)
            deps.rewardsSource = '缺失'
          }
        } else {
          deps.rewardsSource = options.games?.rewards ? '注入' : 'lib/rewards.js'
        }
        if (!deps.games.adventures) {
          try {
            deps.games.adventures = await import('../lib/adventures.js')
            deps.adventuresSource = 'lib/adventures.js'
          } catch (error) {
            deps.games.adventures = null
            loadNotes.push(`adventures: ${error?.message || error}`)
            deps.adventuresSource = '缺失'
          }
        } else {
          deps.adventuresSource = options.games?.adventures ? '注入' : 'lib/adventures.js'
        }
        return deps
      })()
    }
    return ready
  }

  function nowMs() {
    const value = deps.now()
    return value instanceof Date ? value.getTime() : Number(value)
  }

  /* ------------------------------ 模块调用适配 ------------------------------ */

  async function callGame(ctx, moduleKey, fnName, args) {
    const mod = ctx.games[moduleKey]
    const label = moduleKey === 'rewards' ? 'rewards.js' : 'adventures.js'
    if (!mod) return { error: `${label} 尚未就绪，该玩法暂不可用。`, missing: true }
    const names = [fnName, ...(ALT_NAMES[fnName] || [])]
    let fn = null
    for (const name of names) {
      if (typeof mod[name] === 'function') {
        fn = mod[name]
        break
      }
    }
    if (!fn) return { error: `${label} 缺少 ${fnName}()，该玩法暂不可用。`, missing: true }
    const variants = [args]
    const trimmed = [...args]
    while (trimmed.length && trimmed[trimmed.length - 1] === undefined) {
      trimmed.pop()
      variants.push([...trimmed])
    }
    let lastError = null
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index]
      try {
        const raw = await fn.apply(mod, variant)
        if (raw === undefined || raw === null) {
          lastError = new Error(`${fnName}() 未返回 {profile,result}`)
        } else if (!isResultish(raw)) {
          lastError = new Error(`${fnName}() 返回值不符合 {profile,result,error}`)
        } else {
          const output = unwrapResult(raw, ctx.profile)
          if (!output.error) {
            const notice = recordCompanionActivity(ctx.profile, ctx.day, fnName, output.result)
            if (notice) (ctx.companionNotices ||= []).push(notice)
          }
          return output
        }
      } catch (error) {
        lastError = error
      }
      const next = variants[index + 1]
      const dropped = Array.isArray(next) ? args.slice(next.length) : []
      const droppable = dropped.length > 0 && dropped.every((value) => value === undefined)
      const retryable = droppable && looksLikeTypeError(lastError)
      if (!retryable) break
      ctx.logger.warn(`[回响邮局] ${moduleKey}.${fnName}() 参数不匹配，按更短签名重试一次：${firstLine(lastError?.message)}`)
    }
    ctx.logger.warn(`[回响邮局] ${moduleKey}.${fnName}() 调用失败：${lastError?.stack || lastError}`)
    return { error: `${fnName}() 调用失败：${firstLine(lastError?.message) || errorText(lastError) || '未知错误'}`, thrown: true }
  }

  /* ------------------------------ 面板计划 ------------------------------ */

  function createPlan(ctx) {
    const items = []
    const key = panelKey(ctx.gid, ctx.uid)
    return {
      items,
      panel(spec, rows, meta = {}) {
        const previous = ctx.state.panels[key]
        const token = randomToken()
        ctx.state.panels[key] = {
          gid: ctx.gid,
          uid: ctx.uid,
          token,
          kind: meta.kind || 'panel',
          at: ctx.nowMs,
          message_id: null,
          turns: (Number(previous?.turns) || 0) + 1,
          scratch: meta.scratch !== undefined ? meta.scratch : previous?.scratch,
        }
        items.push({
          kind: 'panel',
          key,
          gid: ctx.gid,
          uid: ctx.uid,
          qq: isQQBot(ctx.e),
          token,
          recall: [...(previous?.message_id ? [String(previous.message_id)] : []), ...(previous?.extraMessageIds || [])],
          previous: previous ? { ...previous } : null,
          spec,
          rows,
          stampOwner: `${ctx.uid}#${token}`,
        })
        return { items }
      },
      notice(spec, rows = [], meta = {}) {
        items.push({
          kind: 'notice',
          gid: ctx.gid,
          uid: ctx.uid,
          spec,
          rows,
          stampOwner: null,
          ...meta,
        })
        return { items }
      },
      duel(spec, rows, duel, meta = {}) {
        const echo = duelEcho(duel) || {}
        items.push({
          kind: 'duel',
          duelId: String(duel.id),
          gid: ctx.gid,
          uid: ctx.uid,
          qq: echo.qq ?? isQQBot(ctx.e),
          recall: [...(echo.messageId ? [String(echo.messageId)] : []), ...(echo.extraMessageIds || [])],
          spec,
          rows,
          stampOwner: null,
          ...meta,
        })
        return { items }
      },
    }
  }

  /* ------------------------------ 交付 ------------------------------ */

  async function recordPanelMessage(item, messageId, extraMessageIds = []) {
    await deps.store.transaction((state) => {
      const record = state.panels?.[item.key]
      if (!record || record.token !== item.token) return { commit: false }
      record.message_id = String(messageId)
      record.extraMessageIds = extraMessageIds
      record.at = nowMs()
      return { commit: true }
    })
  }

  async function recordDuelMessage(item, messageId, extraMessageIds = []) {
    await deps.store.transaction((state) => {
      const duel = state.duels?.[item.duelId]
      if (!duel) return { commit: false }
      const echo = duelEcho(duel)
      if (!echo) return { commit: false }
      echo.messageId = String(messageId)
      echo.extraMessageIds = extraMessageIds
      return { commit: true }
    })
  }
  async function deliverPlan(plan, e) {
    const items = plan?.items || []
    for (const item of items) {
      const rows = stampRows(item.rows, item.stampOwner)
      const message = await renderItem(deps, item, rows, e)
      let sent = null
      try {
        sent = await deps.transport.send(e, item, message)
      } catch (error) {
        deps.logger.warn(`[回响邮局] 发送失败，保留上一条面板：${error?.message || error}`)
      }
      const hasImage = Array.isArray(message) && message.some(part => part?.type === 'image' || (part?.type === 'raw' && part.data?.type === 'image'))
      if (hasImage && (!pickMessageId(sent) || sent?.needsFallback)) {
        const previousImageId = pickMessageId(sent)
        deps.logger.warn('[回响邮局] 图片或按钮发送失败，改用文字结果与按钮。')
        try {
          const fallback = (item.qq ?? isQQBot(e))
            ? deps.presentation.markdown(item.spec || {}, rows, markdownBody(item.spec || {}))
            : plainText(item.spec || {}, rows)
          const fallbackSent = await deps.transport.send(e, item, fallback)
          if (pickMessageId(fallbackSent)) sent = { message_id: pickMessageId(fallbackSent), extraMessageIds: previousImageId ? [previousImageId] : [] }
          else sent = null
        } catch {
          deps.logger.warn('[回响邮局] 文字回退发送失败，保留上一条面板。')
          sent = null
        }
      }
      const messageId = pickMessageId(sent)
      if (!messageId) {
        // 不撤回已显示的面板，恢复它的按钮令牌。
        if (item.kind === 'panel') {
          await deps.store.transaction(state => {
            if (state.panels?.[item.key]?.token !== item.token) return { commit: false }
            if (item.previous) state.panels[item.key] = item.previous
            else delete state.panels[item.key]
            return { commit: true }
          })
        }
        deps.logger.warn(`[回响邮局] 消息未取得 message_id，未撤回上一条面板（group=${item.gid}）`)
        continue
      }
      if (item.kind === 'panel') await recordPanelMessage(item, messageId, sent?.extraMessageIds || [])
      if (item.kind === 'duel') await recordDuelMessage(item, messageId, sent?.extraMessageIds || [])
      for (const oldId of item.recall || []) {
        try { await deps.transport.recall(e, item.gid, oldId) }
        catch (error) { deps.logger.warn(`[回响邮局] 撤回异常：${error?.message || error}`) }
      }
    }
    return items.length
  }

  /* ------------------------------ 定时器 ------------------------------ */

  function clearDuelTimer(duelId) {
    const handle = duelTimers.get(String(duelId))
    if (handle !== undefined && handle !== null) deps.timers.clearTimeout(handle)
    duelTimers.delete(String(duelId))
  }

  function armDuelTimer(duelId, deadline) {
    clearDuelTimer(duelId)
    const delay = Math.max(0, Number(deadline) - nowMs())
    const handle = deps.timers.setTimeout(() => {
      duelTimers.delete(String(duelId))
      void sweep('timer').catch((error) => deps.logger.warn(`[回响邮局] 超时结算异常：${error?.stack || error}`))
    }, Math.min(delay, deps.config.duelTimeoutMs + 5000))
    if (handle && typeof handle.unref === 'function') handle.unref()
    duelTimers.set(String(duelId), handle)
  }

  function startSweeper() {
    if (sweepHandle || disposed || !deps.autoSweep) return
    const interval = Number(deps.config.sweepIntervalMs)
    if (!(interval > 0)) return
    const loop = () => {
      if (disposed) return
      const handle = deps.timers.setTimeout(async () => {
        sweepHandle = null
        try {
          await sweep('interval')
        } catch (error) {
          deps.logger.warn(`[回响邮局] 巡检异常：${error?.stack || error}`)
        }
        loop()
      }, interval)
      if (handle && typeof handle.unref === 'function') handle.unref()
      sweepHandle = handle
    }
    loop()
  }

  /** 超时巡检：结算所有到期的对战（定时器与启动恢复共用） */
  async function sweep(reason = 'manual') {
    await ensure()
    const plan = await deps.store.transaction(async (state) => {
      const now = nowMs()
      const due = []
      for (const [id, duel] of Object.entries(state.duels || {})) {
        const echo = duel?.echo
        if (!echo) continue
        const last = Number(duel.lastAction)
        const dueAt = Number.isFinite(last) && last > 0
          ? last + Number(deps.config.duelTimeoutMs)
          : Number(echo.deadline)
        if (!(dueAt <= now)) continue
        due.push([id, duel])
      }
      if (!due.length) return { commit: false, items: [] }
      const items = []
      for (const [id, duel] of due) {
        const out = await callGame({ ...baseCtxFor(state), state }, 'adventures', 'duelExpire', [duel, new Date(now)])
        const record = out.duel && typeof out.duel === 'object' ? out.duel : duel
        if (!record.id) record.id = duel.id
        inheritEcho(record, duel)
        const ended = out.result?.done === true || ['finished', 'expired'].includes(record.status)
        if (!out.missing && !ended) {
          const last = Number(record.lastAction) || now
          items.push({ kind: 'timer-rearm', duelId: String(id), deadline: last + Number(deps.config.duelTimeoutMs) })
          continue
        }
        const explicit = out.result && typeof out.result === 'object' && Object.prototype.hasOwnProperty.call(out.result, 'winnerId')
        const winner = out.missing
          ? null
          : (explicit
            ? (out.result.winnerId == null || out.result.winnerId === '' ? null : String(out.result.winnerId))
            : resolveWinnerId(record, winnerFrom(record, out.result, ''), ''))
        items.push(...settleDuel(state, record, winner === undefined ? null : winner, { reason: 'timeout', nowMs: now }))
        items.push({ kind: 'timer-clear', duelId: String(id) })
      }
      return { commit: true, items }
    })
    for (const item of plan?.items || []) {
      if (item.kind === 'timer-clear') clearDuelTimer(item.duelId)
      if (item.kind === 'timer-rearm') armDuelTimer(item.duelId, item.deadline)
    }
    const deliverable = (plan?.items || []).filter((item) => item.kind !== 'timer-clear' && item.kind !== 'timer-rearm')
    if (deliverable.length) await deliverPlan({ items: deliverable }, null)
    return deliverable.length
  }

  /** 启动恢复：清理过期面板、结算过期对战、为存活对战重新装定时器 */
  async function recover() {
    await ensure()
    await deps.store.transaction((state) => {
      const changed = prunePanels(state, nowMs())
      return { commit: changed }
    })
    await sweep('recover')
    const state = await deps.store.snapshot()
    let armed = 0
    for (const [id, duel] of Object.entries(state.duels || {})) {
      const echo = duel?.echo
      if (!echo?.deadline) continue
      armDuelTimer(id, echo.deadline)
      armed += 1
    }
    startSweeper()
    deps.logger.info(`[回响邮局] 启动恢复完成：恢复 ${armed} 场对战计时`)
    return { armed, panels: Object.keys(state.panels || {}).length }
  }

  function dispose() {
    disposed = true
    for (const duelId of [...duelTimers.keys()]) clearDuelTimer(duelId)
    if (sweepHandle !== null) deps.timers.clearTimeout(sweepHandle)
    sweepHandle = null
  }

  /* ------------------------------ 上下文 ------------------------------ */

  function baseCtxFor(state, e) {
    const now = deps.now()
    const nowDate = now instanceof Date ? now : new Date(Number(now))
    const gid = e ? sceneId(e) : '0'
    const uid = e ? actorId(e) : ''
    const ctx = {
      state,
      e,
      gid,
      uid,
      day: deps.store.today(nowDate),
      now: nowDate,
      nowMs: nowDate.getTime(),
      games: deps.games,
      config: deps.config,
      logger: deps.logger,
      presentation: deps.presentation,
      store: deps.store,
      rng: () => deps.rng(),
      // 处理器可用：对战定时器开关 + 依赖自检信息
      timers: { arm: armDuelTimer, clear: clearDuelTimer },
      deps: {
        rewardsSource: deps.rewardsSource,
        adventuresSource: deps.adventuresSource,
        __timers: duelTimers,
        loadNotes,
      },
      profile: null,
      plan: null,
    }
    // 处理器通过 ctx.call() 调用纯逻辑模块（内部已做签名适配与降级）
    ctx.call = (moduleKey, fnName, args) => callGame(ctx, moduleKey, fnName, args)
    return ctx
  }

  /* ------------------------------ 命令入口 ------------------------------ */

  async function handle(e, options = {}) {
    await ensure()
    const raw = String(options.input ?? extractInput(e) ?? '').trim()
    if (!raw) return { handled: false, reason: 'no-input' }
    const command = parseCommand(raw)
    if (!command) return { handled: false, reason: 'not-echo-command' }
    const uid = actorId(e)
    if (!uid) return { handled: false, reason: 'no-user' }
    const gid = sceneId(e)
    // 按钮回调：既支持适配器给出的 button 字段，也支持「命令|操作人#令牌」这种回显文本
    const fromButton = !!extractButtonData(e) || command.callback || !!command.ownerId

    // 1) 按钮参数限定本人（按钮 payload 里带操作人）
    if (command.ownerId && command.ownerId !== uid) {
      const ctx = baseCtxFor(await deps.store.snapshot(), e)
      ctx.uid = uid
      const spec = errorSpec('按钮归属', `这条按钮属于另一位玩家，请自己发送 ${config.prefix} 打开面板。`)
      await deps.transport.send(e, { gid, uid }, await renderItem(deps, { spec }, [], e))
      return { handled: true, reason: 'owner-mismatch' }
    }

    // 2) 2 秒防刷
    if (await checkCd(cooldownKey(gid, uid, command.family), deps.config.cooldownSeconds)) {
      deps.logger.info(`[回响邮局] 冷却拦截 ${gid}:${uid} ${command.name}`)
      if (fromButton) {
        const spec = errorSpec('请稍后再按', `冷却中（${deps.config.cooldownSeconds} 秒），请稍后再按。`)
        await deps.transport.send(e, { gid, uid }, await renderItem(deps, { spec }, [], e))
      }
      return { handled: true, reason: 'cooldown' }
    }

    const plan = await deps.store.transaction(async (state) => {
      const ctx = baseCtxFor(state, e)
      ctx.command = command
      ctx.args = command.args
      ctx.fromButton = fromButton
      ctx.profile = storeApi.user(state, uid)
      if (!ctx.profile.id) ctx.profile.id = uid
      recordPresence(state, gid, uid, senderName(e), ctx.nowMs)
      ctx.plan = createPlan(ctx)

      // 事务内再校验一次按钮归属与面板令牌（防止旧按钮复点 / 跨群复用）
      if (command.token && command.family !== 'menu') {
        const record = state.panels[panelKey(gid, uid)]
        const valid = record && record.token === command.token && record.gid === gid && record.uid === uid
        if (!valid) {
          ctx.plan.panel(errorSpec(command.title, '这条面板已经过期（新面板会撤回旧面板），请重新发送 #回响 打开。'), [
            [['重新打开面板', `${config.prefix}`, '*']],
          ], { kind: 'expired' })
          return { commit: true, items: ctx.plan.items }
        }
      }

      const handler = HANDLERS[command.name] || HANDLERS.menu
      const result = await handler(ctx)
      const items = result?.items || ctx.plan.items
      if (ctx.companionNotices?.length && items.at(-1)?.spec) {
        const spec = items.at(-1).spec
        spec.footer = [spec.footer, ...ctx.companionNotices].filter(Boolean).join('\n')
      }
      return { commit: result?.commit !== false, items }
    })

    const sent = await deliverPlan(plan, e)
    return { handled: true, command: command.name, sent }
  }

  const engine = { handle, recover, sweep, dispose, ensure, deps, __timers: duelTimers }
  return engine
}

function errorSpec(title, message) {
  return { title: title || '回响邮局', lead: message, tiles: [], mode: 'row', footer: '若持续失败，可发送 #回响自检 查看状态。' }
}

/* ============================================================================
 * 10. 各玩法处理器
 * ==========================================================================*/

function footerOf(ctx) {
  return `星屑 ${wallet(ctx.profile)}｜${ctx.day}`
}

function backRows() {
  return [
    [['返回菜单', `${config.prefix}`, '*']],
  ]
}

function profileBrief(ctx) {
  const parts = [`星屑 ${wallet(ctx.profile)}`]
  const labels = { ten: '十连', scratch: '刮刮乐', bag: '福袋' }
  const remaining = ctx.games?.rewards?.remainingDaily
  if (typeof remaining === 'function') {
    try {
      const info = remaining(ctx.profile, ctx.day)
      const limit = (info && info.limit) || {}
      const values = Object.keys(labels)
        .filter((key) => info && info[key] !== undefined && info[key] !== null)
        .map((key) => `${labels[key]} ${info[key]}/${limit[key] ?? '?'}`)
      if (values.length) parts.push(`今日剩余 ${values.join('｜')}`)
    } catch (error) {
      ctx.logger?.warn?.(`[回响邮局] remainingDaily 读取失败：${error?.message || error}`)
    }
  } else {
    const container = pickFirst(ctx.profile, ['daily', 'today', 'limits', 'quota', 'counters'])
    if (container && typeof container === 'object') {
      const scoped = container[ctx.day] ?? container
      if (scoped && typeof scoped === 'object') {
        const summary = summarize(scoped, 4)
        if (summary) parts.push(summary)
      }
    }
  }
  const level = pickFirst(ctx.profile, ['level', 'lv', 'grade', 'rank'])
  if (typeof level === 'number' || typeof level === 'string') parts.push(`等级 ${level}`)
  if (!hasWallet(ctx.profile)) parts.push('未识别星屑字段')
  return parts.join('｜')
}

const HANDLERS = {}

const companionRows = () => [
  [['一起十连', `${config.prefix}十连`], ['一起派遣', `${config.prefix}派遣`], ['一起刮卡', `${config.prefix}刮刮乐`]],
  [['同行奖励', `${config.prefix}同行奖励`], ['同行收藏', `${config.prefix}同行收藏`], ['返回菜单', `${config.prefix}`]],
]
HANDLERS.wife = async ctx => {
  const result = meetCompanion(ctx.profile, ctx.uid, ctx.day, await loadCompanionRoster())
  const spec = result.error ? { title: '今日老婆', lead: result.error, tiles: [] } : companionPanel(ctx.profile, ctx.day)
  return ctx.plan.panel(spec, companionRows(), { kind: 'wife' })
}
HANDLERS.wifeReward = async ctx => {
  const result = claimCompanionReward(ctx.profile, ctx.day)
  const spec = companionPanel(ctx.profile, ctx.day)
  spec.lead = [result.error || result.text, spec.lead].filter(Boolean).join('\n')
  return ctx.plan.panel(spec, companionRows(), { kind: 'wife' })
}
HANDLERS.wifeCollection = async ctx => ctx.plan.panel(companionCollection(ctx.profile), [[['今日老婆', `${config.prefix}今日老婆`], ['返回菜单', `${config.prefix}`]]], { kind: 'wife' })


HANDLERS.menu = async (ctx) => {
  const brief = profileBrief(ctx).split('｜').slice(1).join('｜').replace(/^今日剩余\s*/, '')
  const lead = [`星屑 ${wallet(ctx.profile)} · ${ctx.day}`, brief].filter(Boolean).join('\n')
  const rows = [
    [['十连补给', `${config.prefix}十连`], ['星愿刮刮乐', `${config.prefix}刮刮乐`], ['连锁福袋', `${config.prefix}福袋`]],
    [['今日档案', `${config.prefix}档案`], ['派遣出发', `${config.prefix}派遣`], ['歪不歪', `${config.prefix}约战`]],
    [['个人收藏馆', `${config.prefix}图鉴`], ['兑换奖励', `${config.prefix}兑换`], ['派遣领取', `${config.prefix}领取`]],
    [['玩法说明', `${config.prefix}玩法`], ['群排行', `${config.prefix}排行`], ['派遣相册', `${config.prefix}相册`]],
    [['今日老婆', `${config.prefix}今日老婆`], ['同行收藏', `${config.prefix}同行收藏`], ['同行奖励', `${config.prefix}同行奖励`]],
  ]
  return ctx.plan.panel({ title: '回响邮局', lead, tiles: [], mode: 'row', footer: '' }, rows, { kind: 'menu' })
}

const GAME_HELP = [
  { key: '今日老婆', label: '今日老婆', rule: '每天领取一位鸣潮女角色，当天固定，亲密度跨天保留。', action: '先领取，再完成十连、刮卡、福袋、派遣、档案作答或图鉴兑换；每类每天只计一次。', reward: '每类亲密度 +2；完成三类可领取星屑 +10、亲密度 +5，每天一次。', start: '今日老婆' },
  { key: '十连', label: '十连补给', rule: '每天免费十连 2 次；每 30 抽必出金，金卡必为 UP。', action: '点「开始十连」，结果一张图；重复卡变成星屑。', reward: '收集原创信件与套系，星屑可兑换指定卡。', start: '十连' },
  { key: '刮刮乐', label: '星愿刮刮乐', rule: '每天 2 张，九格必有中奖线；三连同图是大奖。', action: '点「一键全刮」，也能逐格刮开。', reward: '领取星屑，大奖可能附赠金卡。', start: '刮刮乐 全刮' },
  { key: '福袋', label: '连锁福袋', rule: '每天 1 次；福袋可能再开出福袋，最多 12 连。', action: '点「打开福袋」自动走完整条连锁。', reward: '连锁越长奖励越好，10 连及以上解锁称号。', start: '福袋' },
  { key: '收藏馆', label: '个人收藏馆', rule: '十连、刮刮乐与福袋获得的卡都汇总在这里。', action: '看套系进度；点「展示收藏」发一张图，或佩戴已拥有的称号和边框。', reward: '集齐套系解锁专属称号和边框。', start: '图鉴' },
  { key: '档案', label: '今日档案', rule: '全群每天同一位角色；看剪影和线索猜名字。', action: '点候选按钮作答；每人最多猜 3 次，猜错多一条线索。', reward: '猜对累计连胜，昨日答案今天公布；可看群排行。', start: '档案' },
  { key: '派遣', label: '派遣日志', rule: '每天选一个鸣潮地点派遣一次。', action: '点「选择地点」出发，次日点「领取收获」。', reward: '收集见闻、材料和纪念品；集齐地点获得称号。', start: '派遣' },
  { key: '对战', label: '歪不歪', rule: '发起约战，对手接受后轮流单抽，先歪的人输。', action: '可押注星屑；每抽歪率递增，60 秒无人操作自动结算。', reward: '赢家拿走双方押注的星屑。', start: '约战' },
]
HANDLERS.help = async (ctx) => {
  const key = ctx.args[0]
  const aliases = { 今日档案: '档案', 歪不歪: '对战', 图鉴: '收藏馆', 十连补给: '十连', 星愿刮刮乐: '刮刮乐', 连锁福袋: '福袋', 派遣日志: '派遣' }
  const game = GAME_HELP.find(item => item.key === (aliases[key] || key))
  if (game) return ctx.plan.panel({ title: game.label, lead: `一句话：${game.rule}\n怎么玩：${game.action}\n能得到：${game.reward}`, tiles: [], footer: '' }, [
    [[`开始${game.label}`.slice(0, 12), `${config.prefix}${game.start}`], ['其他玩法', `${config.prefix}玩法`]],
    [['返回菜单', `${config.prefix}`]],
  ], { kind: 'help' })
  const rows = []
  for (let index = 0; index < GAME_HELP.length; index += 3) rows.push(GAME_HELP.slice(index, index + 3).map(item => [item.label, `${config.prefix}玩法 ${item.key}`]))
  rows.push([['返回菜单', `${config.prefix}`]])
  return ctx.plan.panel({ title: '玩法说明', lead: '选一个玩法，查看规则和奖励；想玩就点「开始」。', tiles: [], footer: '' }, rows, { kind: 'help' })
}

HANDLERS.selfCheck = async (ctx) => {
  const deps = ctx.deps || null
  const state = ctx.state
  const duelCount = Object.keys(state.duels || {}).length
  const armed = deps?.__timers ? deps.__timers.size : '未知'
  const lines = [
    `适配器：${asText(ctx.e?.adapter_id) || '未知'}｜QQBot 模式：${isQQBot(ctx.e) ? '是' : '否'}`,
    `渲染模块：${ctx.presentation?.source || '未知'}`,
    `rewards.js：${deps?.rewardsSource || '未知'}`,
    `adventures.js：${deps?.adventuresSource || '未知'}`,
    `状态后端：${globalThis.redis ? 'Redis 优先' : 'JSON 文件兜底'}`,
    `星屑字段：${walletPath(ctx.profile) ? walletPath(ctx.profile).join('.') : '未识别'}`,
    `面板记录：${Object.keys(state.panels || {}).length} 条｜进行中对战：${duelCount} 场｜已装定时器：${armed}`,
    `冷却：${ctx.config.cooldownSeconds}s｜被动回复上限：${ctx.config.maxPassiveReplies} 次｜对战超时：${Math.round(ctx.config.duelTimeoutMs / 1000)}s`,
  ]
  return ctx.plan.panel({ title: '回响自检', lead: lines.join('\n'), tiles: [], mode: 'row', footer: 'QQ 群环境仍需真机确认：键盘回调字段、主动群发链路、撤回时限。' }, backRows(), { kind: 'selfCheck' })
}

HANDLERS.draw = async (ctx) => {
  const out = await ctx.call('rewards', 'drawTen', [ctx.profile, ctx.day, ctx.rng()])
  if (out.error) return ctx.plan.panel(errorSpec('回响十连', out.error), backRows(), { kind: 'draw' })
  const spec = specFromResult(out.result, { title: '回响十连', mode: 'grid', kind: 'cards', footer: footerOf(ctx) })
  if (Array.isArray(spec.tiles) && spec.tiles.length === 10) {
    spec.mode = 'row'
    const summary = out.result?.summary || {}
    const golds = Number(summary.rarityCount?.SSR) || 0
    spec.lead = `新卡 ${summary.newCount ?? 0} · 重复 ${summary.dupeCount ?? 0} · 星屑 +${summary.stardust ?? 0}${golds ? ` · 出金 ${golds}（必为 UP）` : ''}`
  }
  return ctx.plan.panel(spec, [
    [['再来十连', `${config.prefix}十连`], ['我的图鉴', `${config.prefix}图鉴`]],
    backRows()[0],
  ], { kind: 'draw' })
}

HANDLERS.scratch = async (ctx) => {
  const first = String(ctx.args[0] || '')
  const wantsAll = /^(全刮|全部|all)$/i.test(first)
  const cells = Number(ctx.config.scratchCells) || 9
  // rewards.js 的约定：scratch() 开票（消耗当日张数并结算奖励），advanceScratch() 只推进揭格进度
  const rewards = ctx.games.rewards
  const advance = typeof rewards?.advanceScratch === 'function' ? rewards.advanceScratch : null
  const view = typeof rewards?.scratchView === 'function' ? rewards.scratchView : null
  const quota = Number(rewards?.rewardsConfig?.dailyScratch) || Number(ctx.config.maxScratchRounds) || 2
  const pendingOf = () => {
    const pending = ctx.profile?.scratch?.pending
    if (!pending || typeof pending !== 'object') return null
    return pending.reveal?.done === true ? null : pending
  }
  const count = wantsAll
    ? cells
    : (/^(三格|3格)$/i.test(first) ? 3 : (/^\d+$/.test(first) ? Math.max(1, Math.min(Number(first), cells)) : 1))
  const texts = []
  let last = null
  let error = ''
  let opened = 0
  let advanced = 0

  const collect = (result) => {
    const line = asText(pickFirst(result && typeof result === 'object' ? result : {}, ['text', 'message', 'note']))
    if (line && !texts.includes(line)) texts.push(line)
    return result
  }
  const openTicket = async () => {
    const out = await ctx.call('rewards', 'scratch', [ctx.profile, ctx.day, ctx.rng()])
    if (out.error) {
      error = out.error
      return false
    }
    last = collect(out.result)
    opened += 1
    return true
  }
  const revealSome = async () => {
    const pending = pendingOf()
    if (!pending) return false
    const total = Number(pending.reveal?.total) || cells
    const shown = Number(pending.reveal?.shown) || 0
    const take = Math.max(1, Math.min(count, total - shown))
    const out = await ctx.call('rewards', 'advanceScratch', [ctx.profile, take])
    if (out.error) {
      error = out.error
      return false
    }
    last = collect(out.result)
    advanced += take
    return true
  }

  const guard = quota * (cells + 2) + 2
  if (wantsAll && !advance) {
    // 模块没有揭格接口：用多次 scratch() 直到当日额度用完
    for (let index = 0; index < guard; index += 1) {
      if (!(await openTicket())) break
      const used = Number(ctx.profile?.daily?.scratch) || opened
      if (used >= quota) break
    }
  } else if (wantsAll) {
    for (let index = 0; index < guard; index += 1) {
      if (!pendingOf() && !(await openTicket())) break
      if (!(await revealSome())) break
      if (pendingOf()) continue
      const used = Number(ctx.profile?.daily?.scratch) || opened
      if (used >= quota) break
    }
  } else if (advance || view) {
    if (!pendingOf()) await openTicket()
    if (pendingOf()) await revealSome()
    else if (view) {
      const out = await ctx.call('rewards', 'scratchView', [ctx.profile])
      if (!out.error) last = collect(out.result)
    }
  } else {
    await openTicket()
  }

  if (!last && error) return ctx.plan.panel(errorSpec('回响刮刮乐', error), backRows(), { kind: 'scratch' })
  const reveal = last && typeof last === 'object' ? (last.reveal || last.ticket?.reveal || {}) : {}
  const shown = Number(reveal.shown) || 0
  const total = Number(reveal.total) || cells
  const used = Number(ctx.profile?.daily?.scratch) || opened
  const spec = specFromResult(last || {}, {
    title: '回响刮刮乐',
    mode: 'scratch',
    kind: 'cards',
    maxTiles: cells,
    footer: `${footerOf(ctx)}｜本张 ${shown}/${total}｜今日已用 ${used}/${quota}${error ? `｜${error}` : ''}`,
  })
  // 只保留 last 的正文；openTicket 和 advanceScratch 的过程文案会互相矛盾。
  if (shown < total) spec.footer = `本张 ${shown}/${total}｜今日已用 ${used}/${quota}${error ? `｜${error}` : ''}`
  if (!spec.tiles.length) {
    spec.tiles = Array.from({ length: cells }, (_, index) => ({
      kind: 'cards',
      name: `第 ${index + 1} 格`,
      meta: index < shown ? '已揭开' : '等待拆封',
      hidden: index >= shown,
      symbol: index >= shown ? '？' : '✦',
    }))
  }
  const rows = [
    [['刮一格', `${config.prefix}刮刮乐 一格`], ['刮三格', `${config.prefix}刮刮乐 三格`], ['全刮', `${config.prefix}刮刮乐 全刮`]],
    [['我的图鉴', `${config.prefix}图鉴`], ['奖励兑换', `${config.prefix}兑换`], ['返回菜单', `${config.prefix}`]],
  ]
  return ctx.plan.panel(spec, rows, { kind: 'scratch', scratch: { shown, total, at: ctx.nowMs } })
}

HANDLERS.bag = async (ctx) => {
  const out = await ctx.call('rewards', 'bag', [ctx.profile, ctx.day, ctx.rng()])
  if (out.error) return ctx.plan.panel(errorSpec('回响福袋', out.error), backRows(), { kind: 'bag' })
  const spec = specFromResult(out.result, { title: '连锁福袋', mode: 'row', kind: 'cards', footer: footerOf(ctx) })
  if (Array.isArray(out.result?.links) && out.result.links.length) {
    spec.tiles = out.result.links.map((link, index) => link.card?.tile || { id: `bag_${index + 1}`, kind: 'cards', type: '信物', name: `第 ${index + 1} 袋`, meta: `星屑 +${link.stardust || 0}`, rarity: index >= 9 ? 'gold' : index >= 4 ? 'purple' : 'R' })
    spec.mode = 'row'
  }
  return ctx.plan.panel(spec, [
    [['再开福袋', `${config.prefix}福袋`], ['我的图鉴', `${config.prefix}图鉴`]],
    backRows()[0],
  ], { kind: 'bag' })
}

async function buildCatalog(ctx) {
  const rewards = ctx.games.rewards
  const config2 = pickFirst(rewards, ['rewardsConfig', 'rewardConfig', 'config', 'catalog'])
  const fields = ['redeemables', 'redeem', 'rewards', 'shop', 'items', 'list', 'cards', 'collection', 'entries']
  if (config2 && typeof config2 === 'object') {
    for (const field of fields) {
      if (config2[field] === undefined || config2[field] === null) continue
      const entries = entriesFrom(config2[field]).filter((item) => item.entry && typeof item.entry === 'object')
      if (entries.length) return entries
    }
  }
  const cards = pickFirst(rewards, ['redeemables', 'cards', 'cardList', 'pool'])
  if (cards !== undefined && cards !== null) {
    const entries = entriesFrom(cards).filter((item) => item.entry && typeof item.entry === 'object')
    if (entries.length) return entries
  }
  return []
}

function catalogId(item) {
  const entry = item.entry || {}
  return asText(pickFirst(entry, ['id', 'cardId', 'card_id', 'key', 'code', 'itemId'])) || (isAssetId(item.key) ? item.key : '')
}

function catalogName(item) {
  const entry = item.entry || {}
  return asText(pickFirst(entry, ['name', 'title', 'label', 'display'])) || catalogId(item) || '奖励'
}

function catalogCost(item) {
  const entry = item.entry || {}
  const cost = pickFirst(entry, ['cost', 'price', 'need', 'require', 'exchange', 'redeem'])
  if (typeof cost === 'number') return cost
  if (cost && typeof cost === 'object') {
    const value = pickFirst(cost, ['stardust', 'coin', 'coins', 'price', 'cost', 'amount', 'value'])
    if (typeof value === 'number') return value
  }
  return undefined
}

HANDLERS.redeem = async (ctx) => {
  const wanted = ctx.args[0]
  if (!wanted) {
    const catalog = await buildCatalog(ctx)
    const spec = {
      title: '奖励兑换',
      lead: catalog.length
        ? `当前可用 ${catalog.length} 项奖励，点按钮或发送 ${config.prefix}兑换 <编号>。`
        : `没有读到兑换表（rewards.js 未导出 rewardsConfig/cards）。可直接发送 ${config.prefix}兑换 <编号> 尝试。`,
      tiles: catalog.slice(0, 8).map((item) => tileFrom({ entry: item.entry, key: item.key, index: item.index }, { kind: 'cards' })),
      mode: 'grid',
      footer: footerOf(ctx),
    }
    const rows = []
    for (let index = 0; index < catalog.length && rows.length < 2; index += 3) {
      const slice = catalog.slice(index, index + 3)
      if (!slice.length) break
      rows.push(slice.map((item) => {
        const cost = catalogCost(item)
        const label = `${catalogName(item)}${typeof cost === 'number' ? `(${cost})` : ''}`
        return [label.slice(0, 12), `${config.prefix}兑换 ${catalogId(item) || catalogName(item)}`]
      }))
    }
    rows.push(backRows()[0])
    return ctx.plan.panel(spec, rows, { kind: 'redeem' })
  }
  const out = await ctx.call('rewards', 'redeem', [ctx.profile, wanted])
  if (out.error) return ctx.plan.panel(errorSpec('奖励兑换', out.error), backRows(), { kind: 'redeem' })
  const spec = specFromResult(out.result, { title: '奖励兑换', mode: 'row', kind: 'cards', footer: footerOf(ctx) })
  return ctx.plan.panel(spec, [
    [['再次兑换', `${config.prefix}兑换`], ['我的图鉴', `${config.prefix}图鉴`]],
    backRows()[0],
  ], { kind: 'redeem' })
}

HANDLERS.equip = async (ctx) => {
  const args = ctx.args.filter(Boolean)
  if (!args.length) {
    return ctx.plan.panel({
      title: '佩戴回响',
      lead: [
        '发送格式：',
        `${config.prefix}佩戴 <类别> <编号>`,
        `${config.prefix}佩戴 <编号>（类别自动推断）`,
        '类别取值：title（头衔）/ frame（边框）；模块若支持别的槽位名也可以直接填。',
      ].join('\n'),
      tiles: [],
      mode: 'row',
      footer: footerOf(ctx),
    }, [[['我的图鉴', `${config.prefix}图鉴`], ['返回菜单', `${config.prefix}`]]], { kind: 'equip' })
  }
  const kind = args.length > 1 ? args[0] : undefined
  const id = args.length > 1 ? args[1] : args[0]
  const out = await ctx.call('rewards', 'equip', [ctx.profile, kind, id])
  if (out.error) return ctx.plan.panel(errorSpec('佩戴回响', out.error), backRows(), { kind: 'equip' })
  const spec = specFromResult(out.result, { title: '佩戴回响', mode: 'row', kind: 'cards', footer: footerOf(ctx) })
  return ctx.plan.panel(spec, [
    [['我的图鉴', `${config.prefix}图鉴`], ['返回菜单', `${config.prefix}`]],
  ], { kind: 'equip' })
}

HANDLERS.album = async (ctx) => {
  const show = ctx.args[0] === '展示'
  const requestedPage = Number(ctx.args[1])
  const out = await ctx.call('rewards', 'collection', [ctx.profile])
  if (out.error) return ctx.plan.panel(errorSpec('个人收藏馆', out.error), backRows(), { kind: 'album' })
  const result = out.result && typeof out.result === 'object' ? out.result : {}
  const cardList = entriesFrom(result.cards || []).map(item => item.entry).filter(entry => entry && typeof entry === 'object')
  const ownedCards = cardList.filter(entry => entry.owned === true || (Number(entry.count) || 0) > 0)
  const setList = entriesFrom(result.sets || []).map(item => item.entry).filter(entry => entry && typeof entry === 'object')
  const titles = entriesFrom(result.titles || []).map(item => item.entry).filter(entry => entry && typeof entry === 'object')
  const frames = entriesFrom(result.frames || []).map(item => item.entry).filter(entry => entry && typeof entry === 'object')
  const currentTitle = titles.find(entry => entry.id === result.equippedTitle || entry.equipped)?.name || '未佩戴'
  const currentFrame = frames.find(entry => entry.id === result.equippedFrame || entry.equipped)?.name || '默认边框'
  const completed = setList.filter(entry => entry.complete || (Number(entry.total) > 0 && Number(entry.owned) >= Number(entry.total))).length
  const pageCount = Math.max(1, Math.ceil(cardList.length / 12))
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(pageCount, requestedPage) : 1
  const setTiles = setList.map(entry => ({ id: entry.id, kind: 'cards', type: '场景', name: entry.name || '未解锁套系', meta: `收集 ${entry.progress || `${entry.owned || 0}/${entry.total || 0}`}`, hidden: !!entry.hidden && !entry.complete }))
  const galleryTiles = cardList.slice((page - 1) * 12, page * 12).map(entry => entry.tile || { id: entry.id, kind: 'cards', type: entry.type, name: entry.name, hidden: !entry.owned, rarity: entry.rarityStyle || entry.rarity, meta: entry.owned ? `拥有 ${entry.count || 1}` : '未获得' })
  const spec = {
    title: show ? `收藏馆 · 第 ${page}/${pageCount} 页` : '个人收藏馆',
    lead: show ? `已收录 ${ownedCards.length}/${cardList.length} 封回响 · 未获得的卡以剪影展示。` : `已收录 ${ownedCards.length}/${cardList.length} 封回响 · 套系完成 ${completed}/${setList.length}\n称号：${currentTitle} · 边框：${currentFrame}`,
    tiles: show && galleryTiles.length ? galleryTiles : setTiles,
    mode: 'grid', footer: `星屑 ${wallet(ctx.profile)} · 集齐套系解锁称号和边框`,
  }
  // 只展示已拥有且未佩戴的条目，让常用动作保持在两屏以内。
  const rows = []
  if (show && pageCount > 1) rows.push([...(page > 1 ? [['上一页', `${config.prefix}图鉴 展示 ${page - 1}`]] : []), ...(page < pageCount ? [['下一页', `${config.prefix}图鉴 展示 ${page + 1}`]] : [])])
  rows.push(show ? [['套系总览', `${config.prefix}图鉴`], ['兑换奖励', `${config.prefix}兑换`]] : [['展示收藏', `${config.prefix}图鉴 展示`], ['兑换奖励', `${config.prefix}兑换`]])
  const buttons = []
  const pushButtons = (list, prefix, kind2, limit) => {
    for (const item of list) {
      const entry = item.entry || {}
      const id = asText(pickFirst(entry, ['id', 'key', 'code']))
      if (!id || entry.owned !== true || entry.equipped === true) continue
      const name = asText(pickFirst(entry, ['name', 'title', 'label'])) || id
      buttons.push([`${prefix}${name}`.slice(0, 12), `${config.prefix}佩戴 ${kind2} ${id}`])
      if (buttons.length >= limit) break
    }
  }
  pushButtons(entriesFrom(result.titles || []), '戴·', 'title', 2)
  pushButtons(entriesFrom(result.frames || []), '框·', 'frame', 2)
  for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3))
  rows.push([['佩戴说明', `${config.prefix}佩戴`], ['玩法说明', `${config.prefix}玩法 收藏馆`], ['返回菜单', `${config.prefix}`]])
  return ctx.plan.panel(spec, rows, { kind: 'album' })
}

function resolveQuestions(games) {
  const adventures = games.adventures
  const candidates = [
    adventures?.questions,
    adventures?.questionBank,
    adventures?.sampleQuestions,
    adventures?.sampleDossiers,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.list)) return candidate.list
  }
  return undefined
}

function choiceRows(list) {
  const rows = []
  for (let index = 0; index < list.length && rows.length < 3; index += 3) {
    rows.push(list.slice(index, index + 3).map((item) => {
      const entry = item.entry
      const label = typeof entry === 'string'
        ? entry
        : (asText(pickFirst(entry, ['name', 'title', 'label', 'text'])) || `选项 ${item.index + 1}`)
      const value = (entry && typeof entry === 'object' ? asText(pickFirst(entry, ['id', 'key', 'code'])) : '') || String(item.index + 1)
      return [label.slice(0, 12), `${config.prefix}猜 ${value}`]
    }))
  }
  return rows
}

/** 只展示已解锁线索、剪影和候选名；选项对象上的 clues 不能进面板。 */
function dossierLead(result, list) {
  const parts = []
  const yesterday = result.yesterday && typeof result.yesterday === 'object' ? result.yesterday : null
  if (yesterday?.name) parts.push(`昨日答案：${yesterday.name}`)
  const silhouette = asText(result.silhouette)
  parts.push(`剪影：${silhouette || '素材待补'}`)
  const clues = Array.isArray(result.clues) ? result.clues.map((clue) => String(clue)).filter(Boolean) : []
  if (clues.length) parts.push(`线索：${clues.join('；')}`)
  const names = list.map((item) => {
    const entry = item.entry
    return typeof entry === 'string' ? entry : asText(pickFirst(entry, ['name', 'title', 'label']))
  }).filter(Boolean)
  if (names.length) parts.push(`候选：${names.join(' / ')}`)
  const own = asText(pickFirst(result, ['text', 'lead', 'message']))
  if (own && !parts.some((line) => own.includes(line))) parts.push(own)
  return parts.join('\n').slice(0, 600)
}

HANDLERS.dossier = async (ctx) => {
  const questions = resolveQuestions(ctx.games)
  const out = await ctx.call('adventures', 'dossierView', [storeApi.group(ctx.state, ctx.gid), ctx.profile, ctx.day, questions])
  if (out.error) return ctx.plan.panel(errorSpec('回声档案', out.error), backRows(), { kind: 'dossier' })
  const result = out.result && typeof out.result === 'object' ? out.result : {}
  const spec = specFromResult(result, { title: '回声档案', mode: 'row', kind: 'dossiers', maxTiles: 1, footer: footerOf(ctx) })
  const choices = result.choices ?? result.options ?? result.answers ?? result.candidates
  const list = entriesFrom(choices).filter((item) => item.entry !== undefined && item.entry !== null)
  const rows = choiceRows(list)
  const lead = dossierLead(result, list)
  if (lead) spec.lead = lead
  if (result.solved === true) {
    spec.lead = [spec.lead, '今天已经答对，不能再答。'].filter(Boolean).join('\n')
  }
  if (!rows.length || result.solved === true) rows.splice(0, rows.length, [['刷新档案', `${config.prefix}档案`], ['返回菜单', `${config.prefix}`]])
  else rows.push([['再看档案', `${config.prefix}档案`], ['返回菜单', `${config.prefix}`]])
  return ctx.plan.panel(spec, rows, { kind: 'dossier' })
}

HANDLERS.guess = async (ctx) => {
  const choice = ctx.rawArgs || ctx.args.join(' ')
  if (!choice) {
    return ctx.plan.panel(errorSpec('档案作答', `请带上答案，例如 ${config.prefix}猜 d01 或 ${config.prefix}猜 檐下邮差（也可以直接按面板上的选项按钮）`), backRows(), { kind: 'guess' })
  }
  const questions = resolveQuestions(ctx.games)
  const out = await ctx.call('adventures', 'dossierGuess', [storeApi.group(ctx.state, ctx.gid), ctx.profile, ctx.day, choice, questions])
  if (out.error) return ctx.plan.panel(errorSpec('档案作答', out.error), backRows(), { kind: 'guess' })
  const result = out.result && typeof out.result === 'object' ? out.result : {}
  const spec = specFromResult(result, { title: '档案作答', mode: 'row', kind: 'dossiers', footer: footerOf(ctx) })
  const streak = Number(result.streak ?? ctx.profile?.dossier?.streak) || 0
  if (result.correct === true) {
    spec.lead = `答对了！+${Number(result.score) || 0} 分${streak > 1 ? `｜连对 ${streak} 天` : ''}。今日不能再答，答案明日公布。`
  } else if (result.correct === false) {
    const left = result.remaining !== undefined ? `还剩 ${Math.max(0, Number(result.remaining) || 0)} 次。` : ''
    spec.lead = `没有猜中（第 ${Number(result.attempts) || 1} 次）。${left}答案明日公布。`
  }
  const rows = result.correct === true || result.solved === true
    ? [[['回声排行', `${config.prefix}排行`], ['返回菜单', `${config.prefix}`]]]
    : [[['继续作答', `${config.prefix}档案`], ['回声排行', `${config.prefix}排行`]], [['返回菜单', `${config.prefix}`]]]
  return ctx.plan.panel(spec, rows, { kind: 'guess' })
}

HANDLERS.rank = async (ctx) => {
  const profiles = collectProfiles(ctx.state, ctx.gid)
  const out = await ctx.call('adventures', 'dossierRank', [storeApi.group(ctx.state, ctx.gid), profiles, ctx.day])
  if (out.error) return ctx.plan.panel(errorSpec('回响排行', out.error), backRows(), { kind: 'rank' })
  const spec = specFromResult(out.result, { title: '回响排行', mode: 'grid', kind: 'dossiers', maxTiles: 12, footer: footerOf(ctx) })
  if (!spec.lead) spec.lead = `本群已登记 ${profiles.length} 位旅人。`
  return ctx.plan.panel(spec, [
    [['回声档案', `${config.prefix}档案`], ['返回菜单', `${config.prefix}`]],
  ], { kind: 'rank' })
}

/** 地点表：优先用模块的「今日地点」，退回全量 locations */
function locationEntries(games, day) {
  const adventures = games.adventures
  if (day && typeof adventures?.getDailyLocations === 'function') {
    try {
      const daily = adventures.getDailyLocations(day)
      const list = Array.isArray(daily) ? daily.filter((item) => item && typeof item === 'object') : []
      if (list.length) return list
    } catch {
      // 退回全量地点表
    }
  }
  const locations = adventures?.locations
  const list = Array.isArray(locations) ? locations : (locations && typeof locations === 'object' ? entriesFrom(locations).map((item) => item.entry) : [])
  return list.filter((item) => item && typeof item === 'object')
}

function locationIdOf(entry) {
  return asText(pickFirst(entry, ['id', 'key', 'code', 'slug', 'name']))
}

HANDLERS.dispatch = async (ctx) => {
  const wanted = ctx.args[0]
  if (!wanted) {
    const list = locationEntries(ctx.games, ctx.day)
    const spec = {
      title: '云海派遣',
      lead: list.length
        ? `今日可选 ${list.length} 个地点（今州 / 黑海岸 / 瑝珑 / 无音区中的三处）。出发后次日领取相册。点按钮或发送 ${config.prefix}派遣 <地点id>。`
        : `没有读到地点表（adventures.js 未导出 locations），可直接发送 ${config.prefix}派遣 <地点id> 尝试。`,
      tiles: list.slice(0, 8).map((entry, index) => tileFrom({ entry, key: null, index }, { kind: 'locations' })),
      mode: 'grid',
      footer: footerOf(ctx),
    }
    const rows = []
    for (let index = 0; index < list.length && rows.length < 2; index += 3) {
      const slice = list.slice(index, index + 3).filter((entry) => locationIdOf(entry))
      if (!slice.length) break
      rows.push(slice.map((entry) => {
        const name = asText(pickFirst(entry, ['name', 'title', 'label'])) || locationIdOf(entry)
        return [name.slice(0, 12), `${config.prefix}派遣 ${locationIdOf(entry)}`]
      }))
    }
    rows.push(backRows()[0])
    return ctx.plan.panel(spec, rows, { kind: 'dispatch' })
  }
  const out = await ctx.call('adventures', 'dispatchStart', [ctx.profile, ctx.day, wanted, ctx.rng()])
  if (out.error) return ctx.plan.panel(errorSpec('云海派遣', out.error), backRows(), { kind: 'dispatch' })
  const result = out.result && typeof out.result === 'object' ? out.result : {}
  const spec = specFromResult(result, { title: '云海派遣', mode: 'row', kind: 'locations', footer: footerOf(ctx) })
  const place = asText(result.location) || wanted
  const status = asText(result.status) || asText(result.text) || '已出发，次日领取收获'
  if (!spec.lead || spec.lead === status) spec.lead = [`已出发：${place}`, status].filter(Boolean).join('\n')
  else if (!spec.lead.includes(place)) spec.lead = [`已出发：${place}`, spec.lead].join('\n')
  return ctx.plan.panel(spec, [
    [['派遣领取', `${config.prefix}领取`], ['派遣相册', `${config.prefix}相册`]],
    backRows()[0],
  ], { kind: 'dispatch' })
}

HANDLERS.claim = async (ctx) => {
  const out = await ctx.call('adventures', 'dispatchClaim', [ctx.profile, ctx.day, ctx.rng()])
  if (out.error) return ctx.plan.panel(errorSpec('派遣领取', out.error), backRows(), { kind: 'claim' })
  const spec = specFromResult(out.result, { title: '派遣领取', mode: 'row', kind: 'locations', footer: footerOf(ctx) })
  return ctx.plan.panel(spec, [
    [['再派一次', `${config.prefix}派遣`], ['派遣相册', `${config.prefix}相册`]],
    backRows()[0],
  ], { kind: 'claim' })
}

HANDLERS.dispatchAlbum = async (ctx) => {
  const out = await ctx.call('adventures', 'dispatchAlbum', [ctx.profile])
  if (out.error) return ctx.plan.panel(errorSpec('派遣相册', out.error), backRows(), { kind: 'albumDispatch' })
  const spec = specFromResult(out.result, { title: '派遣相册', mode: 'grid', kind: 'locations', maxTiles: 16, footer: footerOf(ctx) })
  return ctx.plan.panel(spec, [
    [['派遣出发', `${config.prefix}派遣`], ['返回菜单', `${config.prefix}`]],
  ], { kind: 'albumDispatch' })
}

function parseStake(args, cfg = config) {
  const raw = args.find((arg) => /^\d+$/.test(arg))
  const stake = raw === undefined ? cfg.defaultStake : Number(raw)
  if (!Number.isInteger(stake) || stake < cfg.minStake || stake > cfg.maxStake) return null
  return stake
}

function newDuelId() {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

function findDuel(state, gid, duelId, phases) {
  const duels = state.duels || {}
  const phaseOk = (duel) => !phases || phases.includes(duel?.echo?.phase)
  if (duelId && duels[duelId]) return phaseOk(duels[duelId]) ? duels[duelId] : null
  const candidates = Object.values(duels)
    .filter((duel) => duel && duel.echo && duel.echo.groupId === gid && phaseOk(duel))
    .sort((a, b) => (Number(b.echo.createdAt) || 0) - (Number(a.echo.createdAt) || 0))
  return candidates[0] || null
}

HANDLERS.duelCreate = async (ctx) => {
  if (ctx.gid === '0') {
    return ctx.plan.panel(errorSpec('回响对战', '对战需要在群里进行。'), backRows(), { kind: 'duel' })
  }
  const stake = parseStake(ctx.args, ctx.config)
  if (stake === null) {
    return ctx.plan.panel(errorSpec('回响对战', `押注需要 ${config.minStake}-${config.maxStake} 之间的整数，例如 ${config.prefix}约战 ${config.defaultStake}`), backRows(), { kind: 'duel' })
  }
  const profile = ctx.profile
  if (!hasWallet(profile)) {
    return ctx.plan.panel(errorSpec('回响对战', '没有识别到星屑字段，无法冻结押注（可在 globalThis.echoPostOfficeConfig.walletKey 指定）。'), backRows(), { kind: 'duel' })
  }
  if (wallet(profile) < stake) {
    return ctx.plan.panel(errorSpec('回响对战', `星屑不足：需要 ${stake}，当前 ${wallet(profile)}。`), backRows(), { kind: 'duel' })
  }
  const mine = Object.values(ctx.state.duels || {}).filter((duel) => duel?.echo?.groupId === ctx.gid
    && duel.echo.phase !== 'settled'
    && (duel.echo.initiator === ctx.uid || duel.echo.opponent === ctx.uid))
  if (mine.length) {
    return ctx.plan.panel(errorSpec('回响对战', '你还有未结束的对战，先等它结算。'), backRows(), { kind: 'duel' })
  }
  const openInGroup = Object.values(ctx.state.duels || {}).filter((duel) => duel?.echo?.groupId === ctx.gid && duel.echo.phase !== 'settled')
  if (openInGroup.length >= config.maxDuelsPerGroup) {
    return ctx.plan.panel(errorSpec('回响对战', `本群同时最多 ${config.maxDuelsPerGroup} 场对战，请稍后再开。`), backRows(), { kind: 'duel' })
  }
  const seed = { id: newDuelId() }
  const out = await ctx.call('adventures', 'duelCreate', [seed, ctx.uid, stake, ctx.now])
  if (out.error) return ctx.plan.panel(errorSpec('回响对战', out.error), backRows(), { kind: 'duel' })
  const duel = out.duel || seed
  if (!duel.id) duel.id = seed.id
  if (!duel.stake) duel.stake = stake
  const echo = duelEcho(duel)
  echo.qq = isQQBot(ctx.e)
  echo.groupId = ctx.gid
  echo.initiator = ctx.uid
  echo.stake = stakeOf(duel) || stake
  echo.phase = 'open'
  echo.createdAt = ctx.nowMs
  const actionAt = Number(duel.lastAction) || ctx.nowMs
  echo.deadline = actionAt + Number(ctx.config.duelTimeoutMs)
  echo.names[ctx.uid] = senderName(ctx.e)
  const frozen = freezeStake(ctx.state, echo, ctx.uid, echo.stake)
  if (frozen !== 'ok') {
    delete ctx.state.duels[duel.id]
    const message = frozen === 'poor'
      ? `星屑不足：需要 ${echo.stake}，当前 ${wallet(profile)}。`
      : '没有识别到星屑字段，无法冻结押注。'
    return ctx.plan.panel(errorSpec('回响对战', message), backRows(), { kind: 'duel' })
  }
  ctx.state.duels[duel.id] = duel
  ctx.plan.duel(duelPanelSpec(duel), [
    [['接受对战', `${config.prefix}接受 ${duel.id}`, '*']],
  ], duel)
  ctx.timers.arm(duel.id, echo.deadline)
  return { items: ctx.plan.items }
}

HANDLERS.duelAccept = async (ctx) => {
  const duelId = ctx.args[0]
  const duel = findDuel(ctx.state, ctx.gid, duelId, ['open'])
  if (!duel) {
    return ctx.plan.panel(errorSpec('接受对战', '没有找到可以接受的对战（可能已被接受或过期）。'), backRows(), { kind: 'duel' })
  }
  const echo = duelEcho(duel)
  if (echo.initiator === ctx.uid) {
    return ctx.plan.panel(errorSpec('接受对战', '不能接受自己发出的对战。'), backRows(), { kind: 'duel' })
  }
  if (Number(echo.deadline) <= ctx.nowMs) {
    const expired = settleDuel(ctx.state, duel, null, { reason: 'timeout', nowMs: ctx.nowMs })
    for (const item of expired) item.forceActive = true
    ctx.plan.items.push(...expired)
    ctx.plan.panel(errorSpec('接受对战', '这一局刚刚超时，押注已原路退还。'), backRows(), { kind: 'duel' })
    return { items: ctx.plan.items }
  }
  const out = await ctx.call('adventures', 'duelAccept', [duel, ctx.uid, ctx.now])
  if (out.error) return ctx.plan.panel(errorSpec('接受对战', out.error), backRows(), { kind: 'duel' })
  const record = out.duel && typeof out.duel === 'object' ? out.duel : duel
  if (!record.id) record.id = duel.id
  if (!record.stake) record.stake = stakeOf(duel)
  const echo2 = inheritEcho(record, duel)
  echo2.groupId = ctx.gid
  echo2.initiator = echo.initiator
  echo2.opponent = ctx.uid
  echo2.stake = stakeOf(record) || stakeOf(duel)
  echo2.phase = 'pull'
  const actionAt = Number(record.lastAction) || ctx.nowMs
  echo2.deadline = actionAt + Number(ctx.config.duelTimeoutMs)
  echo2.names[ctx.uid] = senderName(ctx.e)
  const frozen = freezeStake(ctx.state, echo2, ctx.uid, echo2.stake)
  if (frozen !== 'ok') {
    record.status = 'open'
    record.opponentId = undefined
    record.nextPlayerId = undefined
    echo2.opponent = null
    echo2.phase = 'open'
    echo2.deadline = Number(echo.deadline) || (ctx.nowMs + Number(ctx.config.duelTimeoutMs))
    const message = frozen === 'poor'
      ? `星屑不足：需要 ${echo2.stake}，当前 ${wallet(ctx.profile)}。`
      : '没有识别到星屑字段，无法冻结押注。'
    ctx.state.duels[record.id] = record
    return ctx.plan.panel(errorSpec('接受对战', message), backRows(), { kind: 'duel' })
  }
  ctx.state.duels[record.id] = record
  if (record.id !== duel.id) delete ctx.state.duels[duel.id]
  ctx.plan.duel(duelPanelSpec(record), [
    [['抽卡·发起方', `${config.prefix}对决 ${record.id}`, String(echo2.initiator)]],
    [['抽卡·应战方', `${config.prefix}对决 ${record.id}`, String(echo2.opponent)]],
  ], record)
  ctx.timers.arm(record.id, echo2.deadline)
  return { items: ctx.plan.items }
}

HANDLERS.duelPull = async (ctx) => {
  const duelId = ctx.args[0]
  const duel = findDuel(ctx.state, ctx.gid, duelId, ['pull'])
  if (!duel) {
    return ctx.plan.panel(errorSpec('对战抽卡', '没有进行中的对战（可能已结算）。'), backRows(), { kind: 'duel' })
  }
  const echo = duelEcho(duel)
  const players = [echo.initiator, echo.opponent].filter(Boolean)
  if (!players.includes(ctx.uid)) {
    return ctx.plan.panel(errorSpec('对战抽卡', '这不是你的对战。'), backRows(), { kind: 'duel' })
  }
  const out = await ctx.call('adventures', 'duelPull', [duel, ctx.uid, ctx.rng(), ctx.now])
  if (out.error) return ctx.plan.panel(errorSpec('对战抽卡', out.error), backRows(), { kind: 'duel' })
  const record = out.duel && typeof out.duel === 'object' ? out.duel : duel
  if (!record.id) record.id = duel.id
  const echo2 = inheritEcho(record, duel)
  echo2.groupId = ctx.gid
  echo2.initiator = echo.initiator
  echo2.opponent = echo.opponent
  echo2.stake = stakeOf(duel)
  const result = out.result && typeof out.result === 'object' ? out.result : {}
  const finished = result.done === true || ['finished', 'expired'].includes(record.status)
  echo2.phase = 'pull'
  const actionAt = Number(record.lastAction) || ctx.nowMs
  echo2.deadline = actionAt + Number(ctx.config.duelTimeoutMs)
  const previous = echo2.pulls || {}
  const tally = { count: 0, success: 0, pullCount: 0, ...(previous[ctx.uid] || {}) }
  tally.count = (Number(tally.count) || 0) + 1
  if (result.success === true || result.crooked === true) tally.success = (Number(tally.success) || 0) + 1
  tally.pullCount = (Number(tally.pullCount) || 0) + (Number(result.pullCount) || 1)
  tally.turn = Number(result.turn) || Number(record.turn) || 0
  echo2.pulls = { ...previous, [ctx.uid]: tally }
  ctx.state.duels[record.id] = record
  if (record.id !== duel.id) delete ctx.state.duels[duel.id]
  const winner = resolveWinnerId(record, winnerFrom(record, result, ctx.uid), ctx.uid)
  if (winner !== undefined) {
    const items = settleDuel(ctx.state, record, winner === undefined ? null : winner, { reason: 'pull', nowMs: ctx.nowMs })
    ctx.plan.items.push(...items)
    ctx.timers.clear(record.id)
    if (!items.length) ctx.plan.notice(errorSpec('回响对战', '本局已经结算。'))
    return { items: ctx.plan.items }
  }
  const spec = specFromResult(result, { title: '对战抽卡', mode: 'row', kind: 'cards', footer: footerOf(ctx) })
  const next = result.nextPlayerId || record.nextPlayerId
  spec.lead = [
    asText(pickFirst(result, ['text', 'message'])) || `第 ${Number(result.turn) || 0} 抽没有歪。`,
    next ? `轮到 ${displayOf(echo2, next)}。` : '',
  ].filter(Boolean).join('\n')
  ctx.plan.duel(spec, [
    [['抽卡·发起方', `${config.prefix}对决 ${record.id}`, String(echo2.initiator)]],
    [['抽卡·应战方', `${config.prefix}对决 ${record.id}`, String(echo2.opponent)]],
  ], record)
  ctx.timers.arm(record.id, echo2.deadline)
  return { items: ctx.plan.items }
}

/* ============================================================================
 * 11. TRSS-Yunzai 插件类
 * ==========================================================================*/

export const engine = createEngine()

async function runFromPlugin(instance, options = {}) {
  const e = instance?.e
  if (!e) return false
  if (e.__echoPostOfficeHandled) return false
  const input = extractInput(e)
  if (!input) return false
  if (options.buttonOnly && !extractButtonData(e)) return false
  if (!options.buttonOnly) {
    const first = input.split('|')[0].trim()
    if (!/(回响|echo|今日老婆)/i.test(first)) return false
  }
  try {
    const result = await engine.handle(e, { input })
    if (result?.handled) {
      e.__echoPostOfficeHandled = true
      return true
    }
    return false
  } catch (error) {
    loggerShim.error(`[回响邮局] 处理失败：${error?.stack || error}`)
    try {
      const spec = errorSpec('处理失败', '回响邮局处理失败，已记录日志。')
      const message = await renderItem(engine.deps, { spec }, [], e)
      await e.reply?.(message)
    } catch (inner) {
      loggerShim.warn(`[回响邮局] 兜底回复失败：${inner?.message || inner}`)
    }
    return true
  }
}

/** 主入口：`#回响` 及所有子命令（含 type2 指令按钮回显的文本） */
export class EchoPostOffice extends plugin {
  constructor() {
    super({
      name: '回响邮局',
      dsc: '七合一每日回响小游戏：十连 / 刮刮乐 / 福袋 / 图鉴 / 档案 / 派遣 / 群内对战',
      event: 'message',
      priority: 1,
      rule: [
        { reg: '^#?今日老婆(?:\\s|$|\\|)', fnc: 'route' },
        { reg: '^\\s*[#/]?\\s*回响', fnc: 'route' },
        { reg: '^\\s*echo[\\s_-]*(post)?[\\s_-]*(office)?', fnc: 'route' },
      ],
    })
  }

  async route() {
    return runFromPlugin(this)
  }
}

/**
 * 回调兜底：某些适配器把键盘回调放在 e.button.data / e.data.button.data，
 * 此时 e.msg 为空、匹配不到前缀。本类只在这些字段真的存在时才接管。
 */
export class EchoPostOfficeCallback extends plugin {
  constructor() {
    super({
      name: '回响邮局·回调',
      dsc: '消费 QQ 键盘按钮回调（e.button.data / e.data.button.data 等）',
      event: 'message',
      priority: 5,
      rule: [],
    })
  }

  async accept(e = this.e) {
    const payload = extractButtonData(e)
    if (!payload || !parseCommand(payload)) return false
    const handled = await runFromPlugin({ e }, { buttonOnly: true })
    return handled ? 'return' : false
  }

  async route() {
    return runFromPlugin(this, { buttonOnly: true })
  }
}

/* ============================================================================
 * 12. 启动恢复
 * ==========================================================================*/

export const ready = (async () => {
  if (!globalThis.Bot) return { started: false, reason: 'no-bot-runtime' }
  try {
    const result = await engine.recover()
    return { started: true, ...result }
  } catch (error) {
    loggerShim.warn(`[回响邮局] 启动恢复失败：${error?.stack || error}`)
    return { started: false, error: String(error?.message || error) }
  }
})()

if (globalThis.Bot?.once) {
  try {
    globalThis.Bot.once('online', () => {
      void engine.recover().catch((error) => loggerShim.warn(`[回响邮局] 上线恢复失败：${error?.message || error}`))
    })
  } catch (error) {
    loggerShim.warn(`[回响邮局] 注册上线恢复失败：${error?.message || error}`)
  }
}
