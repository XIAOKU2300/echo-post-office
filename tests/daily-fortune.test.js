import test from 'node:test'
import assert from 'node:assert/strict'
import { dailyFortune, grantDailyFortune } from '../lib/daily-fortune.js'
import { companionPoster } from '../lib/companion-poster.js'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, next) { return specifier === 'oicq' ? { url: 'oicq:fortune-test', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) { return url === 'oicq:fortune-test' ? { format: 'module', shortCircuit: true, source: 'export const segment={raw:v=>v,image:file=>({type:"image",file})}' } : next(url, context) }
})

test('同人同日运势稳定，星屑额度限定为 5–20', () => {
  const character = { id: 'a', name: '长离' }
  assert.deepEqual(dailyFortune('u', '2026-09-28', character), dailyFortune('u', '2026-09-28', character))
  for (let i = 0; i < 500; i++) {
    const result = dailyFortune(String(i), '2026-09-28', character)
    assert.ok(result.allowance >= 5 && result.allowance <= 20)
    assert.ok(result.score >= 60 && result.score <= 100)
    assert.ok(result.greeting.includes(character.name))
  }
})

test('重复领取只发一次幸运星屑，旧记录兼容首次补领', () => {
  const profile = { stardust: 10 }, today = { day: '2026-09-28', character: { id: 'a', name: '长离' } }
  assert.equal(grantDailyFortune(profile, today, 'u'), true)
  const balance = profile.stardust
  assert.equal(balance, 10 + today.fortune.allowance)
  assert.equal(grantDailyFortune(profile, today, 'u'), false)
  assert.equal(profile.stardust, balance)
  assert.doesNotThrow(() => JSON.stringify(today))
})

test('角色海报转义动态内容，并显示运势和娱乐说明', () => {
  const fortune = dailyFortune('u', '2026-09-28', { name: '<script>角色</script>' })
  const html = companionPoster({ tile: { name: '<script>角色</script>', poster: { day: '2026-09-28', fortune, progress: 99, affection: 2, encounters: 1, luckyGranted: true } }, lead: fortune.greeting, footer: '同行进度 1/3' }, '<img alt="角色">')
  assert.ok(html.includes('&lt;script&gt;角色&lt;/script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('运势仅供娱乐'))
  assert.ok(html.includes('width:100%'))
})

test('实际命令首次发幸运星屑，跨群重开不重领，次日可以再领', async () => {
  const { createEngine } = await import('../apps/index.js')
  const storeApi = await import('../lib/store.js')
  const presentation = await import('../lib/presentation.js')
  const state = { users: {}, groups: {}, panels: {}, duels: {} }
  let day = '2026-09-28', count = 0
  const engine = createEngine({
    store: { ...storeApi, transaction: async fn => fn(state), snapshot: async () => structuredClone(state) },
    presentation: { ...presentation, render: async () => null },
    now: () => new Date(`${day}T10:00:00+08:00`), config: { cooldownSeconds: 0 }, autoSweep: false,
    transport: { send: async () => ({ message_id: String(++count) }), recall: async () => true },
    logger: { info() {}, warn() {}, error() {} }
  })
  const e = { adapter_id: 'QQBot', user_id: 'test', group_id: 'g1', sender: { nickname: '测试' } }
  try {
    await engine.handle(e, { input: '#今日老婆' })
    const initial = state.users.test.stardust
    assert.ok(initial >= 5 && initial <= 20)
    await engine.handle({ ...e, group_id: 'g2' }, { input: '#今日老婆' })
    assert.equal(state.users.test.stardust, initial)
    day = '2026-09-29'
    await engine.handle(e, { input: '#今日老婆' })
    assert.equal(state.users.test.stardust, initial + state.users.test.companions.today.fortune.allowance)
  } finally { engine.dispose() }
})
