import test from 'node:test'
import assert from 'node:assert/strict'
import * as a from '../lib/adventures.js'

const day = '2026-09-27', next = '2026-09-28'
test('每日同题、线索按个人解锁且答案次日公布', () => {
  const p = {}, other = {}, group = {}
  const first = a.dossierView(group, p, day).result
  assert.equal(first.choices.length, 4)
  assert.equal(first.clues.length, 1)
  assert.equal(first.text.includes(a.getDailyDossiers(day)[0].name), false)
  assert.equal(a.getDailyDossiers(day)[0].id, a.getDailyDossiers(day)[0].id)
  assert.notEqual(a.getDailyDossiers(day)[0].id, a.getDailyDossiers(next)[0].id)
  const wrong = first.choices.find(x => x.id !== a.getDailyDossiers(day)[0].id)
  assert.equal(a.dossierGuess(group, p, day, wrong.id).result.correct, false)
  assert.equal(a.dossierView(group, p, day).result.clues.length, 2)
  assert.equal(a.dossierView(group, other, day).result.clues.length, 1)
  assert.equal(a.dossierGuess(group, p, day, wrong.id).error, '这个选项已经猜过')
  assert.equal(a.dossierGuess(group, p, day, a.getDailyDossiers(day)[0].id).result.correct, true)
  assert.equal(a.dossierGuess(group, p, day, a.getDailyDossiers(day)[0].id).error, '今日机会已经用完')
  assert.equal(a.dossierView(group, p, next).result.yesterday.name, a.getDailyDossiers(day)[0].name)
  a.dossierGuess(group, p, next, a.getDailyDossiers(next)[0].id)
  assert.equal(p.dossier.streak, 2)
  assert.equal(a.dossierRank(group, [{ id: 'p', ...p }, { id: 'other', ...other }], next)[0].id, 'p')
})

test('派遣每天一次，次日领取本地点收获，重复领取不增加材料', () => {
  const p = {}
  assert.equal(a.dispatchStart(p, day, 'jinzhou').error, undefined)
  assert.match(a.dispatchStart(p, day, 'jinzhou').error, /已经派遣/)
  assert.match(a.dispatchClaim(p, day).error, /次日/)
  const claimed = a.dispatchClaim(p, next, () => 0.99)
  assert.equal(claimed.result.souvenir.id, 'jinzhou_sunset')
  assert.equal(claimed.result.story.split('。').length >= 3, true)
  assert.equal(a.dispatchClaim(p, next).error, '没有待领取的派遣')
  assert.equal(p.dispatch.materials['今州织锦'], 3)
  assert.equal(a.dispatchAlbum(p).result.entries[0].collected, 1)
  assert.equal(a.dispatchStart(p, next, 'blackshore').error, undefined)
  assert.match(a.dispatchStart(p, next, 'huanglong').error, /已经派遣/)
  assert.doesNotThrow(() => JSON.stringify(p))
})

test('两人轮流单抽，第十二抽强制歪，终态幂等', () => {
  const d = { id: 'duel' }
  a.duelCreate(d, 'a', 20, 1000)
  assert.equal(a.duelAccept(d, 'a', 1001).error, '不能接受自己的约战')
  a.duelAccept(d, 'b', 1001)
  assert.match(a.duelPull(d, 'b', () => 0.99, 1002).error, /还没轮到/)
  for (let n = 1; n <= 12; n++) {
    const id = n % 2 ? 'a' : 'b'
    const result = a.duelPull(d, id, () => 0.99, 1002 + n).result
    assert.equal(result.turn, n)
    assert.equal(result.done, n === 12)
  }
  assert.equal(d.winnerId, 'a')
  assert.equal(d.loserId, 'b')
  assert.equal(d.history.length, 12)
  assert.match(a.duelPull(d, 'a', () => 0, 1100).error, /已结束/)
  assert.equal(a.duelExpire(d, 90000).result.winnerId, 'a')
  assert.equal(d.history.length, 12)
})

test('六十秒无操作自动裁定，等待中取消与进行中判负', () => {
  const pending = { id: 'one' }, playing = { id: 'two' }
  a.duelCreate(pending, 'a', 20, 1000)
  assert.equal(a.duelExpire(pending, 61000).result.winnerId, null)
  assert.equal(a.duelExpire(pending, 70000).result.winnerId, null)
  a.duelCreate(playing, 'a', 20, 1000)
  a.duelAccept(playing, 'b', 1001)
  assert.equal(a.duelExpire(playing, 61001).result.winnerId, 'b')
  assert.equal(a.duelExpire(playing, 70000).result.winnerId, 'b')
})
