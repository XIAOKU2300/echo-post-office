import test from 'node:test'
import assert from 'node:assert/strict'
import { summaryHtml, progressHtml } from '../lib/panel-ui.js'
test('奖励摘要突出数量，普通长文本保持完整，动态文字转义', () => {
  assert.match(summaryHtml('新卡 3 · 重复 7 · 星屑 +25'), /summary-strip/)
  assert.match(summaryHtml('新卡 3 · 重复 7 · 星屑 +25'), /<strong>\+25<\/strong>/)
  assert.match(summaryHtml('一段说明\n下一段<script>'), /下一段&lt;script&gt;/)
})
test('进度条限定范围，不对普通文本猜测进度', () => {
  assert.match(progressHtml('保底进度 9/30 · 星屑 50'), /width:30%/)
  assert.match(progressHtml('同行进度 4/3'), /width:100%/)
  assert.equal(progressHtml('保底进度 1/0'), '')
  assert.equal(progressHtml('今天很好'), '')
})
