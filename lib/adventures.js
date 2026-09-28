/** 今日档案、鸣潮派遣、歪不歪：可 JSON 序列化的纯业务规则。 */
export const sampleDossiers = [
  { id: 'd01', name: '檐下邮差', aliases: ['檐下的邮差'], silhouette: '', clues: ['总在雨停以后才出门。', '背包上的邮戳是一座小桥。', '为收件人留下一枚干燥的书签。'] },
  { id: 'd02', name: '云鲸引航员', aliases: ['引航员'], silhouette: '', clues: ['她的航线总画在天空。', '座驾比一整条街还长。', '会在鲸歌响起时点亮舷灯。'] },
  { id: 'd03', name: '晚星修表匠', aliases: ['修表匠'], silhouette: '', clues: ['店门只在黄昏打开。', '墙上的钟偶尔走向昨天。', '修好的怀表会多出一颗小星星。'] },
  { id: 'd04', name: '雾港灯塔守', aliases: ['灯塔守'], silhouette: '', clues: ['每晚都数一遍海上的光。', '把退潮时捡到的纸船晾在窗台。', '信件装在灯油瓶旁的铁盒里。'] },
  { id: 'd05', name: '玻璃花房主', aliases: ['花房主'], silhouette: '', clues: ['白天睡在透明屋顶下面。', '培育的种子会记住来信。', '每朵花开时都会念出寄件人。'] },
  { id: 'd06', name: '月台检票员', aliases: ['检票员'], silhouette: '', clues: ['她记得每一班没有到站的列车。', '口袋里有一叠写着心愿的票根。', '在夜车关门前盖下银色印章。'] },
  { id: 'd07', name: '潮汐抄写员', aliases: ['抄写员'], silhouette: '', clues: ['工作台会随着海水升降。', '把退潮前的话写在贝壳内侧。', '笔尖沾的是一小瓶蓝色海盐。'] },
  { id: 'd08', name: '纸鹤信使', aliases: ['纸鹤'], silhouette: '', clues: ['每天换一对轻薄的翅膀。', '雨天也能把信送到高塔。', '折痕里藏着回响邮局的地址。'] }
]

export const locations = [
  { id: 'jinzhou', name: '今州', material: '今州织锦', title: '城门回信人', souvenirs: [
    { id: 'jinzhou_stamp', name: '旧城邮戳', rarity: '普通' }, { id: 'jinzhou_kite', name: '风筝线轴', rarity: '稀有' }, { id: 'jinzhou_sunset', name: '今州的晚霞', rarity: '珍藏' }],
    sights: ['城门的钟刚敲完，摊主已经把灯挂起来。', '街角有人把风筝线绕成一只小鸟。', '一位旅人问了路，却留下另一封信。', '雨后的石板映着整条街的灯火。', '茶铺老板给远行的人留了半盏热茶。', '巡夜的脚步声从城墙尽头传来。', '旧邮筒的铜盖在夕照里泛着光。', '巷口的猫把信封当成了午睡的垫子。', '木桥下的水载着一张小小的纸船。', '有人将晚霞画在明信片背面。', '远处的铃声提醒商铺准备打烊。', '路边的新芽从石缝里探出头。'] },
  { id: 'blackshore', name: '黑海岸', material: '海潮结晶', title: '潮声收件人', souvenirs: [
    { id: 'shore_shell', name: '潮声贝壳', rarity: '普通' }, { id: 'shore_glass', name: '海蚀玻璃', rarity: '稀有' }, { id: 'shore_chart', name: '黑海岸海图', rarity: '珍藏' }],
    sights: ['海浪把细沙推到脚边，又轻轻带走。', '一只海鸟在暗礁上等风停。', '灯塔的光短暂照亮了远处的水面。', '漂流瓶里只有一句很短的问候。', '夜色里能看见巡航船的微光。', '清晨的礁石比想象中温暖。', '潮水退去后留下弯曲的盐线。', '海风把记事本吹开了新的一页。', '一枚贝壳像是在重复遥远的旋律。', '远行的人在沙滩上画了回家的箭头。', '白色浪花碰到礁石碎成细雨。', '云层散开时海平线多了一点金色。'] },
  { id: 'huanglong', name: '瑝珑', material: '山岚矿晶', title: '山岚寻路者', souvenirs: [
    { id: 'mountain_leaf', name: '山径落叶', rarity: '普通' }, { id: 'mountain_bell', name: '石阶铜铃', rarity: '稀有' }, { id: 'mountain_map', name: '瑝珑云图', rarity: '珍藏' }],
    sights: ['薄雾沿着山路往上走，像一封慢慢打开的信。', '石阶上的铜铃被晨风轻轻敲响。', '路边的旧路标指向一片云。', '林间的光斑在地图上移动。', '有人在山亭里等一场雨。', '高处的小桥刚好能望见远方城镇。', '松针落在肩上却没有发出声响。', '茶香从转角的一间小屋飘来。', '山鸟追着一片落叶飞过峡谷。', '云影把同一座山画成两个样子。', '黄昏的山风吹干了旅行记录。', '下山的路比来时多了一盏灯。'] },
  { id: 'silentzone', name: '无音区', material: '寂静碎片', title: '寂静记录者', souvenirs: [
    { id: 'silent_stone', name: '无声石片', rarity: '普通' }, { id: 'silent_note', name: '静默便签', rarity: '稀有' }, { id: 'silent_frame', name: '无音区来信', rarity: '珍藏' }],
    sights: ['脚步声在入口处忽然变轻。', '几株白草随着看不见的风摇晃。', '远处有一封没写寄件人的信。', '一块石头安静地躺在旧路标旁。', '云层经过时影子像一条河。', '拾起的碎片仍保留着微弱温度。', '远处的光让人想起未说完的话。', '这里的晚霞没有任何回声。', '一本空白册子被留在旧营地。', '安静的水面映出旅行者的背影。', '回程时发现路旁多了一朵花。', '信封封口处有很淡的银色纹路。'] }
]

function dayNumber(day) {
  const time = Date.parse(`${day}T00:00:00+08:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || !Number.isFinite(time) || new Date(time).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) !== day) throw new Error('日期无效')
  return Math.floor(time / 86400000)
}
function timeOf(now) { return now instanceof Date ? now.getTime() : Number(now) }
function roll(rng) { const value = typeof rng === 'function' ? rng() : rng; return Number.isFinite(Number(value)) ? Math.min(0.999999, Math.max(0, Number(value))) : Math.random() }
function pick(list, rng) { return list[Math.floor(roll(rng) * list.length)] }
function current(day, questions) { return questions[((dayNumber(day) % questions.length) + questions.length) % questions.length] }
export function getDailyDossiers(day) { return [current(day, sampleDossiers)] }
export function getDailyLocations(day) { const offset = dayNumber(day) % locations.length; return [0, 1, 2].map(index => locations[(offset + index + locations.length) % locations.length]) }
function dossierState(profile) { return profile.dossier ||= { day: '', attempts: 0, solved: false, lastWon: '', streak: 0, wins: 0, misses: [] } }
function candidateList(question, questions, day) {
  const start = questions.findIndex(item => item.id === question.id)
  const list = [0, 1, 2, 3].map(i => questions[(start + i) % questions.length])
  const offset = Math.floor(dayNumber(day) / questions.length) % list.length
  return list.map((_, i) => list[(i + offset + list.length) % list.length]).map(item => ({ id: item.id, name: item.name }))
}
function dossierResult(profile, day, questions) {
  const state = dossierState(profile), question = current(day, questions)
  const yesterday = new Date(Date.parse(`${day}T00:00:00+08:00`) - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const previous = current(yesterday, questions)
  const revealed = state.solved
  const clues = question.clues.slice(0, Math.min(question.clues.length, state.attempts + 1))
  return { title: '今日档案', day, silhouette: question.silhouette, clues, choices: candidateList(question, questions, day), attempts: state.attempts, remaining: Math.max(0, 3 - state.attempts), solved: state.solved, yesterday: { day: yesterday, name: previous.name }, streak: state.streak, text: `昨日答案：${previous.name}。${revealed ? '今天已答对。' : state.attempts >= 3 ? '今天机会已用完，答案明日公布。' : `剪影：${question.silhouette || '素材待补'}；线索：${clues.join('；')}。剩余 ${3 - state.attempts} 次。`}`, tiles: [{ id: question.id, kind: 'dossiers', name: revealed ? question.name : '神秘角色', hidden: false, symbol: '◐', meta: clues.join(' / ') }] }
}
export function dossierView(group, profile, day, questions = sampleDossiers) {
  try {
    if (!Array.isArray(questions) || questions.length < 4) return { profile, error: '题库至少需要四名角色' }
    const state = dossierState(profile)
    if (state.day !== day) Object.assign(state, { day, attempts: 0, solved: false, misses: [] })
    return { profile, result: dossierResult(profile, day, questions) }
  } catch (error) { return { profile, error: error.message } }
}
export function dossierGuess(group, profile, day, choice, questions = sampleDossiers) {
  const viewed = dossierView(group, profile, day, questions)
  if (viewed.error) return viewed
  const state = dossierState(profile)
  if (state.solved || state.attempts >= 3) return { profile, error: '今日机会已经用完' }
  const question = current(day, questions)
  const input = String(choice || '').trim().toLocaleLowerCase()
  const candidates = candidateList(question, questions, day)
  const selected = candidates.find(item => item.id.toLowerCase() === input || item.name.toLocaleLowerCase() === input)
  if (!input) return { profile, error: '请选择一个角色' }
  const correct = [question.id, question.name, ...(question.aliases || [])].some(item => item.toLocaleLowerCase() === input)
  if (selected && state.misses.includes(selected.id)) return { profile, error: '这个选项已经猜过' }
  state.attempts++
  if (correct) {
    if (state.lastWon !== day) {
      state.streak = state.lastWon && dayNumber(day) - dayNumber(state.lastWon) === 1 ? state.streak + 1 : 1
      state.wins++
      state.lastWon = day
    }
    state.solved = true
  } else if (selected) state.misses.push(selected.id)
  const result = dossierResult(profile, day, questions)
  Object.assign(result, { correct, score: correct ? Math.max(1, 4 - state.attempts) : 0, attempts: state.attempts })
  return { profile, result }
}
export function dossierRank(group, profiles, day) {
  return [...profiles].map(p => ({ id: p.id, name: p.name || p.id, streak: p.dossier?.streak || 0, wins: p.dossier?.wins || 0, score: (p.dossier?.wins || 0) * 10 + (p.dossier?.streak || 0) * 3 })).sort((a, b) => b.streak - a.streak || b.wins - a.wins || String(a.id).localeCompare(String(b.id)))
}
function dispatchState(profile) { return profile.dispatch ||= { lastStart: '', pending: null, album: {}, titles: [], materials: {} } }
export function dispatchStart(profile, day, locationId, rng = Math.random) {
  const place = locations.find(item => item.id === locationId || item.name === locationId)
  if (!place) return { profile, error: '请选择有效地点' }
  try { dayNumber(day) } catch (error) { return { profile, error: error.message } }
  const state = dispatchState(profile)
  if (state.lastStart === day) return { profile, error: '今天已经派遣过了' }
  if (state.pending) return { profile, error: '先领取上一趟的收获' }
  state.pending = { day, locationId: place.id }
  state.lastStart = day
  return { profile, result: { title: '派遣出发', text: `已前往${place.name}，次日来领取收获。`, location: place.name, day } }
}
export function dispatchClaim(profile, day, rng = Math.random) {
  const state = dispatchState(profile), pending = state.pending
  if (!pending) return { profile, error: '没有待领取的派遣' }
  try { if (dayNumber(day) <= dayNumber(pending.day)) return { profile, error: '次日才能领取收获' } } catch (error) { return { profile, error: error.message } }
  const place = locations.find(item => item.id === pending.locationId)
  if (!place) return { profile, error: '派遣地点已失效' }
  const rarityRoll = roll(rng), tier = rarityRoll < 0.72 ? 0 : rarityRoll < 0.96 ? 1 : 2
  const souvenir = place.souvenirs[tier], count = state.album[place.id] ||= { souvenirs: [], journeys: [] }
  if (!count.souvenirs.includes(souvenir.id)) count.souvenirs.push(souvenir.id)
  const start = Math.floor(roll(rng) * place.sights.length)
  const story = [0, 1, 2].map(offset => place.sights[(start + offset) % place.sights.length]).join('')
  count.journeys.push(story)
  state.materials[place.material] = (state.materials[place.material] || 0) + 1 + tier
  state.pending = null
  const completed = place.souvenirs.every(item => count.souvenirs.includes(item.id))
  if (completed && !state.titles.includes(place.title)) state.titles.push(place.title)
  return { profile, result: { title: `${place.name}派遣日志`, text: `${story}\n获得${place.material} ×${1 + tier}、${souvenir.name}（${souvenir.rarity}）。`, story, material: place.material, souvenir, unlockedTitle: completed ? place.title : null, location: place.name, tiles: [{ ...souvenir, kind: 'locations' }] } }
}
export function dispatchAlbum(profile) {
  const state = dispatchState(profile)
  const entries = locations.map(place => ({ id: place.id, name: place.name, kind: 'locations', collected: state.album[place.id]?.souvenirs?.length || 0, total: place.souvenirs.length, journeys: state.album[place.id]?.journeys || [], souvenirs: place.souvenirs.map(item => ({ ...item, owned: !!state.album[place.id]?.souvenirs?.includes(item.id) })) }))
  return { profile, result: { title: '派遣相册', text: entries.map(item => `${item.name} ${item.collected}/${item.total}`).join('；'), entries, titles: state.titles, materials: state.materials, tiles: entries.map(item => ({ id: item.id, kind: 'locations', name: `${item.name} ${item.collected}/${item.total}` })) } }
}
function ended(duel) { return ['finished', 'expired'].includes(duel.status) }
export function duelCreate(duel, initiatorId, stake, now = Date.now()) {
  if (duel.status) return { duel, error: '对战已经创建' }
  if (!initiatorId || !Number.isSafeInteger(Number(stake)) || Number(stake) < 0) return { duel, error: '押注无效' }
  Object.assign(duel, { status: 'open', initiatorId: String(initiatorId), stake: Number(stake), createdAt: timeOf(now), lastAction: timeOf(now), turn: 0, history: [] })
  return { duel, result: { text: '等待对手接受', done: false } }
}
export function duelAccept(duel, opponentId, now = Date.now()) {
  if (ended(duel)) return { duel, error: '对战已结束' }
  if (duel.status !== 'open') return { duel, error: '对战无法接受' }
  if (String(opponentId) === duel.initiatorId) return { duel, error: '不能接受自己的约战' }
  const expired = duelExpire(duel, now)
  if (duel.status === 'expired') return { duel, error: '约战已超时', result: expired.result }
  Object.assign(duel, { status: 'active', opponentId: String(opponentId), nextPlayerId: duel.initiatorId, lastAction: timeOf(now) })
  return { duel, result: { text: '对战开始，发起方先抽', done: false, nextPlayerId: duel.nextPlayerId } }
}
export function duelPull(duel, userId, rng = Math.random, now = Date.now()) {
  if (ended(duel)) return { duel, error: '对战已结束', result: { done: true, winnerId: duel.winnerId || null } }
  if (duel.status !== 'active') return { duel, error: '对战尚未开始' }
  const expired = duelExpire(duel, now)
  if (duel.status === 'expired') return { duel, error: '本轮已超时', result: expired.result }
  if (String(userId) !== duel.nextPlayerId) return { duel, error: '还没轮到你抽卡' }
  const n = duel.turn + 1, chance = Math.min(1, 0.05 + 0.08 * (n - 1))
  const crooked = n >= 12 || roll(rng) < chance
  duel.turn = n
  duel.lastAction = timeOf(now)
  duel.history.push({ turn: n, userId: String(userId), crooked, chance })
  if (crooked) {
    duel.status = 'finished'
    duel.loserId = String(userId)
    duel.winnerId = duel.initiatorId === duel.loserId ? duel.opponentId : duel.initiatorId
  } else duel.nextPlayerId = duel.initiatorId === String(userId) ? duel.opponentId : duel.initiatorId
  return { duel, result: { done: crooked, turn: n, chance, crooked, winnerId: duel.winnerId || null, loserId: duel.loserId || null, nextPlayerId: crooked ? null : duel.nextPlayerId, text: crooked ? `第${n}抽歪了，${duel.winnerId}获胜。` : `第${n}抽没有歪，轮到${duel.nextPlayerId}。` } }
}
export function duelExpire(duel, now = Date.now()) {
  if (ended(duel)) return { duel, result: { done: true, winnerId: duel.winnerId || null, text: '对战已结束' } }
  if (!['open', 'active'].includes(duel.status)) return { duel, error: '没有待结算的对战' }
  if (timeOf(now) - duel.lastAction < 60000) return { duel, result: { done: false, text: '对战仍在进行' } }
  const wasActive = duel.status === 'active'
  duel.status = 'expired'
  duel.loserId = wasActive ? duel.nextPlayerId : null
  duel.winnerId = wasActive ? (duel.initiatorId === duel.loserId ? duel.opponentId : duel.initiatorId) : null
  return { duel, result: { done: true, winnerId: duel.winnerId, loserId: duel.loserId, text: wasActive ? `${duel.loserId}超时，${duel.winnerId}获胜。` : '无人接受，约战取消并退还押注。' } }
}
