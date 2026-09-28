import test from 'node:test'
import assert from 'node:assert/strict'
import { EchoPostOfficeCallback, engine } from '../apps/index.js'

test('回调类不注册全消息规则，普通聊天、空消息及其他插件按钮均被忽略', async () => {
  const callback = new EchoPostOfficeCallback()
  assert.equal(callback.rule.length, 0)
  for (const e of [{ msg: '今天晚饭吃什么' }, { msg: '' }, { msg: 'hello', button: { data: '#其他插件菜单' } }]) {
    assert.equal(await callback.accept(e), false)
    assert.equal(e.__echoPostOfficeHandled, undefined)
  }
})

test('有效回响按钮通过 accept 处理；相同事件不重复执行', async () => {
  const original = engine.handle
  let calls = 0
  engine.handle = async () => { calls++; return { handled: true } }
  try {
    const callback = new EchoPostOfficeCallback()
    const e = { msg: '', button: { data: '#回响十连|123#abcdef12' } }
    assert.equal(await callback.accept(e), 'return')
    assert.equal(await callback.accept(e), false)
    assert.equal(calls, 1)
  } finally { engine.handle = original }
})
