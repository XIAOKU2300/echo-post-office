import { registerHooks } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
registerHooks({
  resolve(specifier, context, next) { return specifier === 'oicq' ? { url: 'oicq:preview', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) { return url === 'oicq:preview' ? { format: 'module', shortCircuit: true, source: 'export const segment = { raw: v => v, image: file => ({ type: "image", file }) }' } : next(url, context) },
})
const { renderHtml } = await import('../lib/presentation.js')
const { drawTen } = await import('../lib/rewards.js')
const profile = { pity: { counter: 29 } }
const { createRng } = await import('../lib/rewards.js')
const result = drawTen(profile, '2026-09-27', createRng(2026)).result
result.view.mode = 'row'
result.view.lead = `新卡 ${result.summary.newCount} · 重复 ${result.summary.dupeCount} · 星屑 +${result.summary.stardust} · 出金 ${result.summary.rarityCount.SSR}（必为 UP）`
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await writeFile(path.join(root, 'preview.html'), await renderHtml(result.view), 'utf8')
console.log('回响邮局十连预览：preview.html')
