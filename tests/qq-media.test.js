import test from 'node:test'
import assert from 'node:assert/strict'
import { sendQQMedia } from '../lib/qq-media.js'

const image = { type: 'image', file: 'base64://aGVsbG8=' }
const keyboard = { type: 'raw', data: { type: 'keyboard', content: { rows: [] } } }
const fallback = [{ type: 'raw', data: { type: 'markdown', content: '结果明细' } }, keyboard]
function event(post) { return { self_id: '123', group_id: '123:ABC', bot: { sdk: { request: { post } } } } }

test('主动图片上传使用纯 Base64；使用 file_info 发图，再发 Markdown 按钮', async () => {
  const calls = []
  const e = event(async (url, body) => {
    calls.push({ url, body })
    return { data: url.endsWith('/files') ? { file_info: 'opaque-media' } : { id: `message-${calls.length}` } }
  })
  const result = await sendQQMedia(e, {}, [image, keyboard], fallback)
  assert.equal(result.handled, true)
  assert.equal(calls[0].url, '/v2/groups/ABC/files')
  assert.deepEqual(calls[0].body, { file_type: 1, file_data: 'aGVsbG8=', srv_send_msg: false })
  assert.equal(calls[1].body.msg_type, 7)
  assert.deepEqual(calls[1].body.media, { file_info: 'opaque-media' })
  assert.equal(calls[1].body.msg_id, undefined)
  assert.equal(calls[1].body.keyboard, undefined)
  assert.equal(calls[2].body.msg_type, 2)
  assert.equal(calls[2].body.markdown.content, '结果明细')
  assert.deepEqual(result.result, { message_id: 'message-3', extraMessageIds: ['message-2'] })
})

test('上传失败不泄露错误负载、不继续发图；允许调用方文字回退', async () => {
  let count = 0
  const e = event(async () => { count++; throw new Error('request includes private payload') })
  assert.deepEqual(await sendQQMedia(e, {}, [image, keyboard], fallback), { handled: true, result: null })
  assert.equal(count, 1)
})

test('按钮发送失败保留已发图片 ID，要求文字回退', async () => {
  let count = 0
  const e = event(async () => {
    count++
    if (count === 3) throw new Error('keyboard rejected')
    return { data: count === 1 ? { file_info: 'info' } : { id: 'image-id' } }
  })
  const result = await sendQQMedia(e, {}, [image, keyboard], fallback)
  assert.deepEqual(result.result, { message_id: 'image-id', needsFallback: true })
})

test('不影响非官方适配器、纯文字和远程 URL 图片', async () => {
  assert.equal((await sendQQMedia({}, {}, [image], fallback)).handled, false)
  const e = event(async () => { throw new Error('must not send') })
  assert.equal((await sendQQMedia(e, {}, ['text'], fallback)).handled, false)
  assert.equal((await sendQQMedia(e, {}, [{ ...image, file: 'https://example.com/a.png' }], fallback)).handled, false)
})
