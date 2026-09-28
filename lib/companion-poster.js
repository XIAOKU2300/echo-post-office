const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function companionPoster({ tile, lead, footer }, figure) {
  const data = tile.poster, fortune = data.fortune
  const progress = Math.max(0, Math.min(3, Number(data.progress) || 0))
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:#eaf0f4;color:#233e52;font:22px/1.7 'Noto Sans CJK SC','Microsoft YaHei',sans-serif}
.sheet{width:1280px;padding:36px 44px 32px;position:relative;background:#edf3f6;border-top:8px solid #4a7088}
.masthead{display:flex;justify-content:space-between;align-items:center;font-size:20px;color:#516f82}.brand{font-weight:700}.date{font-size:18px}
.scene{position:relative;display:grid;grid-template-columns:650px 1fr;gap:30px;min-height:690px;margin-top:24px;align-items:center}
.artwork{height:680px;position:relative;border-radius:180px 180px 10px 10px;background:radial-gradient(ellipse at 45% 65%,#d9e5ed 0,#e6eff4 48%,#f8fbfd 78%);overflow:hidden;border:1px solid #d0dfe8}
.artwork:before{content:'';position:absolute;width:500px;height:500px;border:1px solid #bacfdd;border-radius:50%;left:74px;top:85px}.artwork img,.artwork svg{position:relative;width:100%;height:100%;object-fit:contain;display:block}
.story{position:relative;padding:14px 8px 14px 0;overflow-wrap:anywhere}.kicker{font-size:21px;color:#628095;margin-bottom:12px}.name{font:700 62px/1.3 'Noto Serif CJK SC',serif;margin:0 0 18px;color:#26475e}.greeting{font-size:25px;line-height:1.65;margin:0 0 12px}.moment{font-size:20px;color:#617a8c;margin:0 0 28px}
.wish{font:500 27px/1.8 'Noto Serif CJK SC',serif;margin:0;padding:22px 0;border-top:1px solid #b9cdd9;border-bottom:1px solid #b9cdd9}.bond{display:flex;gap:26px;margin-top:26px;font-size:19px;color:#5d7687}.bond strong{display:block;color:#294b61;font-size:29px;font-weight:600}
.fortune{display:grid;grid-template-columns:1.05fr 1.5fr 1fr;background:#fff;border:1px solid #cbdce6;border-radius:10px;margin-top:28px;overflow:hidden}.fortune>div{padding:22px 26px}.fortune>div+div{border-left:1px solid #e0e9ef}.label{font-size:18px;color:#607e91}.value{font-size:32px;font-weight:700;color:#315b75}.value small{font-size:18px;font-weight:400;margin-left:12px}.suggestion{font-size:21px;line-height:1.8;margin-top:5px}.allowance{color:#9c773a}
.journey{display:flex;align-items:center;gap:20px;margin-top:26px;font-size:20px;color:#4d6c80}.track{height:7px;flex:1;background:#d7e3eb;border-radius:4px;overflow:hidden}.fill{height:100%;background:#6c96af;width:${progress / 3 * 100}%}.note{margin-top:18px;font-size:18px;color:#627c8c;overflow-wrap:anywhere;white-space:pre-wrap}.extra{margin:14px 0 0;font-size:21px;color:#496a80}.disclaimer{font-size:16px;color:#7b909d;margin-top:10px}
</style><body><div class="sheet"><div class="masthead"><span class="brand">回响邮局 · 今日老婆</span><span class="date">${escape(data.day)}</span></div>
<div class="scene"><div class="artwork">${figure}</div><div class="story"><div class="kicker">今日与你同行</div><h1 class="name">${escape(tile.name)}</h1><p class="greeting">${escape(fortune.greeting)}</p><p class="moment">${escape(fortune.moment)}</p><p class="wish">${escape(fortune.wish)}</p><div class="bond"><span>亲密度<strong>${escape(data.affection)}</strong></span><span>相遇天数<strong>${escape(data.encounters)}</strong></span></div></div></div>
<div class="fortune"><div><div class="label">今日运势</div><div class="value">${escape(fortune.label)}<small>${escape(fortune.score)} 分</small></div></div><div><div class="label">给今天的小建议</div><div class="suggestion">${escape(fortune.suggestion)}</div></div><div><div class="label">今日幸运星屑</div><div class="value allowance">+${escape(fortune.allowance)}<small>${data.luckyGranted ? '已到账' : '待领取'}</small></div></div></div>
<div class="journey"><span>同行进度 ${progress}/3</span><div class="track"><div class="fill"></div></div><span>${data.claimed ? '同行奖励已领取' : '完成三类玩法领取奖励'}</span></div>
${lead && !String(lead).startsWith(fortune.greeting) ? `<div class="extra">${escape(String(lead).split('\n')[0])}</div>` : ''}
<div class="note">${escape(footer)}</div><div class="disclaimer">运势仅供娱乐，不影响抽卡概率。每日角色、签语与幸运奖励当天固定。</div></div></body></html>`
}
