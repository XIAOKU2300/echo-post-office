import path from 'node:path'
import { EchoPostOffice } from './index.js'
import { createUpdater } from '../lib/updater.js'

const Plugin = Object.getPrototypeOf(EchoPostOffice)
const updater = createUpdater()
const pending = new Map()
const TTL = 10 * 60 * 1000

export function createUpdateHandler(service = updater, confirmations = pending, now = Date.now) {
  return async function handle(e) {
    const input = String(e?.msg || '').trim()
    const match = /^#回响(更新|确认更新(?:\s+([a-f0-9]{40}))?)$/.exec(input)
    if (!match) return false
    if (e.isMaster !== true) {
      await e.reply('只有机器人主人可以更新回响邮局。')
      return true
    }
    const owner = String(e.user_id || '')
    if (!owner) { await e.reply('无法确认主人身份，请重试。'); return true }
    for (const [key, value] of confirmations) if (value.expires < now()) confirmations.delete(key)
    try {
      if (match[1] === '更新') {
        const plan = await service.check()
        if (plan.current) { confirmations.delete(owner); await e.reply('回响邮局已经是最新版本。'); return true }
        confirmations.set(owner, { ...plan, expires: now() + TTL })
        const files = plan.files.map(file => `${file.status === 'A' ? '新增' : '覆盖'} ${path.join(service.root, file.path)}`).join('\n')
        await e.reply(`发现新版本：${plan.before.slice(0, 8)} → ${plan.target.slice(0, 8)}\n来源：${plan.repository}\n操作：更新代码（新增 / 覆盖）\n目标：${service.root}\n影响：${plan.files.length} 个文件\n${files}\n理由：安装远程新版本。\n安全检查：工作区干净；执行前创建 Git bundle 备份；数据和素材不参与更新。\n十分钟内发送以下命令确认：\n#回响确认更新 ${plan.target}\n更新后需重启 Yunzai 生效。`)
      } else {
        const plan = confirmations.get(owner)
        if (!plan || !match[2] || plan.target !== match[2]) { await e.reply('确认无效或已过期，请先发送 #回响更新。'); return true }
        confirmations.delete(owner)
        const result = await service.apply(plan.before, plan.target)
        await e.reply(result.updated ? `回响邮局已更新至 ${result.target.slice(0, 8)}。\n备份：${result.backup}\n请重启 Yunzai 使新代码生效。` : '回响邮局已经是最新版本。')
      }
    } catch (error) {
      await e.reply(`回响邮局更新停止：${error.message}`)
    }
    return true
  }
}

const handleUpdate = createUpdateHandler()
export class EchoPostOfficeUpdater extends Plugin {
  constructor() {
    super({ name: '回响邮局·更新', dsc: '主人检查并确认更新', event: 'message', priority: 0,
      rule: [{ reg: '^#回响(?:更新|确认更新(?:\\s+[a-f0-9]{40})?)$', fnc: 'update' }] })
  }
  async update() { return handleUpdate(this.e) }
}
