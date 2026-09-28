import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const exec = promisify(execFile)
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{40}$/

export function githubRepository(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url.trim())
  if (!match || match[2] === '.' || match[2] === '..') throw new Error('更新源必须是 GitHub HTTPS 或 SSH 仓库，地址中不能包含凭据。')
  return `${match[1]}/${match[2]}`
}

export function validateChanges(text) {
  const parts = text.split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2) throw new Error('无法解析更新文件清单。')
  const files = []
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i], file = parts[i + 1]
    if (!['A', 'M'].includes(status)) throw new Error('此版本包含删除、重命名或类型变更，请手动审核更新。')
    if (!file || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f]/.test(file)) throw new Error('更新包含不合法的路径。')
    if (!/^(?:(?:apps|lib|tests|scripts|docs)\/.+|\.github\/workflows\/[\w.-]+\.ya?ml|index\.js|package(?:-lock)?\.json|README\.md|UPDATE\.md|LICENSE(?:\.txt)?|\.gitignore)$/.test(file) || /(?:^|\/)\.env(?:\.|$)/.test(file)) {
      throw new Error('更新涉及素材、数据、配置或未允许的文件，请手动审核。')
    }
    files.push({ status, path: file })
  }
  if (files.length > 100) throw new Error('更新超过 100 个文件，请手动审核。')
  return files
}

export function createUpdater({ root = defaultRoot, run, makeBackupDirectory = mkdir } = {}) {
  let busy = false
  const git = run || (async args => {
    try {
      const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
      return stdout
    } catch {
      // Git errors may contain credential-bearing URLs. Never forward stderr.
      throw new Error('Git 操作失败，请在服务器检查网络、仓库权限及 Git 状态；未执行强制覆盖。')
    }
  })
  async function inspect() {
    const top = (await git(['rev-parse', '--show-toplevel'])).trim()
    if ((run ? path.resolve(top) : await realpath(top)) !== (run ? path.resolve(root) : await realpath(root))) throw new Error('必须将本插件单独 git clone，不能更新 Yunzai 主仓库。')
    if ((await git(['status', '--porcelain', '--untracked-files=all'])).trim()) throw new Error('插件目录存在本地改动或未跟踪文件，请先备份并处理后再更新。')
    const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error('当前分支不支持更新。')
    const url = (await git(['remote', 'get-url', 'origin'])).trim()
    const repository = githubRepository(url)
    const before = (await git(['rev-parse', 'HEAD'])).trim()
    if (!SHA.test(before)) throw new Error('无法识别当前版本。')
    await git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${branch}`])
    const target = (await git(['rev-parse', 'FETCH_HEAD'])).trim()
    if (!SHA.test(target)) throw new Error('无法识别远程版本。')
    if (before === target) return { before, target, repository, files: [], current: true }
    try { await git(['merge-base', '--is-ancestor', before, target]) } catch { throw new Error('本地与远程历史已分叉，已停止更新，请手动处理。') }
    const files = validateChanges(await git(['diff', '--no-renames', '--name-status', '-z', before, target]))
    // Refuse symlinks, submodules and executable files from the update.
    for (const file of files) {
      const entry = await git(['ls-tree', target, '--', file.path])
      if (!entry.startsWith('100644 blob ')) throw new Error('更新包含符号链接、子模块或可执行文件，请手动审核。')
    }
    return { before, target, repository, files, current: false }
  }
  async function exclusive(fn) {
    if (busy) throw new Error('已有更新操作正在进行，请稍后再试。')
    busy = true
    try { return await fn() } finally { busy = false }
  }
  return {
    root,
    check: () => exclusive(inspect),
    apply: (expectedBefore, expectedTarget) => exclusive(async () => {
      if (!SHA.test(expectedBefore) || !SHA.test(expectedTarget)) throw new Error('确认版本无效。')
      const plan = await inspect()
      if (plan.before !== expectedBefore || plan.target !== expectedTarget) throw new Error('版本已变化，请重新发送 #回响更新 确认文件清单。')
      if (plan.current) return plan
      const backupRoot = path.join(root, '.update-backups')
      await makeBackupDirectory(backupRoot, { recursive: true })
      const backup = path.join(backupRoot, `${Date.now()}-${randomUUID()}.bundle`)
      await git(['bundle', 'create', backup, '--all'])
      try {
        await git(['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', expectedTarget])
      } catch { throw new Error(`更新未完成，未强制回退。备份保存在 ${backup}，请检查服务器仓库状态。`) }
      return { ...plan, backup, updated: true }
    })
  }
}
