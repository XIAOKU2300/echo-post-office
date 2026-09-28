import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const validId = id => typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id)
export function validateRoster(value) {
  if (!Array.isArray(value)) return []
  const unique = new Map()
  for (const entry of value.slice(0, 500)) {
    if (validId(entry?.id) && typeof entry.name === 'string' && entry.name.trim()) unique.set(entry.id, { id: entry.id, name: entry.name.trim().slice(0, 50) })
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))
}

export async function loadCompanionRoster() {
  const configured = globalThis.echoPostOfficeConfig?.companions
  if (configured !== undefined) return validateRoster(configured)
  try {
    return validateRoster(JSON.parse(await readFile(new URL('../assets/companions/roster.json', import.meta.url), 'utf8')))
  } catch {
    try { return validateRoster(JSON.parse(await readFile(new URL('./character-assets/roster.json', import.meta.url), 'utf8'))) }
    catch { return [] }
  }
}

export async function companionAvatar(id, portrait = false) {
  if (!validId(id)) return ''
  if (portrait) {
    try { return `data:image/webp;base64,${(await readFile(new URL(`./character-assets/artwork/${id}.webp`, import.meta.url))).toString('base64')}` }
    catch { /* Use the avatar if full artwork is unavailable. */ }
  }
  try { return `data:image/webp;base64,${(await readFile(new URL(`./character-assets/${id}.webp`, import.meta.url))).toString('base64')}` }
  catch { return '' }
}

function stateOf(profile) {
  return profile.companions ||= { today: null, bonds: {}, milestoneDay: '' }
}

export function meetCompanion(profile, userId, day, roster) {
  const characters = validateRoster(roster)
  const current = profile.companions?.today
  if (current?.day === day) return { character: current.character, repeated: true }
  if (!characters.length) return { error: '鸣潮角色素材还在准备中，导入角色名单后即可领取今日老婆。' }
  const index = createHash('sha256').update(`${userId}:${day}`).digest().readUInt32BE(0) % characters.length
  const character = characters[index]
  const state = stateOf(profile)
  state.today = { day, character, activities: {} }
  const bond = state.bonds[character.id] ||= { name: character.name, affection: 0, encounters: 0 }
  bond.name = character.name
  bond.encounters += 1
  bond.affection += 1
  return { character, repeated: false }
}

const activities = {
  drawTen: ['draw', '十连补给'], scratch: ['scratch', '刮刮乐'], bag: ['bag', '福袋'],
  dispatchStart: ['dispatch', '派遣出发'], dispatchClaim: ['claim', '领取派遣'],
  dossierGuess: ['guess', '答对档案'], redeem: ['redeem', '图鉴兑换']
}

/** Called in the existing profile transaction only after a successful game action. */
export function recordCompanionActivity(profile, day, action, result) {
  const state = profile.companions, today = state?.today
  const activity = activities[action]
  if (!activity || !today || today.day !== day || (action === 'dossierGuess' && result?.correct !== true)) return ''
  const [key, label] = activity
  if (today.activities[key]) return ''
  const bond = state.bonds[today.character.id]
  if (!bond) return ''
  today.activities[key] = true
  bond.affection += 2
  return `与${today.character.name}完成${label}，亲密度 +2（今日 ${Math.min(3, Object.keys(today.activities).length)}/3 类）`
}

export function claimCompanionReward(profile, day) {
  const state = profile.companions, today = state?.today
  if (!today || today.day !== day) return { error: '先领取今日老婆，再一起完成玩法。' }
  if (state.milestoneDay === day) return { error: '今天的同行奖励已经领取，明天再来。' }
  if (Object.keys(today.activities).length < 3) return { error: '完成三类不同玩法后，可以领取同行奖励。' }
  state.milestoneDay = day
  profile.stardust = Math.max(0, Number(profile.stardust) || 0) + 10
  state.bonds[today.character.id].affection += 5
  return { text: '同行奖励已领取：星屑 +10，亲密度 +5。' }
}

export function companionPanel(profile, day) {
  const state = profile.companions, today = state?.today
  if (!today || today.day !== day) return { title: '今日老婆', lead: '今日的同行故事还未开始。', tiles: [], footer: '每天领取一次，当天角色固定。' }
  const bond = state.bonds[today.character.id]
  const progress = Math.min(3, Object.keys(today.activities).length)
  return {
    title: '今日老婆', lead: `${today.character.name}\n亲密度 ${bond.affection} · 相遇 ${bond.encounters} 天`, mode: 'row',
    tiles: [{ kind: 'companions', id: today.character.id, name: today.character.name, type: '角色', portrait: true, meta: '今日与你一起收集回响' }],
    footer: `同行进度 ${progress}/3 · ${state.milestoneDay === day ? '奖励已领取' : '完成三类玩法可领星屑 +10、亲密度 +5'}`
  }
}

export function companionCollection(profile) {
  const bonds = Object.entries(profile.companions?.bonds || {})
  return { title: '同行收藏', lead: bonds.length ? `已与 ${bonds.length} 位角色相遇，亲密度会跨天保留。` : '领取今日老婆，开始收集你们的相遇。', mode: 'grid',
    tiles: bonds.map(([id, bond]) => ({ kind: 'companions', id, name: bond.name, type: '角色', meta: `亲密度 ${bond.affection} · 相遇 ${bond.encounters} 天` })) }
}
