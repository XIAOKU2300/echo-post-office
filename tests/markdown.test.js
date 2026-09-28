import { registerHooks } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'oicq' ? { url: 'oicq:md-test', shortCircuit: true } : next(specifier, context)
  },
  load(url, context, next) {
    return url === 'oicq:md-test'
      ? { format: 'module', shortCircuit: true, source: 'export const segment = { raw: value => value, image: file => ({type:"image", file}) }' }
      : next(url, context)
  }
})
const presentation = await import('../lib/presentation.js')
const { createEngine, markdownBody } = await import('../apps/index.js')
const rewards = await import('../lib/rewards.js')
const adventures = await import('../lib/adventures.js')
const storeApi = await import('../lib/store.js')

function harness({ renderOk = true } = {}) {
  const state = { users: {}, groups: {}, panels: {}, duels: {} }
  const sends = []
  let rendered = 0, images = 0, clock = Date.parse('2026-09-28T10:00:00+08:00')
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation: { ...presentation, render: async () => { rendered++; return renderOk ? Buffer.from([137, 80, 78, 71]) : null }, image: file => { images++; return presentation.image(file) } },
    games: { rewards, adventures },
    transport: { send: async (_e, item, message) => { sends.push({ item, message }); return { message_id: `panel-${sends.length}` } }, recall: async () => true },
    now: () => new Date(clock), rng: () => () => 0.99,
    config: { cooldownSeconds: 0 }, autoSweep: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  const event = { adapter_id: 'QQBot', group_id: 'group', user_id: 'u1', message_id: 'msg', sender: { nickname: '测试' } }
  return { state, sends, engine, event, advance: ms => { clock += ms }, counts: () => ({ rendered, images }) }
}
function expectMarkdown(message, buttons = true) {
  assert.ok(Array.isArray(message))
  assert.equal(message[0].type, 'markdown')
  assert.ok(message[0].content.startsWith('# '))
  assert.equal(message.some(part => part.type === 'image'), false)
  assert.equal(message.some(part => part.type === 'keyboard'), buttons)
  return message[0].content
}

test('QQBot：菜单和帮助短 Markdown；各游戏有图时图片+按钮；无按钮结算一张图', async () => {
  const h = harness()
  try {
    h.state.users.u1 = { id: 'u1', stardust: 2000 }
    await h.engine.handle(h.event, { input: '#回响' })
    const menu = expectMarkdown(h.sends.at(-1).message)
    assert.ok(menu.includes('玩法说明') && !menu.includes('## 点按钮开始'))
    assert.ok(menu.length < 280, `主菜单太长：${menu.length}`)
    await h.engine.handle(h.event, { input: '#回响玩法' })
    expectMarkdown(h.sends.at(-1).message)
    assert.equal(h.sends.at(-1).message[1].content.rows.length, 4)
    await h.engine.handle(h.event, { input: '#回响玩法 福袋' })
    const detail = expectMarkdown(h.sends.at(-1).message)
    assert.match(detail, /一句话|怎么玩|能得到/)
    const commands = ['#回响十连', '#回响刮刮乐', '#回响福袋', '#回响图鉴', '#回响图鉴 展示', '#回响档案', '#回响派遣', '#回响派遣 jinzhou', '#回响相册']
    for (const input of commands) {
      await h.engine.handle(h.event, { input })
      const message = h.sends.at(-1).message
      assert.equal(message[0].type, 'image', `${input} 应发结果图`)
      assert.equal(message[1].type, 'keyboard', `${input} 应保留操作按钮`)
      assert.equal(typeof message[0].file, 'string')
    }
    await h.engine.handle(h.event, { input: '#回响排行' })
    expectMarkdown(h.sends.at(-1).message) // 空榜没有可展示的排行卡片
    await h.engine.handle(h.event, { input: '#回响兑换不存在' })
    expectMarkdown(h.sends.at(-1).message)
    h.advance(86400000)
    await h.engine.handle(h.event, { input: '#回响领取' })
    assert.equal(h.sends.at(-1).message[0].type, 'image')
    await h.engine.handle(h.event, { input: '#回响约战 50' })
    assert.equal(h.sends.at(-1).message[0].type, 'image')
    const duelId = Object.keys(h.state.duels)[0]
    assert.equal(h.state.duels[duelId].echo.qq, true)
    h.advance(61000)
    await h.engine.sweep()
    const settlement = h.sends.at(-1).message
    assert.equal(settlement.length, 1)
    assert.equal(settlement[0].type, 'image')
    assert.equal(h.state.duels[duelId], undefined)
    assert.ok(h.counts().images >= 10)
  } finally { h.engine.dispose() }
})

test('有图但渲染失败时自动降级 Markdown，保留按钮和卡片信息', async () => {
  const h = harness({ renderOk: false })
  try {
    await h.engine.handle(h.event, { input: '#回响十连' })
    assert.match(expectMarkdown(h.sends.at(-1).message), /10\. /)
    assert.deepEqual(h.counts(), { rendered: 1, images: 0 })
  } finally { h.engine.dispose() }
})

test('Markdown：隐藏刮刮格不泄露名称，标题不重复，结果超过900字不丢项目', () => {
  const tiles = Array.from({ length: 9 }, () => ({ hidden: true, name: '秘密大奖' }))
  const text = markdownBody({ title: '星愿刮刮乐', mode: 'scratch', tiles })
  assert.equal(text.includes('秘密大奖'), false)
  assert.equal(text.split('未刮开').length - 1, 9)
  const long = markdownBody({ lead: '结果'.repeat(700), tiles: [{ name: '最后一个奖励' }] })
  assert.ok(long.includes('最后一个奖励'))
  assert.ok(markdownBody({ tiles: [{ name: '*注入* [链接](bad)' }] }).includes('\\*注入\\*'))
})

test('图片兼容：Buffer 和 Uint8Array 都转换为字符串，避免 file.startsWith 异常', () => {
  for (const input of [Buffer.from([137, 80, 78, 71]), new Uint8Array([137, 80, 78, 71])]) {
    const part = presentation.image(input)
    assert.equal(typeof part.file, 'string')
    assert.equal(part.file.startsWith('base64://'), true)
    assert.deepEqual(Buffer.from(part.file.slice(9), 'base64'), Buffer.from(input))
  }
  assert.equal(presentation.image('https://example.com/card.png').file, 'https://example.com/card.png')
  assert.equal(presentation.menu('结算', '已结束', []).length, 1)
})

test('QQBot 回调 msg_id 失效：只走主动群发，失败保留旧面板，成功后撤回', async () => {
  const state = { users: { u1: { id: 'u1', stardust: 20 } }, groups: {}, panels: {}, duels: {} }
  const ops = []
  let oldMessage, reject = true, replies = 0
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation,
    games: { rewards, adventures },
    now: () => new Date('2026-09-28T10:00:00+08:00'),
    config: { cooldownSeconds: 0 }, autoSweep: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  const event = {
    adapter_id: 'QQBot', group_id: 'group', user_id: 'u1', message_id: 'original-message',
    sender: { nickname: '测试' },
    reply: async message => { replies++; oldMessage = message; ops.push('reply'); return { message_id: 'old-panel' } },
    group: {
      sendMsg: async message => {
        ops.push('active')
        if (reject) throw new Error('临时发送失败')
        assert.equal(message[0].type, 'markdown')
        return { message_id: 'new-panel' }
      },
      recallMsg: async id => { ops.push(`recall:${id}`); return true },
    },
  }
  try {
    await engine.handle(event, { input: '#回响' })
    const initial = structuredClone(state.panels['group:u1'])
    assert.equal(initial.message_id, 'old-panel')
    const command = oldMessage[1].content.rows[1].buttons[0].action.data
    event.message_id = 'invalid-callback-msg-id'
    event.button = { data: command }
    event.reply = async () => { replies++; throw new Error('40034024: msg_id 无效或越权') }
    await engine.handle(event)
    assert.equal(replies, 1, '回调不能调用 e.reply')
    assert.deepEqual(ops, ['reply', 'active'], '失败后不撤回旧面板，也不重复尝试失效 msg_id')
    assert.deepEqual(state.panels['group:u1'], initial, '旧按钮令牌在发送失败后恢复')
    reject = false
    await engine.handle(event)
    assert.equal(state.panels['group:u1'].message_id, 'new-panel')
    assert.deepEqual(ops, ['reply', 'active', 'active', 'recall:old-panel'])
  } finally { engine.dispose() }
})

test('日志中的 QQBot 复合用户 ID 保留按钮归属与面板令牌', async () => {
  const { parseCommand } = await import('../apps/index.js')
  const id = '3889704433:E80F31A235F5A1107C746469D750AE53'
  const command = parseCommand(`#回响刮刮乐|${id}#f83cd7b9`)
  assert.equal(command.ownerId, id)
  assert.equal(command.token, 'f83cd7b9')
  assert.equal(command.name, 'scratch')
})

test('新版公开按钮带 @cb 标记；旧版纯 #回响 返回按钮也不调用失效 msg_id', async () => {
  const { parseCommand } = await import('../apps/index.js')
  assert.equal(parseCommand('#回响玩法|@cb').callback, true)
  const menu = presentation.menu('玩法说明', '选择玩法', [[['返回菜单', '#回响', '*']]])
  assert.equal(menu[1].content.rows[0].buttons[0].action.data, '#回响|@cb')
  const state = { users: {}, groups: {}, panels: {}, duels: {} }
  let active = 0, passive = 0
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation, games: { rewards, adventures }, config: { cooldownSeconds: 0 }, autoSweep: false,
    logger: { info() {}, warn() {}, error() {} },
  })
  const e = { adapter_id: 'QQBot', group_id: 'group', user_id: 'u1', message_id: 'invalid-callback-msg-id', sender: { nickname: '测试' },
    msg: '#回响', reply: async () => { passive++; throw new Error('40034024') },
    group: { sendMsg: async message => { active++; assert.equal(message[0].type, 'markdown'); return { message_id: `active-${active}` } } }
  }
  try {
    await engine.handle(e)
    assert.equal(active, 1)
    assert.equal(passive, 0)
    e.msg = '#回响玩法|@cb'
    await engine.handle(e)
    assert.equal(active, 2)
    assert.equal(passive, 0)
  } finally { engine.dispose() }
})

test('结果图布局：十张横排、九格遮罩、福袋整链与收藏套系', async () => {
  const ten = rewards.drawTen({ pity: { counter: 29 } }, '2026-09-27', rewards.createRng(2026)).result.view
  ten.mode = 'row'
  const tenHtml = await presentation.renderHtml(ten)
  assert.match(tenHtml, /class="row ten"/)
  assert.equal((tenHtml.match(/class="tile /g) || []).length, 10)
  assert.match(tenHtml, /class="sheet golden"/)
  const profile = {}
  const scratch = rewards.scratch(profile, '2026-09-27', () => 0.99).result.view
  const scratchHtml = await presentation.renderHtml(scratch)
  assert.match(scratchHtml, /class="scratch"/)
  assert.equal((scratchHtml.match(/class="tile /g) || []).length, 9)
  const bag = rewards.bag(profile, '2026-09-27', () => 0.4).result
  assert.ok(bag.links.length >= 1)
  const sets = rewards.collection(profile).sets
  const gallery = await presentation.renderHtml({ title: '个人收藏馆', tiles: sets.map(x => ({ id: x.id, name: x.name, meta: x.progress })) , mode: 'grid' })
  assert.equal((gallery.match(/class="tile /g) || []).length, sets.length)
  assert.ok(gallery.includes('个人收藏馆'))
})
