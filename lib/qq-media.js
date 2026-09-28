import { randomInt } from 'node:crypto'

const unwrap = part => part?.type === 'raw' ? part.data : part
const idOf = response => {
  const value = response?.data || response
  return value?.id || value?.message_id || null
}

/** Bypass qq-official-bot 1.0.3's broken active-image Sender branch. */
export async function sendQQMedia(e, item, message, fallback) {
  const parts = (Array.isArray(message) ? message : [message]).map(unwrap)
  const image = parts.find(part => part?.type === 'image')
  if (!image) return { handled: false }
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  const sdk = e?.bot?.sdk || globalThis.Bot?.[selfId]?.sdk
  if (typeof sdk?.request?.post !== 'function') return { handled: false }
  const rawGroup = String(item.gid || e?.group_id || '')
  const group = rawGroup.includes(':') ? rawGroup.slice(rawGroup.indexOf(':') + 1) : rawGroup
  if (!/^[a-zA-Z0-9_-]+$/.test(group) || group === '0') return { handled: false }
  const file = image.file
  if (typeof file !== 'string' || !file.startsWith('base64://')) return { handled: false }
  const base64 = file.slice(9)
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { handled: true, result: null }
  const endpoint = `/v2/groups/${group}`
  let imageId
  try {
    const upload = await sdk.request.post(`${endpoint}/files`, {
      file_type: 1, file_data: base64, srv_send_msg: false
    })
    const info = (upload?.data || upload)?.file_info
    if (typeof info !== 'string' || !info) return { handled: true, result: null }
    const sent = await sdk.request.post(`${endpoint}/messages`, {
      msg_type: 7, content: ' ', media: { file_info: info }, msg_seq: randomInt(1, 1000000)
    })
    imageId = idOf(sent)
    if (!imageId) return { handled: true, result: null }
  } catch {
    // Do not log SDK errors: they may embed Base64 payloads and request headers.
    return { handled: true, result: null }
  }
  if (!parts.some(part => part?.type === 'keyboard')) return { handled: true, result: { message_id: imageId } }
  // QQ keyboards belong to Markdown messages, not media (msg_type=7) messages.
  const plain = (Array.isArray(fallback) ? fallback : [fallback]).map(unwrap)
  const markdown = plain.find(part => part?.type === 'markdown')
  const keyboard = plain.find(part => part?.type === 'keyboard')
  try {
    if (!markdown || !keyboard) throw new Error('missing controls')
    const sent = await sdk.request.post(`${endpoint}/messages`, {
      msg_type: 2, markdown: { content: markdown.content },
      keyboard: { content: keyboard.content }, msg_seq: randomInt(1, 1000000)
    })
    const controlsId = idOf(sent)
    if (!controlsId) throw new Error('missing receipt')
    return { handled: true, result: { message_id: controlsId, extraMessageIds: [imageId] } }
  } catch {
    return { handled: true, result: { message_id: imageId, needsFallback: true } }
  }
}
