import * as entry from './apps/index.js'
import { EchoPostOfficeUpdater } from './apps/updater.js'

export const apps = { EchoPostOfficeUpdater, EchoPostOffice: entry.EchoPostOffice, EchoPostOfficeCallback: entry.EchoPostOfficeCallback }
