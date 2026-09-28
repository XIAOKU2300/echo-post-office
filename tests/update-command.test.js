import test from 'node:test'
import assert from 'node:assert/strict'
import { updateHandler, parseUpdateCommand, updateCommandPattern } from '../lib/update-command.js'
import { updateNetworkArgs, describeGitFailure } from '../lib/update-network.js'
import { EchoPostOfficeUpdater } from '../apps/updater.js'

test('双更新入口与双确认入口匹配；不消费普通消息或今日老婆', () => {
  for (const input of ['#更新回响', '#回响更新']) {
    assert.equal(parseUpdateCommand(input).action, 'check')
    assert.ok(new RegExp(updateCommandPattern).test(input))
  }
  const hash = 'a'.repeat(40)
  for (const input of [`#回响确认更新 ${hash}`, `#确认更新回响 ${hash}`]) assert.equal(parseUpdateCommand(input).target, hash)
  assert.equal(parseUpdateCommand('#回响今日老婆'), null)
  assert.equal(parseUpdateCommand('普通聊天'), null)
})

test('网络开始前立即回复检查提示，失败后明确反馈', async () => {
  const messages = []
  const handle = updateHandler({ check: async () => { assert.ok(messages[0].includes('正在检查')); throw new Error('代理不可达') } })
  await handle({ msg: '#更新回响', isMaster: true, user_id: 'u', reply: async text => messages.push(text) })
  assert.match(messages.at(-1), /代理不可达/)
})

test('长更新清单分段送达且完整保留全部文件，发送失败时不允许确认', async () => {
  const files = Array.from({ length: 95 }, (_, i) => ({ status: 'A', path: `lib/character-assets/ww_${i}.webp` }))
  const service = { root: '/plugins/echo-post-office', check: async () => ({ before: 'a'.repeat(40), target: 'b'.repeat(40), repository: 'example/repo', files }) }
  const confirmations = new Map(), messages = []
  await updateHandler(service, confirmations)({ msg: '#回响更新', isMaster: true, user_id: 'u', reply: async text => messages.push(text) })
  assert.ok(messages.every(text => text.length <= 800))
  for (const file of files) assert.ok(messages.join('\n').includes(file.path))
  assert.ok(confirmations.has('u'))
  const failed = new Map()
  await updateHandler(service, failed)({ msg: '#回响更新', isMaster: true, user_id: 'u', reply: async () => false })
  assert.equal(failed.size, 0)
})

test('accept 优先识别更新；非主人有明确提示且不重复响应', async () => {
  const instance = new EchoPostOfficeUpdater(), messages = []
  assert.ok(instance.priority < 1)
  assert.equal(await instance.accept({ msg: 'hello' }), false)
  const e = { msg: '#更新回响', user_id: 'u', isMaster: false, reply: async text => messages.push(text) }
  assert.equal(await instance.accept(e), 'return')
  assert.match(messages[0], /主人/)
  assert.equal(await instance.accept(e), false)
})

test('代理只通过单次 Git 参数传入；错误分类不输出凭据或原始 stderr', () => {
  assert.deepEqual(updateNetworkArgs(), ['-c', 'http.proxy=http://192.168.0.103:7890'])
  assert.deepEqual(updateNetworkArgs(''), [])
  assert.ok(updateNetworkArgs('socks5://192.168.0.103:7890'))
  assert.throws(() => updateNetworkArgs('https://user:password@host'))
  assert.match(describeGitFailure(['fetch'], { stderr: 'Failed to connect proxy secret-data' }), /连接远程仓库/)
  assert.ok(!describeGitFailure(['fetch'], { stderr: 'Failed to connect proxy secret-data' }).includes('secret-data'))
  assert.match(describeGitFailure(['status'], { stderr: 'detected dubious ownership' }), /目录所有者/)
  assert.match(describeGitFailure(['fetch'], { killed: true }), /超时/)
})
