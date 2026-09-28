import { registerHooks } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
registerHooks({
  resolve(specifier, context, next) { return specifier === 'oicq' ? { url: 'oicq:delivery-test', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) { return url === 'oicq:delivery-test' ? { format: 'module', shortCircuit: true, source: 'export const segment={raw:v=>v,image:file=>({type:"image",file})}' } : next(url, context) }
})
const { createEngine } = await import('../apps/index.js')
const presentation = await import('../lib/presentation.js')
const rewards = await import('../lib/rewards.js')
const storeApi = await import('../lib/store.js')

test('图片上传失败后发送文字和按钮，玩法只结算一次，新面板成功后才撤回旧消息', async () => {
  const state = { users: {}, groups: {}, duels: {}, panels: { 'g:u': { token: 'old', message_id: 'old-buttons', extraMessageIds: ['old-image'] } } }
  const sent = [], recalled = []
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation: { ...presentation, render: async () => Buffer.from('png') },
    games: { rewards }, autoSweep: false, config: { cooldownSeconds: 0 },
    transport: { send: async (_e, _item, message) => { sent.push(message); return sent.length === 1 ? null : { message_id: 'fallback-id' } }, recall: async (_e, _gid, id) => { recalled.push(id) } },
    logger: { info() {}, warn() {}, error() {} }
  })
  try {
    await engine.handle({ adapter_id: 'QQBot', group_id: 'g', user_id: 'u', sender: { nickname: '用户' } }, { input: '#回响十连' })
    assert.equal(sent.length, 2)
    assert.equal(sent[0][0].type, 'image')
    assert.equal(sent[1][0].type, 'markdown')
    assert.ok(sent[1].some(part => part.type === 'keyboard'))
    assert.equal(state.users.u.daily.ten, 1)
    assert.equal(state.panels['g:u'].message_id, 'fallback-id')
    assert.deepEqual(recalled.sort(), ['old-buttons', 'old-image'])
  } finally { engine.dispose() }
})

test('图片和文字均失败时保留旧面板令牌，不撤回旧消息', async () => {
  const state = { users: {}, groups: {}, duels: {}, panels: { 'g:u': { token: 'old', message_id: 'old-id' } } }
  let recalls = 0
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation: { ...presentation, render: async () => Buffer.from('png') },
    games: { rewards }, autoSweep: false, config: { cooldownSeconds: 0 },
    transport: { send: async () => null, recall: async () => { recalls++ } },
    logger: { info() {}, warn() {}, error() {} }
  })
  try {
    await engine.handle({ adapter_id: 'QQBot', group_id: 'g', user_id: 'u', sender: { nickname: '用户' } }, { input: '#回响十连' })
    assert.equal(state.panels['g:u'].token, 'old')
    assert.equal(state.panels['g:u'].message_id, 'old-id')
    assert.equal(recalls, 0)
  } finally { engine.dispose() }
})
