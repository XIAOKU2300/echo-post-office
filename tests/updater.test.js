import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdater, githubRepository, validateChanges } from '../lib/updater.js'
import { createUpdateHandler } from '../apps/updater.js'

const before = 'a'.repeat(40), target = 'b'.repeat(40)
function fixture(options = {}) {
  const calls = []
  const run = async args => {
    calls.push(args)
    const cmd = args.join(' ')
    if (cmd === 'rev-parse --show-toplevel') return options.top || '/example/plugin'
    if (args[0] === 'status') return options.dirty ? ' M lib/rewards.js' : ''
    if (args[0] === 'symbolic-ref') return 'main'
    if (args[0] === 'remote') return options.remote || 'https://github.com/example/echo-post-office.git'
    if (cmd === 'rev-parse HEAD') return before
    if (cmd === 'rev-parse FETCH_HEAD') return options.current ? before : target
    if (args[0] === 'fetch' && options.networkError) throw new Error('network unavailable')
    if (args[0] === 'merge-base' && options.diverged) throw new Error('diverged')
    if (args[0] === 'diff') return options.diff || 'M\0lib/presentation.js\0'
    if (args[0] === 'ls-tree') return `${options.mode || '100644'} blob ${target}\tlib/presentation.js`
    return ''
  }
  return { service: createUpdater({ root: '/example/plugin', run, makeBackupDirectory: async () => {} }), calls }
}

test('只接受不含凭据的 GitHub 仓库地址', () => {
  assert.equal(githubRepository('git@github.com:example/echo-post-office.git'), 'example/echo-post-office')
  assert.equal(githubRepository('https://github.com/example/echo-post-office'), 'example/echo-post-office')
  for (const url of ['https://token@github.com/example/repo', 'https://other.test/example/repo', '/tmp/repo']) assert.throws(() => githubRepository(url))
})

test('拒绝删除、路径逃逸和运行数据变更', () => {
  for (const diff of ['D\0lib/a.js\0', 'M\0../a.js\0', 'M\0data/state.json\0', 'A\0.env\0', 'A\0assets/card.png\0', 'M\0.git/config\0']) assert.throws(() => validateChanges(diff))
  assert.equal(validateChanges('A\0lib/new.js\0M\0README.md\0').length, 2)
})

test('检查更新不合并；确认后先备份再快进', async () => {
  const { service, calls } = fixture()
  const plan = await service.check()
  assert.equal(plan.target, target)
  assert.equal(calls.some(args => args.includes('merge')), false)
  const result = await service.apply(before, target)
  assert.equal(result.updated, true)
  const backup = calls.findIndex(args => args[0] === 'bundle')
  const merge = calls.findIndex(args => args.includes('merge'))
  assert.ok(backup >= 0 && merge > backup)
  assert.ok(calls[merge].includes('--ff-only'))
  assert.equal(calls[merge].at(-1), target)
})

test('本地改动、错误仓库、分叉、符号链接、网络失败均停止', async () => {
  for (const options of [{ dirty: true }, { top: '/example' }, { diverged: true }, { mode: '120000' }, { networkError: true }]) {
    const { service, calls } = fixture(options)
    await assert.rejects(service.apply(before, target))
    assert.equal(calls.some(args => args.includes('merge')), false)
  }
})

test('过期版本不能更新，最新版本不创建备份', async () => {
  const stale = fixture()
  await assert.rejects(stale.service.apply(before, 'c'.repeat(40)), /版本已变化/)
  const latest = fixture({ current: true })
  assert.equal((await latest.service.check()).current, true)
  assert.equal(latest.calls.some(args => args[0] === 'bundle'), false)
})

test('非主人无法检查或更新；确认仅绑定原主人并在十分钟后失效', async () => {
  let checked = 0, applied = 0, now = 0
  const replies = [], confirmations = new Map()
  const service = { root: '/example/plugin', check: async () => { checked++; return { before, target, repository: 'example/repo', files: [{ status: 'M', path: 'lib/a.js' }] } }, apply: async () => { applied++; return { updated: true, target, backup: '/example/backup.bundle' } } }
  const handle = createUpdateHandler(service, confirmations, () => now)
  const event = { msg: '#回响更新', user_id: 'owner', isMaster: false, reply: async text => replies.push(text) }
  await handle(event)
  assert.equal(checked, 0)
  event.isMaster = true
  await handle(event)
  assert.equal(checked, 1)
  await handle({ ...event, user_id: 'other', msg: `#回响确认更新 ${target}` })
  assert.equal(applied, 0)
  now = 600001
  await handle({ ...event, msg: `#回响确认更新 ${target}` })
  assert.equal(applied, 0)
  await handle(event)
  await handle({ ...event, msg: `#回响确认更新 ${target}` })
  assert.equal(applied, 1)
  await handle({ ...event, msg: `#回响确认更新 ${target}` })
  assert.equal(applied, 1)
})
