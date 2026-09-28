# 回响邮局 · echo-post-office

TRSS-Yunzai 的 QQ 群小游戏插件。主菜单用简短 Markdown 和按钮；有卡面或结果的玩法优先渲染为一张图并附按钮，图片失败才退回 Markdown。

### 更新现有安装

将新版 `apps/index.js` 与 `lib/presentation.js` 放到服务器插件目录的同名位置并重启 Yunzai。数据保存在 Redis 或 `data/echo-post-office/`，更新代码不需要清空数据。命令从 `#回响` 进入；点击「玩法说明」可以逐项查看怎么玩。

针对 QQBot 的 `40034024`，公开按钮现在有回调标记；旧版只有 `#回响` 的返回按钮也会主动群发，不再使用按钮事件的失效 `msg_id`。新面板成功发出才撤回旧面板。若官方适配器没有主动发群消息的权限，需在该 Bot 环境确认权限配置。

---

## 1. 安装

```
<TRSS-Yunzai>/
  plugins/
    echo-post-office/          ← 把整个目录放进来
      index.js                 ← 根入口，导出主命令与按钮回调类
      apps/index.js            ← 命令、按钮、面板与定时结算
      lib/store.js             ← 状态底座（事务 / Redis 优先、JSON 兜底）
      lib/presentation.js      ← 渲染（markdown / keyboard / 图片）
      lib/rewards.js           ← 纯逻辑：十连 / 刮刮乐 / 福袋 / 图鉴 / 佩戴 / 兑换
      lib/adventures.js        ← 纯逻辑：档案 / 派遣 / 对战
      assets/{cards,dossiers,locations}/   ← 卡面素材（可选，缺省用占位符号）
      tests/{foundation,adventures,integration,markdown}.test.js
      package.json
```

- 将整个目录放到 `plugins/echo-post-office/`；根 `index.js` 导出应用类，`apps/index.js` 加载 Yunzai 基类并处理消息。
- 依赖：`oicq`（Yunzai 提供）与 `puppeteer`（Yunzai 自带；缺失时自动降级为文字面板）。
- 无 `node_modules` 依赖，`package.json` 只声明 `"type": "module"`（ESM）与测试/检查脚本。

自检：群里发送 **`#回响自检`**，输出适配器、渲染模块、两个逻辑模块的装载情况、状态后端、星屑字段、面板与对战数量、冷却与超时参数。

---

## 2. 命令一览

所有命令都需要 `#回响` 前缀（也接受 `回响`、`#echo draw` 这类写法）。按钮点击等价于发送对应命令。

| 玩法 | 命令 | 说明 |
| --- | --- | --- |
| 菜单 | `#回响`、`#回响菜单` | 显示星屑、每日剩余与玩法入口 |
| 玩法说明 | `#回响玩法`、`#回响帮助` | 点七个玩法按钮查看规则与奖励 |
| 自检 | `#回响自检` | 依赖 / 参数 / 状态诊断 |
| 十连 | `#回响十连`（`抽卡`、`十抽`） | 每天 2 次（由 `rewards.js` 判定） |
| 刮刮乐 | `#回响刮刮乐`、`#回响刮刮乐 一格`、`三格`、`全刮` | 开票 + 揭格；每天 2 张 |
| 福袋 | `#回响福袋` | 每天 1 次（连锁开袋） |
| 收藏馆 | `#回响图鉴`、`#回响图鉴 展示` | 套系进度和当前称号；展示页按页查看卡片 |
| 兑换 | `#回响兑换`（列表）、`#回响兑换 po_01` | 星屑兑换 |
| 佩戴 | `#回响佩戴 title t_novice`、`#回响佩戴 frame f_plain` | 只给编号时类别留空，由模块推断 |
| 档案 | `#回响档案` | 全群每日同一题，个人最多猜 3 次，次日公布答案 |
| 作答 | `#回响猜 d01`、`#回响猜 檐下邮差` | 猜错仅本人增加一条线索 |
| 排行 | `#回响排行` | 本群档案连胜排行 |
| 派遣 | `#回响派遣`、`#回响派遣 jinzhou` | 选择今州、黑海岸、瑝珑等地点；每天一次 |
| 领取 | `#回响领取` | 次日领取材料、纪念品与旅行见闻 |
| 相册 | `#回响相册` | 按地点展示纪念品、见闻和解锁称号 |
| 约战 | `#回响约战 50` | 押注 10–1000 星屑，默认 50 |
| 接受 | `#回响接受 <对战id>` | 群内成员接受，不能接受自己的约战 |
| 单抽 | `#回响对决 <对战id>` | 双方轮流抽，先歪者输；最多 12 抽 |

英文别名：`menu / help / check / draw / scratch / bag / cards / codex / redeem / exchange / equip / wear / dossier / guess / answer / rank / dispatch / claim / albums / duel / accept / pull`。

---

## 3. 面板与按钮行为
1. **新面板发送成功后撤回上一条**：每群每人的面板记录写在 `state.panels["<群号>:<QQ>"]`，包含 `message_id / token / kind / at / turns`。只有收到新消息 `message_id` 才撤回旧消息；发送失败则恢复旧面板令牌，保留旧消息供重试。撤回失败（超时、无权限）只记日志。
2. **按钮参数限定本人**：按钮 `action.data` 形如 `#回响十连|11001#ab12cd34`（`命令|操作人#面板令牌`）。入口校验 `操作人 === 发送者`，不匹配直接拒绝且**不触发任何玩法逻辑**。
3. **服务端验证群**：令牌校验同时比对 `gid` 与 `uid`，把 A 群的按钮拿到 B 群按会被判为过期面板。
4. **旧按钮防复点**：新面板发出后令牌作废；发送失败时恢复上一面板令牌。对战类按钮由对战状态（阶段、当前玩家、是否结算）拦截重复操作。
5. **回调字段兼容**：`e.button.data`、`e.data.button.data`、`e.raw.button.data`、`e.event.button`、`e.buttonData`、`e.button_data`、`e.raw_button_data`，以及 `e.msg` / `e.raw_message` 的文本回显（`type2` 指令按钮按下就是把 data 当消息发出）。
6. **type2 降级**：`presentation.settings.callbackButtons` 为 false 时生成 `action.type = 2`、`enter = true` 的指令按钮，入口照样消费（会剥掉 `|操作人#令牌`）。
7. **QQBot 回调主动发送**：官方按钮事件的 `msg_id` 不能用于 `e.reply`。回调直接走 `e.group.sendMsg` 等主动群发链路，失败也不会再用同一 `msg_id` 被动重试。普通消息按同一 `msg_id` 最多被动回复 5 次，超过后改主动发送。
8. **回调验证**：日志中的 `40034024 请求参数msg_id无效或越权` 来自按钮事件上的被动回复；回归测试覆盖主动发送失败、旧面板保留和成功后撤回。主动群发是否获得 QQ 官方权限仍需在目标群验证。
9. **2 秒防刷**：仿 `进群退群通知.js` 的 `checkCd`（Redis 优先、进程内 `Map` 兜底），按「群 + 人 + 玩法家族」隔离；按钮触发的冷却给出提示，打字触发静默丢弃。

---


## 4. 渲染策略

| 场景 | QQBot | 其他适配器 |
| --- | --- | --- |
| 有卡面/结果（十连、刮刮乐、福袋、收藏馆、档案、派遣等） | 一张图片 + 操作按钮 | 图片 + 文字指令 |
| 对战面板和结算 | 一张图片 + 对应按钮；结算无按钮 | 图片或文字 |
| 主菜单、帮助、错误、自检、空榜 | 简短 Markdown + 按钮 | 文字 |
| 无法渲染图片 | Markdown 明细 + 按钮 | 文字 |

图片是 1280px 的信纸与云海风格卡面，金卡、紫卡、蓝卡有不同边框；十连在一张图中排十封信，刮刮乐显示九格，福袋显示整条连锁，收藏馆按套系与卡面分页。图片数据按 `base64://` 字符串发送，避免适配器处理 `Uint8Array` 时出错。

---

## 5. 状态与并发

- 所有读写都走 `lib/store.js` 的 `transaction(fn)`：有 Redis 时 `SET NX PX` + `eval` 原子比对删除，没有 Redis 时用进程内队列 + 临时文件 `rename` 落盘。Redis 优先、JSON 兜底由底座负责。
- 入口只使用底座已有的结构，不新增顶层键：
  - `state.panels[<群>:<人>]`：面板记录（令牌、`message_id`、刮刮乐进度）。
  - `state.groups[<群>].presence[<人>]`：在场索引（供排行取本群档案，最多 300 条）。
  - `state.duels[<对战id>].echo.*`：入口的对战账本（`phase / escrow / pulls / names / deadline / messageId / groupId / initiator / opponent`）。
- 业务字段仍由两个纯逻辑模块持有（`profile.daily / cards / scratch / titles / frames …`），入口只读写自己的命名空间子对象。

---

## 6. 对战：押注冻结与自动结算

`duel` 保存抽数、当前玩家与赢家；**星屑由入口在事务里原子处理**：

1. **约战**：调用 `duelCreate({id}, initiatorId, stake, now)`，冻结发起方星屑，设置 60 秒接受窗口，发公开接受按钮。
2. **接受**：对手不能是自己；调用 `duelAccept()` 后冻结对手星屑，发双方各自的单抽按钮。
3. **单抽**：只有轮到的玩家可点。第 n 抽歪率为 `5% + (n−1)×8%`，第 12 抽强制歪；首个歪的玩家输，对手赢。每抽刷新唯一对战面板，并从最后一次操作重新计 60 秒。
4. **结算**：赢家获得双方冻结的彩池。无人接受而超时则退回发起方押注；进行中当前轮玩家超时判负，另一人获得彩池。结算仅执行一次并撤回对战面板。
5. **恢复**：启动和上线时恢复未结束对战，15 秒兜底巡检处理到期对局；同一人同时只参与一局，同群最多 3 局。

---

## 7. 适配层：入口与两个逻辑模块的对接

入口**优先采用模块自带的渲染结构**（`result.view`），并对模块的各种返回形状做宽松兜底。

**`lib/rewards.js`**

| 导出 | 入口用法 |
| --- | --- |
| `drawTen(profile, day, rng)` | 十连；结果 `view.tiles` 直接当卡面（10 张），`profile.daily.ten` 记次 |
| `scratch(profile, day, rng)` / `advanceScratch(profile, n)` / `scratchView(profile)` | 开票（结算奖励+扣当日次数）/ 只推进揭格进度 / 纯查看；入口按 `profile.scratch.pending.reveal` 判断「已开票」 |
| `bag(profile, day, rng)` | 连锁福袋 |
| `collection(profile)` | 返回 `{sets, cards, titles, frames, stardust}`：卡面用 `sets`（带 `progress`），佩戴按钮用「已拥有且未佩戴」的 `titles` / `frames` |
| `equip(profile, kind, id)` | 模块只接受 `kind = 'title' \| 'frame'`；只给编号时传 `undefined` 交模块推断 |
| `redeem(profile, id)` | 兑换；入口的兑换列表优先取 `redeemables`（含 `price`） |
| `remainingDaily(profile, day)` | 菜单的「今日剩余 十连 x/2｜刮刮乐 y/2｜福袋 z/1」 |
| `rewardsConfig` | 每日额度（`dailyTen / dailyScratch / dailyBag / pity`），入口据此保护循环上限 |

**`lib/adventures.js`**

| 导出 | 入口用法 |
| --- | --- |
| `sampleDossiers` / `getDailyDossiers(day)` | 原创占位角色题库；同日全群一道题，次日轮换 |
| `dossierView(group, profile, day, questions)` | 当前剪影与本人已解锁线索、四个候选；不提前返回答案 |
| `dossierGuess(group, profile, day, choice, questions)` | 个人三次机会，猜错多一线索，连胜记录 |
| `dossierRank(group, profiles, day)` | 群内连胜榜 |
| `locations` / `getDailyLocations(day)` | 四地素材池，每天展示三个可选地点 |
| `dispatchStart(profile, day, locationId, rng)` | 当日一次出发，未领取前不能再次出发 |
| `dispatchClaim(profile, day, rng)` / `dispatchAlbum(profile)` | 次日领取、地点相册与套系称号 |
| `duelCreate / duelAccept / duelPull / duelExpire` | 轮流单抽、先歪者输、60 秒超时；返回 `winnerId` |

**通用约定**

- 返回值按 `{profile, result, error?}` 解析；`result` 可以是对象（`view / tiles / pulls / links / cells / sets / cards / questions / location / souvenir / list / lines / text / footer / golden …` 宽松识别）或字符串，也可以是**纯数组**（排行）或 `{sets, ...}`（图鉴）。
- `rng` 是**同时可当函数用的对象**：`rng()`、`rng.next()`、`rng.int(a,b)`、`rng.pick(list)`、`rng.chance(p)`、`rng.shuffle(list)` 都能用；`day` 是 `Asia/Shanghai` 的 `YYYY-MM-DD`。
- **接口差异自适配**：函数名先在别名表里找；调用抛出「参数 / undefined / 不是函数」这类错误、且被省略的尾参本来就是 `undefined` 时，按更短签名**只重试一次**（例如 `dossierView` 4 参 → 3 参）；返回值形状不符时记录日志并给可读提示，不会静默吞掉。
- **错误文案**：中文错误原样展示；英文代号走内置映射（`daily_limit` → 今日次数已用完、`insufficient` → 星屑不足、`not_found` → 没有找到对应内容 等）。
- **星屑字段**：自动探测 `stardust / 星屑 / dust / echo(es) / coins / gold / balance / currency / points …`，也支持 `profile.wallet.coins` 这类嵌套（`rewards.js` 用 `stardust`，实测可直接命中）。探测不到时约战会明确提示，可用 `globalThis.echoPostOfficeConfig = { walletKey: 'coins' }` 指定。
- 模块缺失/缺函数时，对应玩法回一句「`xxx.js` 尚未就绪 / 缺少 `yyy()`，该玩法暂不可用」，其它玩法不受影响。

---

## 8. 可调参数

改文件顶部的 `export const config`，或在启动脚本里覆盖：

```js
globalThis.echoPostOfficeConfig = {
  walletKey: 'stardust',     // 星屑字段名（留空自动探测）
  cooldownSeconds: 2,        // 防刷冷却
  maxPassiveReplies: 5,      // 单条消息被动回复上限
  duelTimeoutMs: 60000,      // 对战超时
  sweepIntervalMs: 15000,    // 兜底巡检间隔（0 关闭）
  minStake: 10, maxStake: 1000, defaultStake: 50,
  maxDuelsPerGroup: 3,
  scratchCells: 9, maxScratchRounds: 2,
  panelTtlMs: 86400000, maxPanels: 400,
  replyCharLimit: 900,
}
```

---

## 9. 素材与 QQ 群环境实测

档案角色剪影、鸣潮地点图与原创卡面均可放在 `assets/{dossiers,locations,cards}/<id>.png`（也支持 jpg/webp）。当前未提供图片时使用代码生成的卡面与占位剪影。可在 `lib/adventures.js` 的角色题库和地点表补充自己的素材与见闻。

**QQ 群环境待实测（这里只进行了代码级检查）：**

1. 用户日志已确认 QQBot 按钮能触发，但主动群发权限、消息回调 ID 和撤回时限仍需在目标群验证。
2. 官方适配器的图片上传需能接受 `base64://`；渲染失败会退回 Markdown 与按钮。
3. 旧面板只在新面板取得消息 ID 后撤回；如果权限不足，保留上一张面板并记日志。
4. 多实例部署的定时器与被动回复计数是进程内的；跨实例结算由兜底巡检处理。
5. 对战最多 12 抽、60 秒无操作超时，实际点击节奏需群内确认。
6. **多实例部署**：状态与冷却走 Redis 优先，但定时器与被动回复计数是**进程内**的；跨实例结算由 15 秒兜底巡检兜住。
7. **对战节奏**：最多 12 抽、60 秒无操作超时；真人点击节奏需在群内确认。

---

## 10. 测试

```bash
cd plugins/echo-post-office
npm test                 # 集成测试
npm run test:markdown    # 图片结果、帮助按钮与旧回调兼容
node --test tests/adventures.test.js
node tests/foundation.test.js
npm run check            # 语法检查
```

当前结果以本次运行检查为准：集成测试、Markdown 与回调测试、玩法状态测试、底座测试及语法检查均需通过后再部署。

- **语法与配置**：`node --check` 覆盖 `apps/index.js`、`lib/*.js`、测试自身；`package.json` 的 ESM / main / test 约束。
- **解析层**：命令与按钮 payload（`命令|操作人#令牌`）、无关消息不误触发、QQBot 适配器识别、回调字段兼容。
- **面板生命周期**：主菜单与帮助用简短 Markdown；有卡面和结果时一张图片加按钮，失败退回 Markdown。记录消息 ID，新面板发送成功才撤回旧面板。
- **校验层**：按钮归属、跨群复用与旧令牌失效；公开按钮带回调标记，旧返回菜单也主动发送，不依赖失效的 `msg_id`。
- **发送格式**：图片用 `base64://` 字符串；未获得的卡以剪影呈现，文字不显示内部字段。
- **桩模块覆盖**：十连每日上限、刮刮乐开票/逐格/全刮（含 `advanceScratch` 语义）、福袋、图鉴（套装+头衔按钮）、佩戴（含省略类别）、兑换（列表与错误文案）、档案/猜谜/排行、派遣三件套、接口差异自适配（4 参报错 → 3 参重试）。
- **对战（桩）**：押注冻结、不能接受自己的、应战方余额不足不冻结、越权按钮被拒、可连续抽、12 抽 `forceJudge` 判定、派彩与清理、旧按钮复点提示、60 秒超时退款与主动群发、启动恢复（过期结算 + 重新装定时器 + TTL 清理）。
- **真实模块联调**：十连、菜单额度、刮刮乐逐格、福袋/图鉴/佩戴/兑换、每日一题与排行、派遣次日领取与相册、轮流单抽与押注守恒。
- **容错与接线**：模块缺函数、模块抛错后仍可用、`#回响自检`、星屑字段自动探测、插件类接线（主入口 + 回调入口 + 不重复处理 + type2 文本回显）。
- **Markdown 回归**：全玩法 raw 消息段、隐藏九格、十连完整明细、无按钮结算和 Buffer/Uint8Array 字符串转换。

测试使用临时状态文件（`ECHO_POST_STATE` 指向系统临时目录），每个用例独立群号/QQ 号，对战用例显式清空对战表；不会污染线上数据。
