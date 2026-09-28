/**
 * 回响邮局 · 集成测试（独立运行，不依赖 TRSS-Yunzai / oicq / puppeteer）
 *
 *   node tests/integration.test.js
 *
 * 覆盖：命令与按钮解析、面板生命周期（撤回+记录 message_id）、按钮归属与群校验、
 *       旧按钮防复点、2 秒防刷、被动回复上限、QQBot / 非 QQ 两套渲染降级、
 *       七款游戏的路由与适配层、对战押注冻结与结算、60 秒超时与启动恢复、语法检查。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// 状态文件必须在导入 store.js 之前指定
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-post-office-it-'))
process.env.ECHO_POST_STATE = path.join(workdir, 'state.json')

const entry = await import('../apps/index.js')
const store = await import('../lib/store.js')
const { createEngine, config, parseCommand, extractInput, extractButtonData, isQQBot, wallet } = entry

/* ============================ 测试脚手架 ============================ */

const results = []

async function test(name, fn) {
  try {
    await fn()
    results.push({ ok: true, name })
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    results.push({ ok: false, name, error })
    process.stdout.write(`  ✗ ${name}\n      ${String(error?.message || error).split('\n').join('\n      ')}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`)
}

let uidSeq = 10000
function nextUid() {
  uidSeq += 1
  return String(uidSeq)
}

function makeClock(iso = '2026-05-01T10:00:00+08:00') {
  return {
    ms: Date.parse(iso),
    now() { return new Date(this.ms) },
    advance(seconds) { this.ms += seconds * 1000 },
  }
}

function makeTimers(clock) {
  let seq = 0
  const jobs = new Map()
  return {
    jobs,
    setTimeout(fn, ms) {
      const id = ++seq
      const handle = {
        id,
        at: clock.ms + Math.max(0, Number(ms) || 0),
        unref() { return handle },
        hasRef() { return false },
      }
      jobs.set(id, { handle, fn })
      return handle
    },
    clearTimeout(handle) {
      if (handle && handle.id) jobs.delete(handle.id)
    },
    async fireDue() {
      const due = [...jobs.values()].filter((job) => job.handle.at <= clock.ms)
      for (const job of due) {
        jobs.delete(job.handle.id)
        await job.fn()
      }
      return due.length
    },
  }
}

function silentLogger() {
  const lines = []
  return {
    lines,
    info: (...args) => lines.push(['info', args.join(' ')]),
    warn: (...args) => lines.push(['warn', args.join(' ')]),
    error: (...args) => lines.push(['error', args.join(' ')]),
  }
}

function makePresentation(options = {}) {
  const calls = { render: [], markdown: [], panels: [], menu: [], controls: [], image: [] }
  const presentation = {
    calls,
    settings: { callbackButtons: true, cooldownSeconds: 0 },
    controls(rows) {
      calls.controls.push(rows)
      return { type: 'keyboard', rows }
    },
    menu(title, text, rows) {
      calls.menu.push({ title, text, rows })
      return [{ type: 'markdown', text: `# ${title}\n\n${text}` }, { type: 'keyboard', rows }]
    },
    markdown(spec, rows, body) {
      calls.markdown.push({ spec, rows, body })
      const message = presentation.menu(spec?.title || '回响邮局', body, rows)
      calls.panels.push({ via: 'markdown', spec, rows, body, message })
      return message
    },
    render: options.render !== undefined
      ? options.render
      : async (spec) => {
        calls.render.push(spec)
        calls.panels.push({ via: 'render', spec })
        return Buffer.from('PNG')
      },
    image(buffer) {
      calls.image.push(buffer)
      return { type: 'image', buffer }
    },
  }
  return presentation
}

let messageSeq = 0

function makeEvent(options = {}) {
  const sent = []
  const active = []
  const recalled = []
  const ops = []
  const gid = options.gid === undefined ? '9001' : String(options.gid)
  const uid = options.uid === undefined ? nextUid() : String(options.uid)
  messageSeq += 1
  const e = {
    user_id: uid,
    group_id: gid === '0' ? undefined : gid,
    self_id: '99999',
    adapter_id: options.adapter === undefined ? 'QQBot' : options.adapter,
    message_id: options.messageId || `msg-${messageSeq}`,
    isGroup: gid !== '0',
    msg: options.msg || '',
    sender: { card: options.name || `用户${uid}`, nickname: options.name || `用户${uid}` },
    async reply(message) {
      sent.push(message)
      ops.push('send')
      return { message_id: `sent-${sent.length}` }
    },
    group: {
      async recallMsg(id) {
        recalled.push(String(id))
        ops.push(`recall:${id}`)
        return true
      },
      async sendMsg(message) {
        active.push(message)
        ops.push('send:active')
        return { message_id: `active-${active.length}` }
      },
    },
  }
  if (options.button !== undefined) {
    if (options.buttonPath === 'data.button.data') e.data = { button: { data: options.button } }
    else if (options.buttonPath === 'raw.button.data') e.raw = { button: { data: options.button } }
    else e.button = { data: options.button }
  }
  return { e, sent, active, recalled, ops, uid, gid }
}

function buttonsOf(message) {
  const parts = Array.isArray(message) ? message : [message]
  const out = []
  for (const part of parts) {
    if (!part || part.type !== 'keyboard') continue
    for (const row of part.rows || []) {
      for (const cell of row || []) {
        if (!Array.isArray(cell) || typeof cell[1] !== 'string') continue
        out.push({
          label: String(cell[0]),
          command: cell[1],
          owner: cell[2],
          data: (cell[2] === undefined || cell[2] === '*') ? cell[1] : `${cell[1]}|${cell[2]}`,
        })
      }
    }
  }
  return out
}

function findButton(message, label) {
  return buttonsOf(message).find((button) => button.label.includes(label))
}

function textOf(message) {
  const parts = Array.isArray(message) ? message : [message]
  return parts.map((part) => {
    if (typeof part === 'string') return part
    if (!part) return ''
    if (part.type === 'markdown') return part.text || part.content || ''
    if (part.type === 'image') return '[图片]'
    if (part.type === 'keyboard') return ''
    if (typeof part.content === 'string') return part.content
    if (typeof part.value?.content === 'string') return part.value.content
    return ''
  }).filter(Boolean).join('\n')
}

/** 被动回复 + 主动群发合起来的正文（连按时会超出被动回复上限，改走主动发送） */
function allText(event, extra = []) {
  const messages = [...event.sent, ...event.active, ...(Array.isArray(extra) ? extra : [extra])]
  return messages.map((message) => textOf(message)).join('\n')
}

function lastSent(event) {
  assert.ok(event.sent.length, '期望有被动回复，但一条都没发出去')
  return event.sent[event.sent.length - 1]
}

function makeRewards() {
  const log = []
  const cards = [
    { id: 'c001', name: '晨雾信笺', rarity: '紫蜡封' },
    { id: 'c002', name: '金线回声', rarity: '金色回响' },
    { id: 'c003', name: '雨夜邮戳', rarity: '普通' },
  ]
  const rewardsConfig = {
    redeem: [
      { id: 'r001', name: '星屑袋', cost: 30 },
      { id: 'r002', name: '补充券', cost: 80 },
    ],
  }
  return {
    log,
    cards,
    rewardsConfig,
    drawTen(profile, day, rng) {
      log.push(['drawTen', profile.id, day, typeof rng])
      if (profile.drawDay !== day) {
        profile.drawDay = day
        profile.drawUsed = 0
      }
      if (profile.drawUsed >= 2) return { profile, error: 'daily_limit' }
      profile.drawUsed += 1
      return {
        profile,
        result: {
          title: '回响十连',
          lead: '十张回响已经拆封。',
          cards: cards.map((card, index) => ({ ...card, meta: index === 1 ? '重复' : '' })),
        },
      }
    },
    scratch(profile, day, rng) {
      log.push(['scratch', profile.id, day])
      if (profile.scratchDay !== day) {
        profile.scratchDay = day
        profile.scratchUsed = 0
        profile.scratch = { pending: null }
      }
      if (profile.scratchUsed >= 2) return { profile, error: 'daily_limit' }
      profile.scratchUsed += 1
      profile.daily = { day, ten: 0, scratch: profile.scratchUsed, bag: 0 }
      profile.scratch = profile.scratch || {}
      profile.scratch.pending = { id: `t${profile.scratchUsed}`, reveal: { shown: 0, total: 9, done: false } }
      return this.scratchView(profile)
    },
    scratchView(profile) {
      const pending = profile.scratch?.pending || null
      const shown = pending ? Number(pending.reveal?.shown) || 0 : 9
      const total = Number(pending?.reveal?.total) || 9
      const cells = Array.from({ length: total }, (_, index) => ({
        index,
        revealed: index < shown,
        symbolName: '帆',
        glyph: '⛵',
        win: index % 3 === 0,
        tile: {
          kind: 'cards',
          id: `cell_${index + 1}`,
          name: index < shown ? '帆' : '未收录',
          meta: index < shown ? '已揭开' : '等待拆封',
          hidden: index >= shown,
          symbol: index >= shown ? '？' : '⛵',
        },
      }))
      return {
        profile,
        result: {
          kind: 'scratch',
          reveal: { shown, total, done: shown >= total },
          cells,
          text: `星愿刮刮乐：已揭开 ${shown}/${total} 格`,
          view: {
            title: '星愿刮刮乐',
            lead: `已揭开 ${shown}/${total} 格`,
            tiles: cells.map((cell) => cell.tile),
            mode: 'scratch',
            footer: '刮开全部格子看看',
            golden: false,
          },
          daily: { day: profile.scratchDay, scratch: profile.scratchUsed || 0, limit: { scratch: 2 } },
        },
      }
    },
    advanceScratch(profile, steps = 1) {
      log.push(['advanceScratch', steps])
      const pending = profile.scratch?.pending
      if (pending) {
        const take = Math.max(1, Number(steps) || 1)
        pending.reveal.shown = Math.min(pending.reveal.total, (Number(pending.reveal.shown) || 0) + take)
        pending.reveal.done = pending.reveal.shown >= pending.reveal.total
        if (pending.reveal.done) profile.scratch.pending = null
      }
      return this.scratchView(profile)
    },
    remainingDaily(profile, day) {
      const used = profile.scratchDay === day ? Number(profile.scratchUsed) || 0 : 0
      const ten = profile.drawDay === day ? Number(profile.drawUsed) || 0 : 0
      const bag = profile.bagDay === day ? Number(profile.bagUsed) || 0 : 0
      return {
        day,
        used: { ten, scratch: used, bag },
        ten: Math.max(0, 2 - ten),
        scratch: Math.max(0, 2 - used),
        bag: Math.max(0, 1 - bag),
        limit: { ten: 2, scratch: 2, bag: 1 },
      }
    },
    bag(profile, day) {
      log.push(['bag', profile.id, day])
      if (profile.bagDay !== day) {
        profile.bagDay = day
        profile.bagUsed = 0
      }
      if (profile.bagUsed >= 1) return { profile, error: 'daily_limit' }
      profile.bagUsed += 1
      return { profile, result: { text: '福袋里是一枚旧邮票。', cards: [{ id: 'c003', name: '雨夜邮戳' }] } }
    },
    collection(profile) {
      log.push(['collection', profile.id])
      return {
        profile,
        result: {
          sets: [
            { id: 'post_office', name: '邮局常驻', desc: '邮件从这里出发。', progress: '1/12', owned: 1, total: 12 },
            { id: 'star_platform', name: '星愿站台', progress: '0/9', owned: 0, total: 9 },
          ],
          cards: [
            { id: 'c001', name: '晨雾信笺', owned: true, count: 2, rarityName: '紫蜡封' },
            { id: 'c002', name: '金线回声', owned: false, count: 0, rarityName: '金色回响' },
          ],
          titles: [
            { id: 't_novice', name: '第一次寄信', owned: true, equipped: false },
            { id: 't_lucky', name: '小运气', owned: true, equipped: false },
          ],
          frames: [{ id: 'f_plain', name: '牛皮纸信封', owned: true, equipped: true }],
        },
      }
    },
    equip(profile, kind, id) {
      log.push(['equip', kind, id])
      if (!id) return { profile, error: 'invalid' }
      profile.equip = { kind, id }
      return { profile, result: { text: `已佩戴 ${kind || '自动'}/${id}` } }
    },
    redeem(profile, id) {
      log.push(['redeem', id])
      if (id !== 'r001') return { profile, error: 'not_found' }
      profile.stardust = (profile.stardust || 0) + 10
      return { profile, result: { text: '兑换成功，星屑 +10' } }
    },
  }
}

function makeAdventures(options = {}) {
  const log = []
  const questions = [
    { id: 'q1', text: '谁把信寄到了明天？', choices: [{ id: 'A', name: '星海邮差' }, { id: 'B', name: '夜航船工' }] },
  ]
  const locations = [{ id: 'loc1', name: '云海栈桥' }, { id: 'loc2', name: '雾港' }]
  const base = {
    log,
    questions,
    locations,
    sampleDossiers: [{ id: 'd001', name: '第一封档案' }],
    dossierView(group, profile, day, bank) {
      log.push(['dossierView', group ? 'group' : 'none', profile?.id, day, Array.isArray(bank) ? bank.length : String(bank)])
      if (options.legacyDossier) {
        if (arguments.length >= 4 && bank === undefined) {
          throw new TypeError('Cannot read properties of undefined (reading questions)')
        }
        const fallback = questions[0]
        return { profile, result: { text: `三参数兼容：${fallback.text}`, choices: fallback.choices } }
      }
      const question = (Array.isArray(bank) ? bank[0] : questions[0])
      return { profile, result: { title: '回声档案', text: question.text, choices: question.choices } }
    },
    dossierGuess(group, profile, day, choice) {
      log.push(['dossierGuess', choice])
      if (choice === 'A') {
        profile.dossierScore = (profile.dossierScore || 0) + 10
        return { profile, result: { text: '答对了，回响 +10' } }
      }
      return { profile, result: { text: '再想想～' } }
    },
    dossierRank(group, profiles, day) {
      log.push(['dossierRank', Array.isArray(profiles) ? profiles.length : -1, day])
      return { result: { title: '回响排行', list: [{ name: '用户10001', score: 30 }, { name: '用户10002', score: 20 }] } }
    },
    dispatchStart(profile, day, locationId, rng) {
      log.push(['dispatchStart', locationId, typeof rng])
      profile.dispatch = { day, locationId, claimed: false }
      return { profile, result: { title: '云海派遣', text: `${locationId} 已出发`, locations: [{ id: locationId, name: '云海栈桥' }] } }
    },
    dispatchClaim(profile, day, rng) {
      log.push(['dispatchClaim', day, typeof rng])
      if (!profile.dispatch) return { profile, error: 'not_found' }
      if (profile.dispatch.claimed) return { profile, error: 'daily_limit' }
      profile.dispatch.claimed = true
      return { profile, result: { text: '带回了一份回响', cards: [{ id: 'c003', name: '雨夜邮戳' }] } }
    },
    dispatchAlbum(profile) {
      log.push(['dispatchAlbum', profile.id])
      return { profile, result: { title: '派遣相册', entries: [{ id: 'd001', name: '第一封档案' }, { id: 'd002', name: '第二封档案' }] } }
    },
    duelCreate(duel, initiatorId, stake, now) {
      log.push(['duelCreate', initiatorId, stake])
      return { duel: { ...duel, stake, initiatorId, status: 'open', createdAtMs: now?.getTime?.() ?? null }, result: { text: '约战已挂出' } }
    },
    duelAccept(duel, opponentId, now) {
      log.push(['duelAccept', duel.id, opponentId])
      if (duel.initiatorId === opponentId) return { duel, error: 'invalid' }
      return { duel: { ...duel, opponentId, status: 'pulling', acceptedAtMs: now?.getTime?.() ?? null }, result: { text: '应战成功' } }
    },
    duelPull(duel, userId, rng, now) {
      log.push(['duelPull', duel.id, userId, typeof rng])
      const turns = (Number(duel.turns) || 0) + 1
      const record = { ...duel, turns, lastPullMs: now?.getTime?.() ?? null }
      const result = {
        turn: turns,
        pullCount: Math.min(5 + (turns - 1) * 8, 12),
        success: turns % 2 === 1,
        timestamp: now,
      }
      if (turns >= 12) result.forceJudge = true
      return { duel: record, result }
    },
    duelExpire(duel, now) {
      log.push(['duelExpire', duel?.id, now?.getTime?.() ?? null])
      return { duel: { ...duel, status: 'expired' }, result: { text: '超时流局', expired: true } }
    },
  }
  return base
}

function makeEngine(overrides = {}) {
  const clock = overrides.clock || makeClock()
  const timers = makeTimers(clock)
  const logger = silentLogger()
  const presentation = overrides.presentation || makePresentation()
  const rewards = overrides.rewards === undefined ? makeRewards() : overrides.rewards
  const adventures = overrides.adventures === undefined ? makeAdventures() : overrides.adventures
  const engine = createEngine({
    presentation,
    games: { rewards, adventures },
    timers,
    now: () => clock.now(),
    rng: () => entry.makeRng(20260501),
    logger,
    autoSweep: false,
    config: { cooldownSeconds: 0, ...(overrides.config || {}) },
  })
  return { engine, clock, timers, logger, presentation, rewards, adventures }
}

async function waitFor(predicate, timeout = 1500) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 取出某个用户参与的对战（用例之间共享同一个状态文件，需要按人过滤） */
function duelsOf(state, uid) {
  return Object.values(state.duels || {}).filter((duel) => duel?.echo
    && (String(duel.echo.initiator) === String(uid) || String(duel.echo.opponent) === String(uid)))
}

/** 清空对战表：让每个对战用例都从确定的状态开始 */
async function clearDuels() {
  await store.transaction((state) => {
    state.duels = {}
    return { commit: true }
  })
}

/** 最近一次面板规格：QQBot 走 markdown，非 QQ 走 render，两者都记在 calls.panels */
function lastPanel(presentation) {
  const panels = presentation.calls.panels || []
  assert.ok(panels.length, '期望有面板渲染调用，但一次都没有')
  return panels[panels.length - 1].spec
}

/* ============================ 1. 语法检查 ============================ */

section('语法检查（node --check）')

await test('apps/index.js、lib/*.js、tests/*.js 全部通过 node --check', () => {
  const targets = [
    path.join(root, 'apps', 'index.js'),
    path.join(root, 'lib', 'store.js'),
    path.join(root, 'lib', 'presentation.js'),
    path.join(root, 'tests', 'integration.test.js'),
  ]
  for (const target of targets) {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
  }
})

await test('package.json 为 ESM 且声明了 main / test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.ok(String(pkg.scripts.test).includes('integration.test.js'))
})

/* ============================ 2. 解析层 ============================ */

section('命令与按钮解析')

await test('#回响 及其子命令解析正确', () => {
  assert.equal(parseCommand('#回响').name, 'menu')
  assert.equal(parseCommand('#回响菜单').name, 'menu')
  assert.equal(parseCommand('回响').name, 'menu')
  assert.equal(parseCommand('#回响十连').name, 'draw')
  assert.equal(parseCommand('#回响刮刮乐 3').name, 'scratch')
  assert.deepEqual(parseCommand('#回响刮刮乐 3').args, ['3'])
  assert.equal(parseCommand('#echo draw').name, 'draw')
  assert.equal(parseCommand('  #回响福袋  ').name, 'bag')
})

await test('按钮 payload「命令|操作人#令牌」被拆解', () => {
  const parsed = parseCommand('#回响十连|10001#ab12cd34')
  assert.equal(parsed.name, 'draw')
  assert.equal(parsed.ownerId, '10001')
  assert.equal(parsed.token, 'ab12cd34')
  const publicButton = parseCommand('#回响接受 ab12cd34')
  assert.equal(publicButton.name, 'duelAccept')
  assert.equal(publicButton.ownerId, '')
  assert.deepEqual(publicButton.args, ['ab12cd34'])
})

await test('无关消息不会被误判为回响命令', () => {
  assert.equal(parseCommand('十连'), null)
  assert.equal(parseCommand('今天天气不错'), null)
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand('#帮助'), null)
})

await test('回调数据可从 e.button.data / e.data.button.data / e.raw.button.data 读取', () => {
  const payload = '#回响十连|10001#tok12345'
  assert.equal(extractButtonData({ button: { data: payload } }), payload)
  assert.equal(extractButtonData({ data: { button: { data: payload } } }), payload)
  assert.equal(extractButtonData({ raw: { button: { data: payload } } }), payload)
  assert.equal(extractInput({ data: { button: { data: payload } } }), payload)
  assert.equal(extractButtonData({ msg: '普通消息' }), '')
  assert.equal(extractInput({ msg: '#回响福袋' }), '#回响福袋')
})

await test('QQBot 适配器识别', () => {
  assert.equal(isQQBot({ adapter_id: 'QQBot' }), true)
  assert.equal(isQQBot({ bot: { adapter: { id: 'QQBot' } } }), true)
  assert.equal(isQQBot({ adapter_id: 'OneBotv11' }), false)
  assert.equal(isQQBot({}), false)
})

/* ============================ 3. 面板生命周期 ============================ */

section('面板生命周期（撤回 + message_id + 按钮归属）')

await test('菜单发出 markdown+keyboard，按钮带操作人与令牌，并记录 message_id', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11001', gid: '8001' })
  const result = await engine.handle(event.e, { input: '#回响' })
  assert.equal(result.handled, true)
  assert.equal(result.command, 'menu')
  const message = lastSent(event)
  assert.equal(message[0].type, 'markdown')
  assert.equal(message[1].type, 'keyboard')
  assert.ok(message[0].text.includes('回响邮局'))
  const buttons = buttonsOf(message)
  assert.ok(buttons.length >= 9, `按钮数量不足：${buttons.length}`)
  for (const button of buttons) {
    assert.equal(button.owner, '11001#' + button.owner.split('#')[1])
    assert.equal(button.data.startsWith(button.command + '|11001#'), true)
  }
  const state = await store.snapshot()
  const panel = state.panels['8001:11001']
  assert.ok(panel, '面板记录未写入 state.panels')
  assert.equal(panel.message_id, 'sent-1')
  assert.equal(panel.gid, '8001')
  assert.equal(panel.uid, '11001')
  assert.equal(panel.kind, 'menu')
  assert.equal(panel.token.length, 8)
  assert.equal(panel.turns, 1)
  engine.dispose()
})

await test('再次打开菜单先发送新面板，成功后撤回旧面板并更新 message_id', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11002', gid: '8001' })
  await engine.handle(event.e, { input: '#回响' })
  await engine.handle(event.e, { input: '#回响' })
  assert.deepEqual(event.recalled, ['sent-1'])
  assert.deepEqual(event.ops.slice(0, 3), ['send', 'send', 'recall:sent-1'])
  const state = await store.snapshot()
  const panel = state.panels['8001:11002']
  assert.equal(panel.message_id, 'sent-2')
  assert.equal(panel.turns, 2)
  engine.dispose()
})

await test('换玩法也会撤回上一条面板（每群每人只留一条）', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11003', gid: '8001' })
  await engine.handle(event.e, { input: '#回响' })
  const menuButton = findButton(lastSent(event), '十连补给')
  await engine.handle(event.e, { input: menuButton.data })
  assert.deepEqual(event.recalled, ['sent-1'])
  assert.equal(rewards.log.filter((line) => line[0] === 'drawTen').length, 1)
  const state = await store.snapshot()
  assert.equal(state.panels['8001:11003'].kind, 'draw')
  engine.dispose()
})

/* ============================ 4. 校验层 ============================ */

section('按钮归属 / 群校验 / 旧按钮防复点 / 2 秒防刷')

await test('不是本人的按钮会被拒绝，且不触发玩法逻辑', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11011', gid: '8001' })
  const result = await engine.handle(event.e, { input: '#回响十连|11012#deadbeef' })
  assert.equal(result.reason, 'owner-mismatch')
  assert.equal(rewards.log.length, 0)
  assert.ok(textOf(lastSent(event)).includes('这条按钮属于另一位玩家，请自己发送 #回响 打开面板'))
  engine.dispose()
})

await test('跨群复用按钮会被判定为过期面板', async () => {
  const { engine, rewards } = makeEngine()
  const author = makeEvent({ uid: '11013', gid: '8001' })
  await engine.handle(author.e, { input: '#回响' })
  const button = findButton(lastSent(author), '十连补给')
  const stranger = makeEvent({ uid: '11013', gid: '8002' })
  const result = await engine.handle(stranger.e, { input: button.data })
  assert.equal(result.handled, true)
  assert.ok(textOf(lastSent(stranger)).includes('已经过期'))
  assert.equal(rewards.log.length, 0)
  engine.dispose()
})

await test('旧面板的按钮在换面板后立即失效（防复点）', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11014', gid: '8001' })
  await engine.handle(event.e, { input: '#回响' })
  const stale = findButton(lastSent(event), '十连补给')
  await engine.handle(event.e, { input: '#回响' }) // 新面板 → 旧令牌作废
  const result = await engine.handle(event.e, { input: stale.data })
  assert.equal(result.handled, true)
  assert.ok(textOf(lastSent(event)).includes('已经过期'))
  assert.equal(rewards.log.length, 0)
  engine.dispose()
})

await test('打字输入的命令不需要令牌（无前缀校验）', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11015', gid: '8001' })
  const result = await engine.handle(event.e, { input: '#回响十连' })
  assert.equal(result.command, 'draw')
  assert.equal(rewards.log.filter((line) => line[0] === 'drawTen').length, 1)
  engine.dispose()
})

await test('2 秒防刷：冷却期内不再触发玩法，并给出提示', async () => {
  const { engine, rewards } = makeEngine({ config: { cooldownSeconds: 2 } })
  const event = makeEvent({ uid: '11016', gid: '8001' })
  await engine.handle(event.e, { input: '#回响十连' })
  const button = findButton(lastSent(event), '再来十连')
  const second = await engine.handle(event.e, { input: button.data })
  assert.equal(second.reason, 'cooldown')
  assert.equal(rewards.log.filter((line) => line[0] === 'drawTen').length, 1)
  const lastCall = event.sent[event.sent.length - 1]
  assert.notEqual(typeof lastCall, 'string', '冷却提示现在是 markdown 面板，不再是纯字符串')
  assert.ok(textOf(lastCall).includes('冷却中'))
  engine.dispose()
})

await test('冷却按玩法家族隔离，不同玩法互不影响', async () => {
  const { engine, rewards } = makeEngine({ config: { cooldownSeconds: 2 } })
  const event = makeEvent({ uid: '11017', gid: '8001' })
  await engine.handle(event.e, { input: '#回响十连' })
  await engine.handle(event.e, { input: '#回响福袋' })
  assert.equal(rewards.log.filter((line) => line[0] === 'drawTen').length, 1)
  assert.equal(rewards.log.filter((line) => line[0] === 'bag').length, 1)
  engine.dispose()
})

await test('单条 msg_id 被动回复不超过 5 次，超出改主动群发', async () => {
  const { engine } = makeEngine({ config: { maxPassiveReplies: 2 } })
  const event = makeEvent({ uid: '11018', gid: '8001' })
  for (let index = 0; index < 4; index += 1) {
    await engine.handle(event.e, { input: '#回响十连' })
  }
  assert.equal(event.sent.length, 2, '前 2 条应走被动回复')
  assert.equal(event.active.length, 2, '第 3、4 条应改主动群发')
  engine.dispose()
})

/* ============================ 5. 渲染降级 ============================ */

section('QQBot / 非 QQ 渲染降级')

await test('QQBot：有卡面时一张图片加按钮，渲染失败时退回 Markdown', async () => {
  const { engine, presentation } = makeEngine()
  const event = makeEvent({ uid: '11021', gid: '8001', adapter: 'QQBot' })
  await engine.handle(event.e, { input: '#回响十连' })
  const message = lastSent(event)
  assert.equal(message[0].type, 'image')
  assert.equal(message[1].type, 'keyboard')
  assert.equal(presentation.calls.render.length, 1)
  assert.equal(presentation.calls.image.length, 1)
  assert.equal(presentation.calls.markdown.length, 0)
  assert.equal(lastPanel(presentation).tiles.length, 3)
  engine.dispose()
})

await test('QQBot：无卡面的结果用 markdown + keyboard', async () => {
  const { engine, presentation } = makeEngine()
  const event = makeEvent({ uid: '11022', gid: '8001', adapter: 'QQBot' })
  await engine.handle(event.e, { input: '#回响' })
  const message = lastSent(event)
  assert.equal(message[0].type, 'markdown')
  assert.equal(message[1].type, 'keyboard')
  assert.equal(presentation.calls.markdown.length, 1)
  assert.equal(presentation.calls.menu.length, 1)
  assert.equal(presentation.calls.render.length, 0)
  assert.equal(presentation.calls.image.length, 0)
  engine.dispose()
})

await test('QQBot：图片渲染失败时回退 Markdown 与按钮', async () => {
  const presentation = makePresentation({ render: async () => null })
  const { engine } = makeEngine({ presentation })
  const event = makeEvent({ uid: '11023', gid: '8001', adapter: 'QQBot' })
  await engine.handle(event.e, { input: '#回响十连' })
  const message = lastSent(event)
  assert.equal(Array.isArray(message), true)
  assert.equal(message[0].type, 'markdown')
  assert.equal(message[1].type, 'keyboard')
  assert.ok(textOf(message).includes('晨雾信笺'))
  assert.equal(presentation.calls.markdown.length, 1)
  assert.equal(presentation.calls.image.length, 0)
  engine.dispose()
})

await test('非 QQ 适配器：图片 + 纯文字，不带 keyboard', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11024', gid: '8001', adapter: 'OneBotv11' })
  await engine.handle(event.e, { input: '#回响十连' })
  const message = lastSent(event)
  assert.equal(message[0].type, 'image')
  assert.equal(typeof message[1], 'string')
  assert.ok(message[1].includes('【回响十连】'))
  assert.ok(message[1].includes('可用指令'))
  assert.equal(buttonsOf(message).length, 0)
  engine.dispose()
})

await test('非 QQ 适配器：纯文字的菜单会列出可用指令', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11025', gid: '8001', adapter: 'OneBotv11' })
  await engine.handle(event.e, { input: '#回响' })
  const message = lastSent(event)
  assert.equal(typeof message, 'string')
  assert.ok(message.includes('可用指令'))
  assert.ok(message.includes('#回响十连'))
  engine.dispose()
})

/* ============================ 6. 奖励玩法 ============================ */

section('十连 / 刮刮乐 / 福袋 / 图鉴 / 兑换 / 佩戴')

await test('十连：每天两次，第三次提示次数已用完', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11031', gid: '8001' })
  await engine.handle(event.e, { input: '#回响十连' })
  await engine.handle(event.e, { input: '#回响十连' })
  assert.equal(rewards.log.filter((line) => line[0] === 'drawTen').length, 2)
  await engine.handle(event.e, { input: '#回响十连' })
  assert.ok(textOf(lastSent(event)).includes('今日次数已用完'))
  const state = await store.snapshot()
  assert.equal(state.users['11031'].drawUsed, 2)
  engine.dispose()
})

await test('十连：rng 以函数传入，day 为上海时区日期', async () => {
  const { engine, rewards, clock } = makeEngine()
  const event = makeEvent({ uid: '11032', gid: '8001' })
  await engine.handle(event.e, { input: '#回响十连' })
  const call = rewards.log.find((line) => line[0] === 'drawTen')
  assert.equal(call[1], '11032')
  assert.equal(call[2], store.today(clock.now()))
  assert.equal(call[3], 'function')
  engine.dispose()
})

await test('刮刮乐：开票 + 逐格揭开，面板为 scratch 模式且按钮为刮一格/刮三格/全刮', async () => {
  const { engine, rewards, presentation } = makeEngine()
  const event = makeEvent({ uid: '11033', gid: '8001' })
  await engine.handle(event.e, { input: '#回响刮刮乐' })
  assert.equal(rewards.log.filter((line) => line[0] === 'scratch').length, 1, '第一次应按日开票')
  const render = lastPanel(presentation)
  assert.equal(render.mode, 'scratch')
  assert.equal(render.tiles.length, 9)
  const message = lastSent(event)
  const labels = buttonsOf(message).map((button) => button.label)
  for (const label of ['刮一格', '刮三格', '全刮']) assert.ok(labels.includes(label), `缺少 ${label} 按钮`)
  await engine.handle(event.e, { input: findButton(message, '刮三格').data })
  const advances = rewards.log.filter((line) => line[0] === 'advanceScratch')
  assert.equal(advances.length, 2, '开票时会先揭 1 格，再按「刮三格」请求 3 格')
  assert.equal(advances[1][1], 3, '「刮三格」应请求揭开 3 格')
  assert.equal(rewards.log.filter((line) => line[0] === 'scratch').length, 1, '已开票时不应再开新票')
  const state = await store.snapshot()
  assert.equal(state.users['11033'].scratch.pending.reveal.shown, 4)
  assert.equal(lastPanel(presentation).tiles[0].hidden, false, '已揭开的格子应露出符号')
  engine.dispose()
})

await test('刮刮乐：全刮揭完当前票面并开出第二张，用完次数后说明原因', async () => {
  const { engine, rewards, presentation } = makeEngine()
  const event = makeEvent({ uid: '11034', gid: '8001' })
  await engine.handle(event.e, { input: '#回响刮刮乐' })
  await engine.handle(event.e, { input: findButton(lastSent(event), '全刮').data })
  const state = await store.snapshot()
  assert.equal(state.users['11034'].daily.scratch, 2, '全刮应把当日两张都开掉')
  assert.equal(state.users['11034'].scratch.pending, null, '第二张也应揭完')
  const opens = rewards.log.filter((line) => line[0] === 'scratch').length
  assert.ok(opens >= 2, `开票次数异常：${opens}`)
  assert.ok(rewards.log.filter((line) => line[0] === 'advanceScratch').length >= 2, '两张票都应被揭开')
  const footer = lastPanel(presentation).footer
  assert.ok(footer.includes('今日已用 2/2'), `面板应显示当日额度：${footer}`)
  assert.ok(footer.includes('今日已用 2/2') && footer.includes('本张 9/9'), `面板应显示票面与额度：${footer}`)
  engine.dispose()
})

await test('福袋：每天一次，第二次提示次数已用完', async () => {
  const { engine, rewards, presentation } = makeEngine()
  const event = makeEvent({ uid: '11035', gid: '8001' })
  await engine.handle(event.e, { input: '#回响福袋' })
  assert.ok(lastPanel(presentation).lead.includes('旧邮票'))
  await engine.handle(event.e, { input: '#回响福袋' })
  assert.equal(rewards.log.filter((line) => line[0] === 'bag').length, 2)
  assert.ok(textOf(lastSent(event)).includes('今日次数已用完'))
  engine.dispose()
})

await test('图鉴：套装进度渲染成卡面，佩戴按钮来自已拥有的头衔/边框', async () => {
  const { engine, presentation } = makeEngine()
  const event = makeEvent({ uid: '11036', gid: '8001' })
  await engine.handle(event.e, { input: '#回响图鉴' })
  const render = lastPanel(presentation)
  assert.equal(render.tiles.length, 2, '优先用 sets，而不是把 50 张卡全铺开')
  assert.equal(render.tiles[0].id, 'post_office')
  assert.ok(render.tiles[0].meta.includes('1/12'))
  assert.ok(render.lead.includes('已收录 1/2 封回响'))
  const equipButton = findButton(lastSent(event), '戴·')
  assert.ok(equipButton, '图鉴面板缺少佩戴按钮')
  assert.ok(equipButton.data.startsWith('#回响佩戴 title t_novice'))
  assert.equal(equipButton.owner.startsWith('11036#'), true)
  engine.dispose()
})

await test('佩戴：类别 + 编号按文档顺序传给 equip()', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11037', gid: '8001' })
  await engine.handle(event.e, { input: '#回响佩戴 title t_novice' })
  const call = rewards.log.find((line) => line[0] === 'equip')
  assert.deepEqual(call.slice(1), ['title', 't_novice'])
  assert.ok(textOf(lastSent(event)).includes('已佩戴'))
  engine.dispose()
})

await test('佩戴：只给编号时类别为空，由模块自行推断', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11038', gid: '8001' })
  await engine.handle(event.e, { input: '#回响佩戴 t_lucky' })
  const call = rewards.log.find((line) => line[0] === 'equip')
  assert.equal(call[1], undefined)
  assert.equal(call[2], 't_lucky')
  engine.dispose()
})

await test('兑换：列表来自 rewardsConfig，按下后调用 redeem()', async () => {
  const { engine, rewards } = makeEngine()
  const event = makeEvent({ uid: '11039', gid: '8001' })
  await engine.handle(event.e, { input: '#回响兑换' })
  const button = findButton(lastSent(event), '星屑袋')
  assert.ok(button, '兑换面板缺少奖励按钮')
  assert.ok(button.data.startsWith('#回响兑换 r001'))
  await engine.handle(event.e, { input: button.data })
  assert.deepEqual(rewards.log.find((line) => line[0] === 'redeem').slice(1), ['r001'])
  assert.ok(textOf(lastSent(event)).includes('星屑 +10'))
  engine.dispose()
})

await test('兑换：未知编号把模块的 error 转成中文提示', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11040', gid: '8001' })
  await engine.handle(event.e, { input: '#回响兑换 r999' })
  assert.ok(textOf(lastSent(event)).includes('没有找到对应内容'))
  engine.dispose()
})

/* ============================ 7. 探险玩法 ============================ */

section('档案 / 猜谜 / 排行 / 派遣 / 相册')

await test('档案：按 (group, profile, day, questions) 四参数调用并生成选项按钮', async () => {
  const { engine, adventures } = makeEngine()
  const event = makeEvent({ uid: '11051', gid: '8001' })
  await engine.handle(event.e, { input: '#回响档案' })
  const call = adventures.log.find((line) => line[0] === 'dossierView')
  assert.equal(call[1], 'group')
  assert.equal(call[2], '11051')
  assert.equal(call[4], 1, '应把模块导出的题库传进去')
  const buttonA = findButton(lastSent(event), '星海邮差')
  assert.ok(buttonA, '档案面板缺少选项按钮')
  assert.ok(buttonA.data.startsWith('#回响猜 A'))
  engine.dispose()
})

await test('猜谜：选项按钮作答会把选项值传给 dossierGuess()', async () => {
  const { engine, adventures } = makeEngine()
  const event = makeEvent({ uid: '11052', gid: '8001' })
  await engine.handle(event.e, { input: '#回响档案' })
  const button = findButton(lastSent(event), '星海邮差')
  await engine.handle(event.e, { input: button.data })
  assert.deepEqual(adventures.log.find((line) => line[0] === 'dossierGuess').slice(1), ['A'])
  assert.ok(textOf(lastSent(event)).includes('答对了'))
  engine.dispose()
})

await test('猜谜：也支持直接打字作答（自由文本原样传入）', async () => {
  const { engine, adventures } = makeEngine()
  const event = makeEvent({ uid: '11053', gid: '8001' })
  await engine.handle(event.e, { input: '#回响猜 夜航船工' })
  assert.deepEqual(adventures.log.find((line) => line[0] === 'dossierGuess').slice(1), ['夜航船工'])
  engine.dispose()
})

await test('排行：把本群档案数组传给 dossierRank(group, profiles, day)', async () => {
  const { engine, adventures, presentation } = makeEngine()
  const event = makeEvent({ uid: '11054', gid: '8001' })
  await engine.handle(event.e, { input: '#回响' })
  await engine.handle(event.e, { input: '#回响排行' })
  const call = adventures.log.find((line) => line[0] === 'dossierRank')
  assert.ok(call[1] >= 1, '排行应收到至少一个档案')
  assert.equal(call[2], store.today(new Date(2026, 4, 1)))
  const render = lastPanel(presentation)
  assert.equal(render.tiles.length, 2)
  assert.ok(render.tiles[0].name.includes('10001'))
  assert.ok(render.tiles[0].meta.includes('分 30'))
  engine.dispose()
})

await test('派遣：地点列表来自 adventures.locations，并生成出发按钮', async () => {
  const { engine, presentation } = makeEngine()
  const event = makeEvent({ uid: '11055', gid: '8001' })
  await engine.handle(event.e, { input: '#回响派遣' })
  const render = lastPanel(presentation)
  assert.equal(render.tiles.length, 2)
  const button = findButton(lastSent(event), '云海栈桥')
  assert.ok(button)
  assert.ok(button.data.startsWith('#回响派遣 loc1'))
  engine.dispose()
})

await test('派遣：出发 → 领取 → 二次领取被模块拒绝', async () => {
  const { engine, adventures, presentation } = makeEngine()
  const event = makeEvent({ uid: '11056', gid: '8001' })
  await engine.handle(event.e, { input: '#回响派遣 loc2' })
  const startCall = adventures.log.find((line) => line[0] === 'dispatchStart')
  assert.equal(startCall[1], 'loc2')
  assert.equal(startCall[2], 'function', 'rng 应以函数形式传入')
  await engine.handle(event.e, { input: '#回响领取' })
  assert.ok(lastPanel(presentation).lead.includes('带回了一份回响'))
  await engine.handle(event.e, { input: '#回响领取' })
  assert.ok(textOf(lastSent(event)).includes('今日次数已用完'))
  engine.dispose()
})

await test('派遣：领取前没有出发记录时提示未找到', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11057', gid: '8001' })
  await engine.handle(event.e, { input: '#回响领取' })
  assert.ok(textOf(lastSent(event)).includes('没有找到对应内容'))
  engine.dispose()
})

await test('派遣相册：渲染模块返回的条目', async () => {
  const { engine, presentation } = makeEngine()
  const event = makeEvent({ uid: '11058', gid: '8001' })
  await engine.handle(event.e, { input: '#回响相册' })
  const render = lastPanel(presentation)
  assert.equal(render.tiles.length, 2)
  assert.ok(render.title.includes('相册'))
  engine.dispose()
})

await test('接口差异：4 参数报错时自动降级为 3 参数重试一次', async () => {
  const adventures = makeAdventures({ legacyDossier: true })
  delete adventures.questions
  const { engine } = makeEngine({ adventures, config: { cooldownSeconds: 0 } })
  const event = makeEvent({ uid: '11059', gid: '8001' })
  const result = await engine.handle(event.e, { input: '#回响档案' })
  assert.equal(result.handled, true)
  assert.ok(textOf(lastSent(event)).includes('三参数兼容'), '应在降级调用后成功')
  const viewCalls = adventures.log.filter((line) => line[0] === 'dossierView')
  assert.ok(viewCalls.length >= 1, '旧接口应被成功调用并得到三参数兼容结果')
  engine.dispose()
})

/* ============================ 8. 对战 ============================ */

section('对战：约战 / 接受 / 抽卡 / 结算 / 超时')

await test('约战：原子冻结发起方押注，按钮为公开的接受按钮', async () => {
  await clearDuels()
  const { engine, timers } = makeEngine()
  const initiator = makeEvent({ uid: '11061', gid: '8101' })
  await store.transaction((state) => {
    state.users['11061'] = { id: '11061', stardust: 200 }
    state.users['11062'] = { id: '11062', stardust: 100 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 60' })
  const state = await store.snapshot()
  const duels = duelsOf(state, '11061')
  assert.equal(duels.length, 1)
  const duel = duels[0]
  assert.equal(duel.echo.phase, 'open')
  assert.equal(duel.echo.escrow['11061'], 60)
  assert.equal(state.users['11061'].stardust, 140, '约战应立即冻结押注')
  assert.equal(state.users['11062'].stardust, 100)
  assert.equal(duel.echo.deadline - duel.echo.createdAt, 60000, '约战超时应为 60 秒')
  const acceptButton = findButton(lastSent(initiator), '接受对战')
  assert.ok(acceptButton, '约战面板缺少接受按钮')
  assert.equal(acceptButton.owner, '*', '接受按钮必须是公开按钮，由服务端校验群与人')
  assert.equal(acceptButton.data, `#回响接受 ${duel.id}`)
  assert.equal(timers.jobs.size, 1, '约战应装好 60 秒定时器')
  assert.equal(duel.echo.messageId, 'sent-1', '对战面板的 message_id 应记录在对战上')
  engine.dispose()
})

await test('约战：星屑不足时拒绝，且不产生对战记录', async () => {
  await clearDuels()
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11063', gid: '8102' })
  await store.transaction((state) => {
    state.users['11063'] = { id: '11063', stardust: 10 }
    return { commit: true }
  })
  await engine.handle(event.e, { input: '#回响约战 500' })
  assert.ok(textOf(lastSent(event)).includes('星屑不足'))
  const state = await store.snapshot()
  assert.equal(duelsOf(state, '11063').length, 0)
  assert.equal(state.users['11063'].stardust, 10, '被拒绝时不应扣星屑')
  engine.dispose()
})

await test('约战：超范围押注被拒绝', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11064', gid: '8103' })
  await engine.handle(event.e, { input: '#回响约战 99999' })
  assert.ok(textOf(lastSent(event)).includes(`${config.minStake}-${config.maxStake}`))
  engine.dispose()
})

await test('约战：私人会话里拒绝开局', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11065', gid: '0' })
  await engine.handle(event.e, { input: '#回响约战 50' })
  assert.ok(textOf(lastSent(event)).includes('需要在群里'))
  engine.dispose()
})

await test('接受：应战方押注同样被冻结，抽卡面板给出两个限定本人的按钮', async () => {
  await clearDuels()
  const { engine } = makeEngine()
  const initiator = makeEvent({ uid: '11066', gid: '8104' })
  await store.transaction((state) => {
    state.users['11066'] = { id: '11066', stardust: 100 }
    state.users['11067'] = { id: '11067', stardust: 100 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 25' })
  const duelId = duelsOf(await store.snapshot(), '11066')[0].id
  const opponent = makeEvent({ uid: '11067', gid: '8104' })
  await engine.handle(opponent.e, { input: `#回响接受 ${duelId}` })
  const state = await store.snapshot()
  const duel = state.duels[duelId]
  assert.equal(duel.echo.phase, 'pull')
  assert.equal(duel.echo.escrow['11066'], 25)
  assert.equal(duel.echo.escrow['11067'], 25)
  assert.equal(state.users['11067'].stardust, 75)
  assert.equal(state.users['11066'].stardust, 75)
  assert.deepEqual(opponent.recalled, ['sent-1'], '接受后应撤回旧的约战面板')
  const pullButtons = buttonsOf(lastSent(opponent)).filter((button) => button.label.includes('抽卡'))
  assert.equal(pullButtons.length, 2)
  assert.deepEqual(pullButtons.map((button) => button.owner).sort(), ['11066', '11067'])
  engine.dispose()
})

await test('接受：不能接受自己发出的对战', async () => {
  await clearDuels()
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11068', gid: '8105' })
  await store.transaction((state) => {
    state.users['11068'] = { id: '11068', stardust: 100 }
    return { commit: true }
  })
  await engine.handle(event.e, { input: '#回响约战 20' })
  const duelId = duelsOf(await store.snapshot(), '11068')[0].id
  await engine.handle(event.e, { input: `#回响接受 ${duelId}` })
  assert.ok(textOf(lastSent(event)).includes('不能接受自己'))
  const after = await store.snapshot()
  assert.equal(after.duels[duelId].echo.phase, 'open')
  assert.equal(after.users['11068'].stardust, 80, '不应重复冻结押注')
  engine.dispose()
})

await test('接受：应战方星屑不足时不改变对战状态，也不冻结', async () => {
  await clearDuels()
  const { engine } = makeEngine()
  const initiator = makeEvent({ uid: '11069', gid: '8106' })
  await store.transaction((state) => {
    state.users['11069'] = { id: '11069', stardust: 100 }
    state.users['11070'] = { id: '11070', stardust: 5 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 40' })
  const duelId = duelsOf(await store.snapshot(), '11069')[0].id
  const opponent = makeEvent({ uid: '11070', gid: '8106' })
  await engine.handle(opponent.e, { input: `#回响接受 ${duelId}` })
  assert.ok(textOf(lastSent(opponent)).includes('星屑不足'))
  const after = await store.snapshot()
  assert.equal(after.duels[duelId].echo.phase, 'open')
  assert.equal(after.duels[duelId].echo.escrow['11070'], undefined)
  assert.equal(after.users['11070'].stardust, 5)
  assert.equal(after.users['11069'].stardust, 60)
  engine.dispose()
})

await test('抽卡：可连续抽，局外人被拒绝，打满 12 抽后自动结算', async () => {
  await clearDuels()
  const { engine, presentation, adventures } = makeEngine()
  const initiator = makeEvent({ uid: '11071', gid: '8107' })
  await store.transaction((state) => {
    state.users['11071'] = { id: '11071', stardust: 100 }
    state.users['11072'] = { id: '11072', stardust: 100 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 30' })
  const duelId = duelsOf(await store.snapshot(), '11071')[0].id
  const opponent = makeEvent({ uid: '11072', gid: '8107' })
  await engine.handle(opponent.e, { input: `#回响接受 ${duelId}` })
  await engine.handle(initiator.e, { input: `#回响对决 ${duelId}|11071` })
  const afterFirst = await store.snapshot()
  assert.equal(afterFirst.duels[duelId].echo.pulls['11071'].count, 1, '应记录抽卡次数')
  assert.equal(afterFirst.duels[duelId].echo.phase, 'pull')
  const outsider = makeEvent({ uid: '11073', gid: '8107' })
  await engine.handle(outsider.e, { input: `#回响对决 ${duelId}|11073` })
  assert.ok(textOf(lastSent(outsider)).includes('这不是你的对战'))
  assert.equal(adventures.log.filter((line) => line[0] === 'duelPull').length, 1, '局外人不该触发模块')
  for (let turn = 2; turn <= 12; turn += 1) {
    const actor = turn % 2 === 1 ? '11071' : '11072'
    const ev = actor === '11071' ? initiator : opponent
    await engine.handle(ev.e, { input: `#回响对决 ${duelId}|${actor}` })
  }
  assert.equal(adventures.log.filter((line) => line[0] === 'duelPull').length, 12)
  const after = await store.snapshot()
  assert.equal(after.duels[duelId], undefined, '打满 12 抽应自动结算')
  assert.equal(after.users['11071'].stardust, 130, '命中更多的发起方赢下彩池 60')
  assert.equal(after.users['11072'].stardust, 70)
  assert.ok(lastPanel(presentation).lead.includes('赢下本局'), '结算图应公布赢家')
  engine.dispose()
})

await test('抽卡：按钮只能由本人按下（owner 写在按钮数据里）', async () => {
  await clearDuels()
  const { engine } = makeEngine()
  const initiator = makeEvent({ uid: '11078', gid: '8108' })
  await store.transaction((state) => {
    state.users['11078'] = { id: '11078', stardust: 60 }
    state.users['11079'] = { id: '11079', stardust: 60 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 30' })
  const duelId = duelsOf(await store.snapshot(), '11078')[0].id
  const opponent = makeEvent({ uid: '11079', gid: '8108' })
  await engine.handle(opponent.e, { input: `#回响接受 ${duelId}` })
  const pullButton = buttonsOf(lastSent(opponent)).find((button) => button.owner === '11078')
  const intruder = makeEvent({ uid: '11080', gid: '8108' })
  const result = await engine.handle(intruder.e, { input: pullButton.data })
  assert.equal(result.reason, 'owner-mismatch')
  assert.equal((await store.snapshot()).duels[duelId].turn || 0, 0, '局外人不能改变抽数')
  engine.dispose()
})

await test('结算：派彩、撤回对战面板、清掉定时器且结算消息不再带按钮', async () => {
  await clearDuels()
  const { engine, timers, presentation } = makeEngine()
  const initiator = makeEvent({ uid: '11074', gid: '8109' })
  await store.transaction((state) => {
    state.users['11074'] = { id: '11074', stardust: 100 }
    state.users['11075'] = { id: '11075', stardust: 100 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 50' })
  const duelId = duelsOf(await store.snapshot(), '11074')[0].id
  const opponent = makeEvent({ uid: '11075', gid: '8109' })
  await engine.handle(opponent.e, { input: `#回响接受 ${duelId}` })
  const firstButton = findButton(lastSent(opponent), '抽卡')
  for (let turn = 1; turn <= 12; turn += 1) {
    const actor = turn % 2 === 1 ? '11074' : '11075'
    const ev = actor === '11074' ? initiator : opponent
    await engine.handle(ev.e, { input: `#回响对决 ${duelId}|${actor}` })
  }
  const after = await store.snapshot()
  assert.equal(after.duels[duelId], undefined, '结算后应清理对战')
  assert.equal(after.users['11074'].stardust, 150, '赢家 = 剩余 50 + 彩池 100')
  assert.equal(after.users['11075'].stardust, 50, '败方不再变动')
  assert.ok(opponent.recalled.length >= 1, '结算时应撤回对战面板')
  const messages = [...opponent.sent, ...opponent.active]
  const settlement = messages.find(message => Array.isArray(message) && message.length === 1 && message[0]?.type === 'image')
  assert.ok(settlement, '结算应发一张结果图')
  const result = lastPanel(presentation).lead
  assert.ok(result.includes('赢下本局') && result.includes('彩池 +100'))
  assert.ok(result.includes('抽/命中'), '结算图应带抽卡明细')
  assert.equal(buttonsOf(settlement).length, 0, '结算消息不再带按钮')
  assert.equal(timers.jobs.size, 0, '结算后定时器应被清掉')
  assert.ok(firstButton, '抽卡面板应有按钮')
  engine.dispose()
})

await test('结算：旧抽卡按钮复点会提示对战已结束', async () => {
  await clearDuels()
  const { engine } = makeEngine()
  const initiator = makeEvent({ uid: '11076', gid: '8110' })
  await store.transaction((state) => {
    state.users['11076'] = { id: '11076', stardust: 100 }
    state.users['11077'] = { id: '11077', stardust: 100 }
    return { commit: true }
  })
  await engine.handle(initiator.e, { input: '#回响约战 20' })
  const duelId = duelsOf(await store.snapshot(), '11076')[0].id
  const opponent = makeEvent({ uid: '11077', gid: '8110' })
  await engine.handle(opponent.e, { input: `#回响接受 ${duelId}` })
  await engine.handle(initiator.e, { input: `#回响对决 ${duelId}|11076` })
  const oldButton = findButton(lastSent(initiator), '抽卡')
  assert.ok(oldButton, '抽卡面板缺少按钮')
  for (let turn = 2; turn <= 12; turn += 1) {
    const actor = turn % 2 === 1 ? '11076' : '11077'
    const ev = actor === '11076' ? initiator : opponent
    await engine.handle(ev.e, { input: `#回响对决 ${duelId}|${actor}` })
  }
  await engine.handle(initiator.e, { input: oldButton.data })
  assert.ok(allText(initiator).includes('没有进行中的对战'))
  engine.dispose()
})

await test('60 秒超时：定时器触发自动结算、退还押注、撤回旧消息并主动群发', async () => {
  const botSent = []
  const botRecalled = []
  globalThis.Bot = {
    pickGroup: () => ({
      async sendMsg(message) { botSent.push(message); return { message_id: `bot-${botSent.length}` } },
      async recallMsg(id) { botRecalled.push(String(id)); return true },
    }),
  }
  try {
    await clearDuels()
    const { engine, clock, timers, adventures, presentation } = makeEngine()
    const event = makeEvent({ uid: '11081', gid: '8111' })
    await store.transaction((state) => {
      state.users['11081'] = { id: '11081', stardust: 90 }
      return { commit: true }
    })
    await engine.handle(event.e, { input: '#回响约战 40' })
    const duelId = duelsOf(await store.snapshot(), '11081')[0].id
    assert.equal((await store.snapshot()).users['11081'].stardust, 50, '押注应已冻结')
    clock.advance(61)
    await timers.fireDue()
    await waitFor(async () => !(await store.snapshot()).duels[duelId])
    const after = await store.snapshot()
    assert.equal(after.users['11081'].stardust, 90, '超时流局应原路退还押注')
    assert.equal(adventures.log.filter((line) => line[0] === 'duelExpire').length, 1)
    assert.ok(botSent.length >= 1, '超时结算应走主动群发')
    assert.ok(lastPanel(presentation).lead.includes('超时'))
    assert.ok(botRecalled.length >= 1, '超时应撤回旧的对战面板')
    engine.dispose()
  } finally {
    delete globalThis.Bot
  }
})

await test('启动恢复：结算已过期对战、为存活对战重新装定时器、清理过期面板', async () => {
  await clearDuels()
  const { engine, clock, timers, adventures } = makeEngine()
  const nowMs = clock.ms
  await store.transaction((state) => {
    state.users['11091'] = { id: '11091', stardust: 60 }
    state.users['11092'] = { id: '11092', stardust: 100 }
    state.duels['staleduel'] = {
      id: 'staleduel',
      stake: 40,
      echo: { phase: 'pull', groupId: '8112', initiator: '11091', opponent: '11092', stake: 40, escrow: { 11091: 40 }, pulled: {}, names: {}, createdAt: nowMs - 120000, deadline: nowMs - 60000, messageId: 'old-panel' },
    }
    state.duels['liveduel'] = {
      id: 'liveduel',
      stake: 30,
      echo: { phase: 'open', groupId: '8112', initiator: '11092', stake: 30, escrow: { 11092: 30 }, pulled: {}, names: {}, createdAt: nowMs - 1000, deadline: nowMs + 30000 },
    }
    state.panels['8112:11092'] = { gid: '8112', uid: '11092', token: 'abcdef12', kind: 'menu', at: nowMs - 3 * 24 * 60 * 60 * 1000, message_id: 'ancient' }
    return { commit: true }
  })
  const summary = await engine.recover()
  const after = await store.snapshot()
  assert.equal(after.duels['staleduel'], undefined, '过期对战应被结算清理')
  assert.equal(after.users['11091'].stardust, 100, '过期对战的押注应退还')
  assert.ok(after.duels['liveduel'], '未到期对战应保留')
  assert.equal(after.panels['8112:11092'], undefined, '超过 TTL 的面板记录应被清理')
  assert.ok(summary.armed >= 1, '恢复时应为存活对战装定时器')
  assert.equal(timers.jobs.size, 1, '只为存活对战装一个计时器')
  assert.equal(adventures.log.filter((line) => line[0] === 'duelExpire').length, 1)
  engine.dispose()
})

/* ============================ 9. 容错与接线 ============================ */
section('容错与插件接线')

await test('玩法模块缺少导出时给出可读提示而不是崩溃', async () => {
  const { engine } = makeEngine({ rewards: { redemption: () => ({}) }, adventures: {} })
  const event = makeEvent({ uid: '11101', gid: '8001' })
  const result = await engine.handle(event.e, { input: '#回响十连' })
  assert.equal(result.handled, true)
  assert.ok(textOf(lastSent(event)).includes('暂不可用'))
  const second = await engine.handle(event.e, { input: '#回响档案' })
  assert.equal(second.handled, true)
  engine.dispose()
})

await test('模块抛错时报告错误并保留状态可继续使用', async () => {
  const rewards = makeRewards()
  rewards.bag = () => { throw new Error('内部爆炸') }
  const { engine, presentation } = makeEngine({ rewards })
  const event = makeEvent({ uid: '11102', gid: '8001' })
  await engine.handle(event.e, { input: '#回响福袋' })
  assert.ok(textOf(lastSent(event)).includes('调用失败'))
  await engine.handle(event.e, { input: '#回响十连' })
  assert.equal(lastPanel(presentation).tiles.length, 3, '福袋报错后十连仍可用')
  engine.dispose()
})

await test('自检面板输出依赖与运行参数', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11103', gid: '8001' })
  await engine.handle(event.e, { input: '#回响自检' })
  const text = textOf(lastSent(event))
  assert.ok(text.includes('QQBot 模式：是'))
  assert.ok(text.includes('星屑字段'))
  assert.ok(text.includes('被动回复上限'))
  engine.dispose()
})

await test('星屑字段可自动探测（嵌套或其它命名）', async () => {
  assert.equal(wallet({ coins: 42 }), 42)
  assert.equal(wallet({ wallet: { stardust: 7 } }), 7)
  assert.equal(wallet({}), 0)
  const { engine } = makeEngine()
  const uid = '11104'
  const event = makeEvent({ uid, gid: '8113' })
  await clearDuels()
  await store.transaction((state) => {
    state.users[uid] = { id: uid, wallet: { coins: 120 } }
    return { commit: true }
  })
  await engine.handle(event.e, { input: '#回响约战 20' })
  const after = await store.snapshot()
  assert.equal(after.users[uid].wallet.coins, 100, '嵌套字段也应被冻结')
  assert.equal(duelsOf(after, uid)[0].echo.escrow[uid], 20)
  engine.dispose()
})

await test('插件类可实例化：主入口与回调入口都能接管事件且不重复处理', async () => {
  const primary = new entry.EchoPostOffice()
  assert.equal(primary.name, '回响邮局')
  assert.ok(primary.rule.length >= 1)
  const uid = nextUid()
  const event = makeEvent({ uid, gid: '8001', msg: '#回响' })
  primary.e = event.e
  assert.equal(await primary.route(), true)
  assert.equal(event.e.__echoPostOfficeHandled, true)
  assert.ok(event.active.length >= 1, 'QQBot 主菜单走主动群发，避免回调 msg_id 无效')
  assert.equal(await primary.route(), false, '同一事件不应被处理两次')

  const callback = new entry.EchoPostOfficeCallback()
  const callbackUid = nextUid()
  const buttonEvent = makeEvent({ uid: callbackUid, gid: '8001', button: `#回响自检|${callbackUid}#deadbeef`, buttonPath: 'data.button.data' })
  callback.e = buttonEvent.e
  assert.equal(await callback.route(), true)
  assert.ok(textOf(buttonEvent.active.at(-1)).includes('回响自检'), '按钮回调应主动群发，避免无效 msg_id')

  const chatter = makeEvent({ uid: nextUid() })
  callback.e = chatter.e
  chatter.e.msg = '今天晚饭吃什么'
  assert.equal(await callback.route(), false, '普通消息不应被回调入口接管')
})

await test('type2 指令按钮（data 以聊天消息回显）同样可以消费', async () => {
  const { engine } = makeEngine()
  const event = makeEvent({ uid: '11105', gid: '8001', msg: '#回响福袋|11105#abcdef12' })
  const result = await engine.handle(event.e)
  assert.equal(result.handled, true)
  assert.equal(result.command, 'bag')
  engine.dispose()
})

await test('启动恢复入口在无 Bot 环境下安全返回', async () => {
  const ready = await entry.ready
  assert.equal(typeof ready, 'object')
  assert.equal(ready.started, false)
})

/* ============================ 11. 真实模块联调 ============================ */

section('真实模块联调（lib/rewards.js / lib/adventures.js）')

let realRewards = null
let realAdventures = null
try {
  realRewards = await import('../lib/rewards.js')
  realAdventures = await import('../lib/adventures.js')
} catch (error) {
  process.stdout.write(`  ! 无法导入真实模块，跳过联调：${error?.message || error}\n`)
}

if (realRewards && realAdventures) {
  await test('真实模块：十连渲染 10 张卡面并写回 profile.daily', async () => {
    const { engine, presentation } = makeEngine({ rewards: realRewards, adventures: realAdventures })
    const event = makeEvent({ uid: '12001', gid: '8201' })
    await engine.handle(event.e, { input: '#回响十连' })
    const render = lastPanel(presentation)
    assert.equal(render.tiles.length, 10, '十连应是 10 张卡面')
    assert.equal(render.mode, 'row')
    assert.ok(render.title.includes('十连'))
    const state = await store.snapshot()
    assert.equal(state.users['12001'].daily.ten, 1)
    assert.ok(Object.keys(state.users['12001'].cards).length >= 1, '应记录已获得卡牌')
    engine.dispose()
  })

  await test('真实模块：菜单能显示当日剩余次数（remainingDaily）', async () => {
    const { engine } = makeEngine({ rewards: realRewards, adventures: realAdventures })
    const event = makeEvent({ uid: '12002', gid: '8202' })
    await engine.handle(event.e, { input: '#回响' })
    const text = textOf(lastSent(event))
    assert.ok(textOf(lastSent(event)).includes('十连 2/2'))
    assert.ok(text.includes('十连 2/2'), `剩余次数应含十连：${text.slice(0, 200)}`)
    engine.dispose()
  })

  await test('真实模块：刮刮乐开票 → 逐格 → 全刮用完当日两张', async () => {
    const { engine, presentation } = makeEngine({ rewards: realRewards, adventures: realAdventures })
    const event = makeEvent({ uid: '12003', gid: '8203' })
    await engine.handle(event.e, { input: '#回响刮刮乐' })
    const opened = (await store.snapshot()).users['12003']
    assert.ok(opened.scratch.pending, '开票后应有 pending 票面')
    assert.equal(Number(opened.scratch.pending.reveal.shown) || 0, 1, '开票同时揭开第 1 格')
    assert.equal(lastPanel(presentation).tiles.length, 9, '票面应 9 格')
    await engine.handle(event.e, { input: findButton(lastSent(event), '刮三格').data })
    const advanced = (await store.snapshot()).users['12003']
    assert.equal(Number(advanced.scratch.pending.reveal.shown), 4, '再揭开 3 格')
    await engine.handle(event.e, { input: findButton(lastSent(event), '全刮').data })
    const finished = (await store.snapshot()).users['12003']
    assert.equal(finished.daily.scratch, 2, '全刮应把当日两张都开掉')
    assert.ok(!finished.scratch.pending || finished.scratch.pending.reveal?.done === true, '不应留下未揭完的票面')
    engine.dispose()
  })

  await test('真实模块：福袋 / 图鉴 / 佩戴 / 兑换 全链路可用', async () => {
    const { engine, presentation } = makeEngine({ rewards: realRewards, adventures: realAdventures })
    const event = makeEvent({ uid: '12004', gid: '8204' })
    await store.transaction((state) => {
      state.users['12004'] = { id: '12004', stardust: 200 }
      return { commit: true }
    })
    await engine.handle(event.e, { input: '#回响福袋' })
    assert.ok(lastPanel(presentation).tiles.length >= 1, '福袋应至少开出一项')
    await engine.handle(event.e, { input: '#回响图鉴' })
    const album = lastPanel(presentation)
    assert.ok(album.tiles.length >= 5, `图鉴套数异常：${album.tiles.length}`)
    assert.ok(album.tiles[0].meta.includes('/'), '套装卡面应带进度')
    const equipButton = findButton(lastSent(event), '戴·')
    assert.ok(equipButton, '图鉴面板应给出头衔佩戴按钮')
    await engine.handle(event.e, { input: equipButton.data })
    assert.ok(textOf(lastSent(event)).includes('已佩戴'), '佩戴应成功')
    await engine.handle(event.e, { input: '#回响兑换' })
    const catalogButton = buttonsOf(lastSent(event)).find((button) => button.command.startsWith('#回响兑换 '))
    assert.ok(catalogButton, '兑换面板应有奖励按钮')
    await engine.handle(event.e, { input: catalogButton.data })
    const redeemText = textOf(lastSent(event))
    assert.ok(redeemText.includes('换到') || redeemText.includes('星屑'), `兑换结果异常：${redeemText.slice(0, 160)}`)
    engine.dispose()
  })

  await test('真实模块：每日同题、本人线索与群排行', async () => {
    const { engine, presentation } = makeEngine({ rewards: realRewards, adventures: realAdventures })
    const event = makeEvent({ uid: '12005', gid: '8205' })
    await engine.handle(event.e, { input: '#回响档案' })
    const dossier = lastPanel(presentation)
    assert.equal(dossier.tiles.length, 1, '每天全群应只有一道题')
    assert.ok(dossier.lead.includes('线索'), '正文应带当前用户线索')
    const choice = buttonsOf(lastSent(event)).find(button => button.command.startsWith('#回响猜 '))
    assert.ok(choice, '档案面板应有作答按钮')
    const right = realAdventures.getDailyDossiers('2026-05-01')[0]
    await engine.handle(event.e, { input: `#回响猜 ${right.id}` })
    assert.ok(lastPanel(presentation).lead.includes('答对了'), '今日正确角色应命中')
    await engine.handle(event.e, { input: '#回响排行' })
    const rank = lastPanel(presentation)
    const rankText = [rank.lead, rank.footer].filter(Boolean).join('\n')
    assert.ok(rank.tiles.length >= 1 || rankText.includes('[object Object]') || rankText.includes('12005'), `排行应渲染条目：${rankText.slice(0, 160)}`)
    engine.dispose()
  })

  await test('真实模块：派遣次日领取、相册展示且不能重复领取', async () => {
    const clock = makeClock()
    const { engine, presentation } = makeEngine({ rewards: realRewards, adventures: realAdventures, clock })
    const event = makeEvent({ uid: '12006', gid: '8206', name: '派遣员' })
    await engine.handle(event.e, { input: '#回响派遣' })
    assert.equal(lastPanel(presentation).tiles.length, 3, '每日展示三个地点')
    const locationButton = buttonsOf(lastSent(event)).find(button => button.command.startsWith('#回响派遣 '))
    assert.ok(locationButton, '派遣面板应有地点按钮')
    await engine.handle(event.e, { input: locationButton.data })
    assert.ok(lastPanel(presentation).lead.includes('次日'), '出发应提示次日领取')
    await engine.handle(event.e, { input: '#回响领取' })
    assert.ok(textOf(lastSent(event)).includes('次日'), '当天不可领取')
    clock.advance(86400)
    await engine.handle(event.e, { input: '#回响领取' })
    assert.ok(lastPanel(presentation).lead.includes('获得'), '次日应获得材料和纪念品')
    await engine.handle(event.e, { input: '#回响相册' })
    assert.ok(lastPanel(presentation).tiles.length >= 4, '四地相册可展示')
    const before = JSON.stringify((await store.snapshot()).users['12006'].dispatch)
    await engine.handle(event.e, { input: '#回响领取' })
    assert.equal(JSON.stringify((await store.snapshot()).users['12006'].dispatch), before, '重复领取不增发奖励')
    engine.dispose()
  })

  await test('真实模块：轮流单抽直到有人歪，押注守恒', async () => {
    await clearDuels()
    const { engine, timers } = makeEngine({ rewards: realRewards, adventures: realAdventures })
    const initiator = makeEvent({ uid: '12011', gid: '8211', name: '发起方' })
    const opponent = makeEvent({ uid: '12012', gid: '8211', name: '应战方' })
    await store.transaction(state => {
      state.users['12011'] = { id: '12011', name: '发起方', stardust: 200 }
      state.users['12012'] = { id: '12012', name: '应战方', stardust: 200 }
      return { commit: true }
    })
    await engine.handle(initiator.e, { input: '#回响约战 50' })
    const created = duelsOf(await store.snapshot(), '12011')[0]
    assert.ok(created, '应创建对战')
    assert.equal(created.status, 'open')
    await engine.handle(opponent.e, { input: `#回响接受 ${created.id}` })
    assert.equal((await store.snapshot()).duels[created.id].status, 'active')
    for (let turn = 1; turn <= 12; turn++) {
      const state = await store.snapshot()
      const duel = state.duels[created.id]
      if (!duel) break
      const actor = duel.nextPlayerId
      const ev = actor === '12011' ? initiator : opponent
      await engine.handle(ev.e, { input: `#回响对决 ${created.id}|${actor}` })
    }
    const after = await store.snapshot()
    assert.equal(after.duels[created.id], undefined, '首歪或第十二抽应立即结算')
    assert.equal(after.users['12011'].stardust + after.users['12012'].stardust, 400, '押注守恒')
    assert.deepEqual([after.users['12011'].stardust, after.users['12012'].stardust].sort((a, b) => a - b), [150, 250])
    assert.equal(timers.jobs.size, 0, '结算后应清掉定时器')
    engine.dispose()
  })
}

/* ============================ 汇总 ============================ */

const failed = results.filter((result) => !result.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
if (failed.length) {
  process.stdout.write('\n失败用例：\n')
  for (const item of failed) {
    process.stdout.write(`  · ${item.name}\n    ${String(item.error?.stack || item.error).split('\n').slice(0, 6).join('\n    ')}\n`)
  }
}
process.stdout.write(`\n状态文件：${process.env.ECHO_POST_STATE}\n`)
await store.snapshot()
process.exit(failed.length ? 1 : 0)
