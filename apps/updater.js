import { EchoPostOffice } from './index.js'
import { createUpdater } from '../lib/updater.js'
import { updateHandler, parseUpdateCommand, updateCommandPattern } from '../lib/update-command.js'

const Plugin = Object.getPrototypeOf(EchoPostOffice)
const updater = createUpdater()
const pending = new Map()
export function createUpdateHandler(service = updater, confirmations = pending, now = Date.now) {
  return updateHandler(service, confirmations, now)
}
const handleUpdate = createUpdateHandler()

export class EchoPostOfficeUpdater extends Plugin {
  constructor() {
    super({ name: '回响邮局·更新', dsc: '主人检查并确认更新', event: 'message', priority: -100,
      rule: [{ reg: updateCommandPattern, fnc: 'update' }] })
  }
  async accept(e = this.e) {
    if (!e || e.__echoUpdateHandled || !parseUpdateCommand(e.msg || e.raw_message)) return false
    e.__echoUpdateHandled = true
    return await handleUpdate(e) ? 'return' : false
  }
  async update() {
    if (!this.e || this.e.__echoUpdateHandled) return false
    this.e.__echoUpdateHandled = true
    return handleUpdate(this.e)
  }
}
