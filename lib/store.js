import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const file = process.env.ECHO_POST_STATE || path.join(process.cwd(), 'data', 'echo-post-office', 'state.json')
const redisKey = 'Yz:echo-post-office:state:v1'
const lockKey = `${redisKey}:lock`
const metaKey = `${redisKey}:meta`
const MIRROR_SCHEMA = 1
let queue = Promise.resolve()

function empty() { return { users: {}, groups: {}, duels: {}, panels: {} } }
function normalize(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : empty()
  for (const key of ['users', 'groups', 'duels', 'panels']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {}
  }
  return state
}
function clone(value) { return JSON.parse(JSON.stringify(normalize(value))) }

function client() { return globalThis.redis || null }
function isTimeout(error) { return String(error?.message || error).includes('超时') }

/** node-redis v4 的 NX+PX 返回 'OK'；部分封装返回 true。连接级故障继续抛出。 */
async function setNxPx(redis, key, token, px) {
  return redis.set(key, token, { NX: true, PX: px })
}

async function readFile() {
  try { return normalize(JSON.parse(await fs.readFile(file, 'utf8'))) }
  catch (error) {
    if (error.code === 'ENOENT') return empty()
    throw error
  }
}

async function readMirror() {
  let raw
  try { raw = await fs.readFile(file, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return { state: empty(), revision: 0, updatedAt: 0 }
    throw error
  }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch { return { state: empty(), revision: 0, updatedAt: 0, corrupt: true } }
  if (parsed && parsed.schema === MIRROR_SCHEMA && parsed.state && typeof parsed.state === 'object') {
    return {
      state: normalize(parsed.state),
      revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
    }
  }
  // 旧版纯状态 JSON：没有修订号，不能拿来覆盖带修订号的本地新奖励。
  return { state: normalize(parsed), revision: 0, updatedAt: 0, legacy: true }
}

/** 本地原子镜像：同目录临时文件 + rename。失败不留下半截 state.json。 */
async function writeMirror(state, revision) {
  const payload = {
    schema: MIRROR_SCHEMA,
    revision,
    updatedAt: Date.now(),
    state: normalize(state)
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(payload), { flag: 'wx' })
  try { await fs.rename(temporary, file) }
  catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return payload
}

async function readRedisState(redis) {
  const raw = await redis.get(redisKey)
  if (!raw) return { missing: true, state: empty(), revision: 0 }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch { return { corrupt: true, state: empty(), revision: 0 } }
  if (parsed && parsed.schema === MIRROR_SCHEMA && parsed.state && typeof parsed.state === 'object') {
    return {
      state: normalize(parsed.state),
      revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
    }
  }
  return { state: normalize(parsed), revision: 0, updatedAt: 0, legacy: true }
}

/**
 * Redis 优先，但读的是和事务同一份来源。
 * 本地镜像修订号更高时，不用 Redis 里的旧状态盖掉已落盘的新奖励。
 */
async function loadLocked(redis) {
  const mirror = await readMirror()
  if (!redis) return { state: clone(mirror.state), backend: 'file', revision: mirror.revision }
  let remote
  try { remote = await readRedisState(redis) }
  catch (error) {
    globalThis.logger?.warn?.(`[回响邮局] Redis 读取失败，改用本地镜像：${error}`)
    return { state: clone(mirror.state), backend: 'file', revision: mirror.revision, degraded: true }
  }
  if (remote.corrupt) {
    globalThis.logger?.warn?.('[回响邮局] Redis 状态损坏，改用本地镜像')
    return { state: clone(mirror.state), backend: 'file', revision: mirror.revision, degraded: true }
  }
  if (!remote.missing && remote.revision >= mirror.revision) {
    return { state: clone(remote.state), backend: 'redis', revision: remote.revision, mirror }
  }
  if (remote.missing && mirror.revision === 0 && !mirror.legacy) {
    return { state: clone(mirror.state), backend: 'redis', revision: 0, mirror }
  }
  if (remote.missing && mirror.legacy) {
    return { state: clone(mirror.state), backend: 'redis', revision: mirror.revision, preferLocal: true, mirror }
  }
  // 本地更新：以镜像为准，恢复时再写回 Redis，禁止旧快照回灌。
  return { state: clone(mirror.state), backend: 'redis', revision: mirror.revision, preferLocal: true, mirror }
}

async function persist(redis, state, revision, backend) {
  const next = revision + 1
  // 先落本地原子镜像，Redis 故障时奖励已经在磁盘上。
  await writeMirror(state, next)
  if (backend !== 'redis') return { revision: next, backend: 'file' }
  try {
    const payload = JSON.stringify({ schema: MIRROR_SCHEMA, revision: next, updatedAt: Date.now(), state: normalize(state) })
    if (typeof redis.multi === 'function') {
      await redis.multi().set(redisKey, payload).set(metaKey, String(next)).exec()
    } else {
      await redis.set(redisKey, payload)
      await redis.set(metaKey, String(next))
    }
    return { revision: next, backend: 'redis' }
  } catch (error) {
    globalThis.logger?.warn?.(`[回响邮局] Redis 写入失败，已保留本地镜像：${error}`)
    return { revision: next, backend: 'file', degraded: true }
  }
}

/**
 * 锁失败不能降级成无锁写入。
 * 只有 Redis 客户端不存在，或连接/命令本身故障，才允许单机 JSON 事务。
 */
async function obtainLock() {
  const redis = client()
  if (!redis) return { token: null, redis: null, backend: 'file' }
  const token = randomUUID()
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ok = await setNxPx(redis, lockKey, token, 15000)
      if (ok === 'OK' || ok === true) return { token, redis, backend: 'redis' }
      await new Promise(resolve => setTimeout(resolve, 40 + attempt * 15))
    }
    throw new Error('Redis 状态锁超时')
  } catch (error) {
    if (isTimeout(error)) throw error
    globalThis.logger?.warn?.(`[回响邮局] Redis 不可用，改用 JSON：${error}`)
    return { token: null, redis: null, backend: 'file', degraded: true }
  }
}

async function releaseLock(held) {
  if (!held?.token || !held.redis) return
  try {
    // Redis 原子比较并删除，避免删除已过期且由其他实例取得的锁。
    await held.redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      { keys: [lockKey], arguments: [held.token] }
    )
  } catch (error) {
    globalThis.logger?.warn?.(`[回响邮局] 释放锁失败：${error}`)
  }
}

/** 一次读取、修改、提交；所有玩法和押注共用同一事务。 */
export function transaction(fn) {
  const work = async () => {
    const held = await obtainLock()
    try {
      const loaded = await loadLocked(held.redis)
      const state = loaded.state
      const result = await fn(state)
      if (result?.commit !== false) {
        const saved = await persist(held.redis, state, loaded.revision, loaded.backend === 'redis' && held.backend === 'redis' ? 'redis' : 'file')
        if (result && typeof result === 'object') result.storage = saved
      }
      return result
    } finally { await releaseLock(held) }
  }
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

/** 与事务共用队列和同一读取路径，避免快照读到另一份来源。 */
export function snapshot() {
  const work = async () => {
    const held = await obtainLock()
    try {
      const loaded = await loadLocked(held.redis)
      return loaded.state
    } finally { await releaseLock(held) }
  }
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

export function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
export function previousDay(day) {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).replaceAll('/', '-')
}
export function user(state, id) { return state.users[id] ||= {} }
export function group(state, id) { return state.groups[id] ||= {} }
