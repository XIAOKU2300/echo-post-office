import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateRoster, meetCompanion, recordCompanionActivity, claimCompanionReward, companionPanel, companionCollection, loadCompanionRoster, companionAvatar } from '../lib/companions.js'
const roster = [{ id: 'test_a', name: '角色甲' }, { id: 'test_b', name: '角色乙' }]
const day = '2026-09-28'

test('每日固定，跨群重复领取及名单调整不会重抽或增加亲密度', () => {
  const profile = {}, first = meetCompanion(profile, 'u1', day, roster)
  assert.equal(meetCompanion(profile, 'u1', day, roster.slice(1)).character.id, first.character.id)
  assert.equal(meetCompanion(profile, 'u1', day, []).repeated, true)
  assert.equal(profile.companions.bonds[first.character.id].encounters, 1)
  const separate = {}
  assert.equal(meetCompanion(separate, 'u1', day, [...roster].reverse()).character.id, first.character.id)
  meetCompanion(profile, 'u1', '2026-09-29', roster)
  assert.equal(Object.values(profile.companions.bonds).reduce((n, b) => n + b.encounters, 0), 2)
})

test('素材空缺或不合法时不创建记录，不发放奖励', () => {
  const profile = {}
  assert.ok(meetCompanion(profile, 'u1', day, []).error)
  assert.equal(profile.companions, undefined)
  assert.deepEqual(validateRoster([{ id: '../file', name: '错' }, { id: '__proto__', name: '错' }]), [])
  assert.equal(recordCompanionActivity(profile, day, 'drawTen', {}), '')
})

test('七类玩法每天各计一次，答错不计，三类奖励仅发一次', () => {
  const profile = { stardust: 7 }
  meetCompanion(profile, 'u1', day, roster)
  assert.ok(claimCompanionReward(profile, day).error)
  assert.equal(recordCompanionActivity(profile, day, 'dossierGuess', { correct: false }), '')
  for (const action of ['drawTen', 'scratch', 'bag']) {
    assert.ok(recordCompanionActivity(profile, day, action, {}))
    assert.equal(recordCompanionActivity(profile, day, action, {}), '')
  }
  assert.ok(claimCompanionReward(profile, day).text)
  assert.equal(profile.stardust, 17)
  assert.ok(claimCompanionReward(profile, day).error)
  assert.equal(profile.stardust, 17)
  assert.equal(recordCompanionActivity(profile, '2026-09-29', 'redeem', {}), '')
  assert.equal(companionPanel(profile, day).tiles[0].portrait, true)
  assert.equal(companionCollection(profile).tiles.length, 1)
  assert.doesNotThrow(() => JSON.stringify(profile))
})

test('内置女角色名单与头像立绘匹配，已知男性不进入老婆池', async () => {
  const characters = await loadCompanionRoster()
  assert.ok(characters.length >= 25)
  const men = ['忌炎', '秋水', '莫特斐', '凌阳', '渊武', '卡卡罗', '相里要', '漂泊者·男', '布兰特']
  assert.equal(characters.some(c => men.includes(c.name)), false)
  for (const c of characters) {
    for (const suffix of [`${c.id}.webp`, `artwork/${c.id}.webp`]) {
      const bytes = await readFile(new URL(`../lib/character-assets/${suffix}`, import.meta.url))
      assert.equal(bytes.subarray(8, 12).toString(), 'WEBP')
    }
  }
  assert.match(await companionAvatar(characters[0].id, true), /^data:image\/webp;base64,/)
})
