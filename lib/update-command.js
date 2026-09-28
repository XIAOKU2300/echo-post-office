import path from 'node:path'

export const updateCommandPattern = '^\\s*#(?:回响更新|更新回响|回响确认更新(?:\\s+[a-f0-9]{40})?|确认更新回响(?:\\s+[a-f0-9]{40})?)\\s*$'

export function parseUpdateCommand(value) {
  const text = String(value || '').trim()
  if (/^#(?:回响更新|更新回响)$/.test(text)) return { action: 'check' }
  const match = /^#(?:回响确认更新|确认更新回响)(?:\s+([a-f0-9]{40}))?$/.exec(text)
  return match ? { action: 'apply', target: match[1] || '' } : null
}

function chunks(text, limit = 800) {
  const result = []
  let current = ''
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > limit) { result.push(current); current = '' }
    current += `${current ? '\n' : ''}${line}`
  }
  if (current) result.push(current)
  return result
}

export function updateHandler(service, confirmations = new Map(), now = Date.now) {
  return async e => {
    const command = parseUpdateCommand(e?.msg || e?.raw_message)
    if (!command) return false
    async function reply(text, active = false) {
      const senders = active
        ? [e?.group?.sendMsg?.bind(e.group), e?.reply?.bind(e)]
        : [e?.reply?.bind(e), e?.group?.sendMsg?.bind(e.group)]
      for (const send of senders) {
        if (!send) continue
        try {
          const receipt = await send(text)
          if (receipt === false || receipt === null || (receipt?.error?.length && !receipt?.message_id?.length)) continue
          return true
        } catch { /* Do not expose transport payloads or credentials. */ }
      }
      globalThis.logger?.warn?.('[回响邮局] 更新提示发送失败，请检查机器人发送权限。')
      return false
    }
    if (e.isMaster !== true) { await reply('只有机器人主人可以更新回响邮局。请先在云崽配置中设置当前账号为主人。'); return true }
    const owner = String(e.user_id || '')
    if (!owner) { await reply('无法确认主人身份，请重试。'); return true }
    for (const [key, value] of confirmations) if (value.expires < now()) confirmations.delete(key)
    try {
      if (command.action === 'check') {
        await reply('正在检查回响邮局更新，请稍候。网络检查最多等待约 30 秒；不会直接覆盖文件。')
        const plan = await service.check()
        if (plan.current) { confirmations.delete(owner); await reply('回响邮局已经是最新版本。今日老婆命令：#回响今日老婆'); return true }
        const files = plan.files.map(file => `${file.status === 'A' ? '新增' : '覆盖'} ${path.join(service.root, file.path)}`).join('\n')
        const report = `发现新版本：${plan.before.slice(0, 8)} → ${plan.target.slice(0, 8)}\n来源：${plan.repository}\n操作：更新代码（新增 / 覆盖）\n目标：${service.root}\n影响：${plan.files.length} 个文件\n${files}\n理由：安装远程新版本。\n安全检查：工作区干净；执行前创建 Git bundle 备份；本地数据和自定义素材不参与更新。`
        let delivered = true
        for (const part of chunks(report)) if (!await reply(part, true)) { delivered = false; break }
        if (!delivered) { confirmations.delete(owner); await reply('更新清单未能完整送达，已取消本次确认。请稍后重试。'); return true }
        confirmations.set(owner, { ...plan, expires: now() + 600000 })
        if (!await reply(`确认无误后，十分钟内发送：\n#回响确认更新 ${plan.target}\n更新后需重启云崽生效。`, true)) confirmations.delete(owner)
      } else {
        const plan = confirmations.get(owner)
        if (!plan || !command.target || command.target !== plan.target) { await reply('确认无效或已过期，请先发送 #回响更新 或 #更新回响。'); return true }
        confirmations.delete(owner)
        await reply('正在备份并更新回响邮局，请稍候。')
        const result = await service.apply(plan.before, plan.target)
        await reply(result.updated ? `回响邮局已更新至 ${result.target.slice(0, 8)}。\n备份：${result.backup}\n请重启云崽，然后发送 #回响今日老婆。` : '回响邮局已经是最新版本。')
      }
    } catch (error) {
      await reply(`回响邮局更新停止：${error.message}`)
    }
    return true
  }
}
