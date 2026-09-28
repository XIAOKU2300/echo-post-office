import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'oicq') return { url: 'oicq:stub', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'oicq:stub') {
      return { format: 'module', shortCircuit: true, source: 'export const segment = { raw: value => ({ type: "raw", value }), image: buffer => ({ type: "image", buffer }) }' }
    }
    return next(url, context)
  }
})


import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const scratch = process.env.PI_SCRATCH_DIR || os.tmpdir()
const stateFile = path.join(scratch, `echo-foundation-${process.pid}.json`)
process.env.ECHO_POST_STATE = stateFile

const store = await import(pathToFileURL(path.join(root, 'lib', 'store.js')).href)
const presentation = await import(pathToFileURL(path.join(root, 'lib', 'presentation.js')).href)
const rewards = await import(pathToFileURL(path.join(root, 'lib', 'rewards.js')).href)

await fs.rm(stateFile, { force: true })
delete globalThis.redis

function fakeRedis(options = {}) {
  const data = new Map(options.seed || [])
  const locks = new Map()
  let setFails = options.setFails || 0
  let getFails = options.getFails || 0
  let lockFails = options.lockFails || 0
  let held = 0
  const api = {
    async get(key) {
      if (getFails > 0) { getFails -= 1; throw new Error('redis down') }
      return data.has(key) ? data.get(key) : null
    },
    async set(key, value, opts) {
      if (opts?.NX) {
        if (lockFails > 0) { lockFails -= 1; throw new Error('redis down') }
        if (options.lockBusy) return null
        if (data.has(key)) return null
        data.set(key, value)
        locks.set(key, setTimeout(() => data.delete(key), opts.PX || 15000))
        held += 1
        return 'OK'
      }
      if (setFails > 0) { setFails -= 1; throw new Error('redis down') }
      data.set(key, value)
      return 'OK'
    },
    multi() {
      const ops = []
      const chain = {
        set(key, value) { ops.push([key, value]); return chain },
        async exec() {
          if (setFails > 0) { setFails -= 1; throw new Error('redis down') }
          for (const [key, value] of ops) data.set(key, value)
          return ops.map(() => 'OK')
        }
      }
      return chain
    },
    async eval(_script, payload) {
      const key = payload.keys[0]
      if (data.get(key) === payload.arguments[0]) {
        data.delete(key)
        clearTimeout(locks.get(key))
        return 1
      }
      return 0
    },
    dump: () => data
  }
  return api
}

await store.transaction(state => {
  state.users.a = { stardust: 3 }
  return { ok: true }
})
const first = JSON.parse(await fs.readFile(stateFile, 'utf8'))
assert.equal(first.schema, 1)
assert.equal(first.revision, 1)
assert.equal(first.state.users.a.stardust, 3)

await store.transaction(state => {
  state.users.a.stardust += 7
  return { commit: false }
})
const skipped = JSON.parse(await fs.readFile(stateFile, 'utf8'))
assert.equal(skipped.revision, 1)
assert.equal(skipped.state.users.a.stardust, 3)

await fs.writeFile(stateFile, JSON.stringify({ users: { a: { stardust: 9, legacy: true } }, groups: {}, duels: {}, panels: {} }))
const legacyRedis = fakeRedis()
globalThis.redis = legacyRedis
await store.transaction(state => {
  state.users.a.stardust += 1
  return { ok: true }
})
const legacyRemote = JSON.parse(legacyRedis.dump().get('Yz:echo-post-office:state:v1'))
assert.equal(legacyRemote.state.users.a.stardust, 10)
assert.equal(legacyRemote.state.users.a.legacy, true)
await fs.rm(stateFile, { force: true })
delete globalThis.redis
await store.transaction(state => {
  state.users.a = { stardust: 3 }
  return { ok: true }
})


const redis = fakeRedis()
globalThis.redis = redis
await store.transaction(state => {
  state.users.a.stardust += 10
  return { ok: true }
})
const mirrored = JSON.parse(await fs.readFile(stateFile, 'utf8'))
const remote = JSON.parse(redis.dump().get('Yz:echo-post-office:state:v1'))
assert.equal(mirrored.revision, remote.revision)
assert.equal(remote.state.users.a.stardust, 13)
assert.equal((await store.snapshot()).users.a.stardust, 13)

redis.dump().set('Yz:echo-post-office:state:v1', JSON.stringify({
  schema: 1,
  revision: 1,
  state: { users: { a: { stardust: 1 } }, groups: {}, duels: {}, panels: {} }
}))
await store.transaction(state => {
  state.users.a.badge = 'kept'
  return { ok: true }
})
const kept = JSON.parse(redis.dump().get('Yz:echo-post-office:state:v1'))
assert.equal(kept.state.users.a.stardust, 13)
assert.equal(kept.state.users.a.badge, 'kept')
assert.ok(kept.revision > mirrored.revision)

const broken = fakeRedis({ setFails: 1, seed: redis.dump() })
globalThis.redis = broken
await store.transaction(state => {
  state.users.a.stardust += 5
  return { ok: true }
})
const afterOutage = JSON.parse(await fs.readFile(stateFile, 'utf8'))
assert.equal(afterOutage.state.users.a.stardust, 18)
const stale = fakeRedis({
  seed: [[
    'Yz:echo-post-office:state:v1',
    JSON.stringify({ schema: 1, revision: 1, state: { users: { a: { stardust: 1 } }, groups: {}, duels: {}, panels: {} } })
  ]]
})
globalThis.redis = stale
const recovered = await store.snapshot()
assert.equal(recovered.users.a.stardust, 18)
await store.transaction(state => state)
const restored = JSON.parse(stale.dump().get('Yz:echo-post-office:state:v1'))
assert.equal(restored.state.users.a.stardust, 18)

const down = fakeRedis({ getFails: 1 })
globalThis.redis = down
const fromDisk = await store.snapshot()
assert.equal(fromDisk.users.a.stardust, 18)

const busy = fakeRedis({ lockBusy: true })
globalThis.redis = busy
await assert.rejects(() => store.transaction(state => {
  state.users.a.stardust = 0
  return { ok: true }
}), /超时/)
const untouched = JSON.parse(await fs.readFile(stateFile, 'utf8'))
assert.equal(untouched.state.users.a.stardust, 18)

delete globalThis.redis
const totals = await Promise.all(Array.from({ length: 20 }, (_, index) => store.transaction(state => {
  state.users.a.stardust += 1
  state.users.a.seq ??= []
  state.users.a.seq.push(index)
  return { ok: true }
})))
assert.equal(totals.length, 20)
const serial = JSON.parse(await fs.readFile(stateFile, 'utf8'))
assert.equal(serial.state.users.a.stardust, 38)
assert.equal(new Set(serial.state.users.a.seq).size, 20)

const svgA = presentation.cardSvg({ id: 'po_12', type: '场景', rarity: 'SSR' })
const svgB = presentation.cardSvg({ id: 'po_01', type: '角色', rarity: 'N' })
const hidden = presentation.cardSvg({ id: 'po_12', type: '场景', rarity: 'SSR', hidden: true })
assert.notEqual(svgA, svgB)
assert.match(svgA, /<svg/)
assert.match(svgA, /#f6d98a/)
assert.match(presentation.cardSvg({ id: 'po_10', type: '角色', rarity: 'SR' }), /#d7b7ea/)
assert.match(hidden, /opacity="0.28"/)
assert.equal(presentation.rarityClass('SSR'), 'gold')
assert.equal(presentation.rarityClass('传说'), 'gold')
assert.equal(presentation.rarityClass('金色回响'), 'gold')
assert.equal(presentation.rarityClass('SR'), 'purple')
assert.equal(presentation.rarityClass('紫蜡封'), 'purple')
assert.equal(presentation.rarityClass(rewards.rarities.find(item => item.id === 'SSR').style), 'gold')

const assetRoot = path.join(scratch, `echo-assets-${process.pid}`)
await fs.mkdir(path.join(assetRoot, 'dossiers'), { recursive: true })
await fs.mkdir(path.join(assetRoot, 'locations'), { recursive: true })
await fs.mkdir(path.join(assetRoot, 'cards'), { recursive: true })
await fs.writeFile(path.join(assetRoot, 'dossiers', 'night.png'), Buffer.from('night'))
await fs.writeFile(path.join(assetRoot, 'locations', 'pier.jpg'), Buffer.from('pier'))
await fs.writeFile(path.join(assetRoot, 'cards', 'po_12.png'), Buffer.from('cover'))
presentation.setAssetRoot(assetRoot)
const silhouette = await presentation.loadDossierArt({ silhouette: 'dossiers/night.png' })
assert.equal(silhouette.ok, true)
assert.match(silhouette.image, /^data:image\/png/)
const location = await presentation.loadDossierArt({ locationId: 'pier' })
assert.equal(location.source, 'locations')
const escaped = await presentation.loadDossierArt({ silhouette: '../store.js' })
assert.equal(escaped.ok, false)
const absolute = await presentation.loadDossierArt({ silhouette: stateFile })
assert.equal(absolute.ok, false)
const override = await presentation.art('cards', 'po_12')
assert.match(override, /^data:image\/png/)
assert.equal(await presentation.art('../cards', 'po_12'), '')

globalThis.puppeteer = { browser: { async newPage() { throw new Error('page should not open in this test') } } }
delete globalThis.__echoPostBrowser
const shared = await Promise.all([presentation.sharedBrowser(), presentation.sharedBrowser()])
assert.equal(shared[0], globalThis.puppeteer.browser)
assert.equal(shared[1], globalThis.puppeteer.browser)

const day = store.today(new Date('2024-03-01T16:30:00Z'))
assert.equal(day, '2024-03-02')
assert.equal(store.previousDay(day), '2024-03-01')

await fs.rm(stateFile, { force: true })
await fs.rm(assetRoot, { recursive: true, force: true })
console.log('foundation ok')
