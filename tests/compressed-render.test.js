import { registerHooks } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
registerHooks({
  resolve(specifier, context, next) { return specifier === 'oicq' ? { url: 'oicq:compressed-test', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) { return url === 'oicq:compressed-test' ? { format: 'module', shortCircuit: true, source: 'export const segment={raw:v=>v,image:file=>({type:"image",file})}' } : next(url, context) }
})
const { render } = await import('../lib/presentation.js')

test('真实渲染入口选择压缩截图，并关闭页面', async () => {
  const previous = globalThis.__echoPostBrowser
  const calls = [], viewports = []
  let closed = false
  globalThis.__echoPostBrowser = { newPage: async () => ({
    setViewport: async value => viewports.push(value), setContent: async () => {},
    $eval: async () => 1100,
    screenshot: async options => { calls.push(options); return Buffer.alloc(options.type === 'png' ? 300000 : 120000) },
    close: async () => { closed = true }
  }) }
  try {
    assert.equal((await render({ title: '测试' })).length, 120000)
    assert.equal(calls[1].type, 'jpeg')
    assert.equal(calls[1].quality, 82)
    assert.equal(viewports.at(-1).deviceScaleFactor, 1)
    assert.equal(closed, true)
  } finally { globalThis.__echoPostBrowser = previous }
})

test('异常高度不截图，返回文字回退信号并释放页面', async () => {
  const previous = globalThis.__echoPostBrowser
  let closed = false
  globalThis.__echoPostBrowser = { newPage: async () => ({
    setViewport: async () => {}, setContent: async () => {}, $eval: async () => 20000,
    screenshot: async () => { throw new Error('should not capture') }, close: async () => { closed = true }
  }) }
  try {
    assert.equal(await render({ title: '测试' }), null)
    assert.equal(closed, true)
  } finally { globalThis.__echoPostBrowser = previous }
})
