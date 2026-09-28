import test from 'node:test'
import assert from 'node:assert/strict'
import { compressScreenshot } from '../lib/image-compression.js'

test('小图片保留无损 PNG，不进行多余编码', async () => {
  let count = 0
  const result = await compressScreenshot(async options => { count++; assert.equal(options.type, 'png'); return Buffer.alloc(1000) })
  assert.equal(count, 1)
  assert.equal(result.length, 1000)
})

test('大图片先保持分辨率，以 JPEG 压缩至目标范围', async () => {
  const calls = []
  const result = await compressScreenshot(async options => { calls.push(options); return Buffer.alloc(options.type === 'png' ? 400000 : 160000) })
  assert.equal(result.length, 160000)
  assert.deepEqual(calls[1], { type: 'jpeg', quality: 82, scale: 1 })
  assert.equal(calls.length, 2)
})

test('JPEG 更大时保留 PNG，避免压缩后文件反而增大', async () => {
  const result = await compressScreenshot(async options => Buffer.alloc(options.type === 'png' ? 180000 : 230000))
  assert.equal(result.length, 180000)
})

test('超大图片逐步降低分辨率；编码失败时保留可用结果', async () => {
  const calls = []
  const result = await compressScreenshot(async options => { calls.push(options); if (options.quality === 82) throw new Error('unsupported'); return Buffer.alloc(options.scale < 1 ? 240000 : 500000) })
  assert.equal(result.length, 240000)
  assert.equal(calls.at(-1).scale, 0.8)
})

test('仍超过上传保护上限时返回 null，由调用方使用文字回退', async () => {
  assert.equal(await compressScreenshot(async () => Buffer.alloc(1100000)), null)
})
