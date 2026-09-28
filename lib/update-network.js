/** Proxy applies to updater Git commands only; never writes global Git configuration. */
export function updateNetworkArgs(proxy = 'http://192.168.0.103:7890') {
  if (proxy === '') return []
  let url
  try { url = new URL(proxy) } catch { throw new Error('更新代理地址格式无效。') }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('更新代理必须是无账号密码的 HTTP/HTTPS/SOCKS 地址。')
  return ['-c', `http.proxy=${proxy}`]
}

export function describeGitFailure(args, error) {
  const stage = ({ 'rev-parse': '检查仓库', status: '检查本地改动', 'symbolic-ref': '读取分支', remote: '读取远程地址', fetch: '连接远程仓库', 'ls-tree': '检查更新文件', bundle: '创建备份', merge: '合并更新' })[args[0]] || '执行 Git'
  const detail = String(error?.stderr || '')
  let reason = '请检查 Git 状态及目录权限'
  if (error?.code === 'ENOENT') reason = '找不到 Git，请先安装 Git'
  else if (error?.killed || error?.code === 'ETIMEDOUT') reason = '操作超时，请检查网络和更新代理'
  else if (/dubious ownership|safe\.directory/i.test(detail)) reason = 'Git 拒绝访问此目录，请检查目录所有者是否与运行云崽的账号一致'
  else if (/not a git repository/i.test(detail)) reason = '当前安装不是 Git 仓库，请使用 git clone 安装'
  else if (/could not resolve|failed to connect|connection refused|couldn.t connect|connection timed out|proxy/i.test(detail)) reason = '无法连接 GitHub 或代理，请检查 103:7890 是否可达'
  else if (/authentication failed|could not read Username|permission denied \(publickey\)/i.test(detail)) reason = '仓库认证失败，请检查 origin 地址及访问权限'
  else if (/couldn.t find remote ref/i.test(detail)) reason = '远程不存在当前同名分支，请检查分支配置'
  else if (/permission denied|read-only file system/i.test(detail)) reason = '云崽进程没有插件目录的写入权限'
  return `Git 操作失败（${stage}）：${reason}。未执行强制覆盖。`
}
