import { registerHooks } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
registerHooks({
  resolve(specifier, context, next) { return specifier === 'oicq' ? { url: 'oicq:companion-test', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) { return url === 'oicq:companion-test' ? { format: 'module', shortCircuit: true, source: 'export const segment={raw:v=>v,image:file=>({type:"image",file})}' } : next(url, context) }
})
const { createEngine, parseCommand } = await import('../apps/index.js')
const storeApi = await import('../lib/store.js')
const presentation = await import('../lib/presentation.js')
const rewards = await import('../lib/rewards.js')
const adventures = await import('../lib/adventures.js')

test('今日老婆命令接入菜单，跨玩法联动在事务内结算且不能重复领奖', async () => {
  assert.equal(parseCommand('#今日老婆').name, 'wife')
  assert.equal(parseCommand('#回响今日老婆').name, 'wife')
  const state = { users: {}, groups: {}, panels: {}, duels: {} }, sent = []
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation: { ...presentation, render: async () => null }, games: { rewards, adventures },
    config: { cooldownSeconds: 0 }, autoSweep: false, now: () => new Date('2026-09-28T10:00:00+08:00'),
    transport: { send: async (_e, _item, message) => { sent.push(message); return { message_id: String(sent.length) } }, recall: async () => true },
    logger: { info() {}, warn() {}, error() {} }
  })
  const event = { adapter_id: 'QQBot', group_id: 'g', user_id: 'u', sender: { nickname: '用户' } }
  try {
    for (const input of ['#今日老婆', '#回响十连', '#回响福袋', '#回响派遣 jinzhou']) await engine.handle(event, { input })
    assert.equal(Object.keys(state.users.u.companions.today.activities).length, 3)
    const before = state.users.u.stardust
    await engine.handle(event, { input: '#回响同行奖励' })
    assert.equal(state.users.u.stardust, before + 10)
    await engine.handle(event, { input: '#回响同行奖励' })
    assert.equal(state.users.u.stardust, before + 10)
    await engine.handle(event, { input: '#回响' })
    assert.match(JSON.stringify(sent.at(-1)), /今日老婆/)
  } finally { engine.dispose() }
})
