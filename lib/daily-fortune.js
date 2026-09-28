import { createHash } from 'node:crypto'

const wishes = [
  '愿你今天付出的认真，都能收到一点温柔的回应。',
  '愿忙碌里也有片刻轻松，想做的事恰好有一个好开头。',
  '愿今天的小小勇气，换来一个值得开心的结果。',
  '愿你遇到合拍的人，也留一点时间给自己的喜欢。',
  '愿那些还没说出口的期待，慢慢长成好消息。',
  '今天不必事事完美，愿你做完想做的，也记得好好休息。',
  '愿平常的一天，也藏着一个让你嘴角上扬的小惊喜。',
  '愿你走得从容一点，喜欢的风景总能多看一眼。'
]
const moments = [
  '把今天的第一份好运，留给这次相遇。',
  '云海送来一封新信，收件人恰好是你。',
  '今天的旅途，有了一个值得分享风景的人。',
  '新的回响已经抵达，今天也值得好好期待。'
]
const suggestions = ['宜开始一件惦记的小事', '宜和朋友分享好消息', '宜出发，也宜慢慢看风景', '宜给自己的努力一点奖励', '宜完成一件小事，再安心休息', '宜试一次，也允许自己慢一点']
const tones = {
  长离: '把心意留在从容里，把好消息留给今天。',
  今汐: '愿心有所向，脚下的路也渐渐明亮。',
  守岸人: '愿今天的潮声，替你带走一点疲惫。',
  秧秧: '风会带来新的故事，也愿它带来你的好消息。',
  椿: '愿今天有一点心动，也有一点属于你的惊喜。',
  折枝: '把今天值得喜欢的瞬间，慢慢画进回忆里。',
  吟霖: '愿你看清自己的心意，遇事也多一点笃定。',
  珂莱塔: '把喜欢的事认真对待，今天也会有自己的光彩。'
}

/** Entertainment-only fortune, stable for the same person/date; never changes gacha odds. */
export function dailyFortune(userId, day, character) {
  const bytes = createHash('sha256').update(`echo-fortune-v1:${userId}:${day}`).digest()
  const score = 60 + bytes.readUInt16BE(0) % 41
  return {
    score, label: score >= 92 ? '大吉' : score >= 80 ? '顺心' : score >= 70 ? '小有惊喜' : '平稳向前',
    allowance: 5 + bytes[2] % 16,
    greeting: `今天与你相遇的是${character.name}。`,
    moment: moments[bytes[3] % moments.length],
    wish: tones[character.name] || wishes[bytes[4] % wishes.length],
    suggestion: suggestions[bytes[5] % suggestions.length]
  }
}

export function grantDailyFortune(profile, today, userId) {
  today.fortune ||= dailyFortune(userId, today.day, today.character)
  if (today.luckyGranted) return false
  profile.stardust = Math.max(0, Number(profile.stardust) || 0) + today.fortune.allowance
  today.luckyGranted = true
  return true
}
