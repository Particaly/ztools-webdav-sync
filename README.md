# WebDAV 同步

> 基于 WebDAV 的多设备文件夹同步 ZTools 插件（Vue 3 + TypeScript + Vite + UnoCSS/SCSS）

将电脑上的文件夹与任意提供 WebDAV 功能的网盘（坚果云、Nextcloud、群晖 NAS 等）保持一致，支持双向同步 / 只上传 / 只下载，内置冲突处理与自动同步。

## ✨ 功能特性

- **多文件夹同步**：同时管理多个「电脑文件夹 ↔ 云端文件夹」同步对，逐个显示状态与最近同步时间
- **三种同步方式**：双向同步、只上传（备份到云端）、只下载（添加同步文件夹时选择）
- **冲突处理**：两边同时修改时弹窗对比修改时间 / 文件大小，可选择保留电脑版本、保留云端版本或两个都留（云端版本另存为 `*.conflict.*` 副本）；后台自动同步遇到的冲突统一进入待处理面板，逐条或批量决策
- **同步进度**：文件计数 + 字节量实时进度条
- **自动同步**：文件变更监听（fs.watch）+ 轮询间隔 + 启动时检查，均可开关
- **连接测试**：PROPFIND 探测服务器可达性与延迟
- **跨平台文件名安全**：NFC 规范化一致性；大小写冲突检测（不静默覆盖）；Windows 非法文件名 / 保留名 / 超长路径上传预检；`.DS_Store` / `~$*` / `Thumbs.db` 等系统垃圾默认排除，支持自定义 glob 排除规则；同步目录重叠校验（保存时报错）
- **凭据不明文落盘**：密码经 AES-256-GCM 混淆后写入 dbStorage（防随手窥视，非强加密，见已知边界）；http 明文连接给出界面警告
- **偏好设置**：冲突默认策略、忽略隐藏文件、排除规则、最大并发数等，修改后立即生效并持久化（`ztools.dbStorage`）

### UI 组件（无第三方组件库）

不依赖任何组件库，样式基于 **UnoCSS 工具类 + SCSS** 编写，通用交互封装在 `src/components/ui/`：

| 组件 | 说明 |
| --- | --- |
| `AppButton` | 按钮（primary / secondary / ghost，sm/md/lg/自定义高度） |
| `AppIconButton` | 图标按钮（outline / ghost） |
| `AppInput` | 输入框（前置图标 / 等宽字体 / 小号 / 校验失败态） |
| `AppSwitch` | 开关 |
| `AppSelect` | 自定义下拉选择（键盘导航、外点关闭、空间不足自动上翻） |
| `AppDropdown` | 浮层原语（更多菜单等，外点 / Esc 关闭、按位置弹出） |
| `AppModal` | 弹窗（标题栏插槽 / 遮罩关闭开关 / 底部操作条） |
| `AppSegmented` | 分段选择器 |
| `AppToasts` | 顶部通知条（成功 / 错误 / 警告 / 信息，自动消退） |

设计令牌（颜色 / 字体 / 阴影 CSS 变量）集中在 `src/main.scss`，`uno.config.ts` 将其映射为工具类主题（如 `text-ink-2`、`border-line-card`、`bg-fill-bar`、`card`），保证 SCSS 与工具类同源。

### 同步引擎（preload 侧，Node.js）

- 纯 Node 实现的 WebDAV 客户端（PROPFIND / GET / PUT / MKCOL / DELETE），Basic 认证，流式上传下载（边传边算 sha256）
- multistatus 解析使用 **saxes** 流式 XML 解析器（剥命名空间前缀，不依赖 xmlns 声明；畸形 XML 一律抛错并使该目录扫描判 incomplete，绝不静默返回部分结果；预留 Buffer 流式入口，多字节文件名不受网络块边界影响）
- 以**本机基线**（pluginData 下的快照 + 追加日志 + 意图日志 WAL，见 `src-ztools/preload/store.mts`）为基准做「本地 / 远端 / 基线」三方对比，正确处理删除传播与挂载前缀（如 `/remote.php/dav/`）；远端不存放任何状态文件
- **Depth:infinity 单请求扫描**：服务器探测结论支持递归列举时，远端扫描是同步根上的一次 `Depth: infinity` PROPFIND（不支持则逐目录 N+1 次）。三重防御：探测用嵌套探测文件验证「响应确实包含深层条目」（对把 infinity 当 Depth:1 应答的服务器判不支持）；运行时非 207 / 解析失败一律回落逐目录；基线含大量嵌套文件而单请求响应一个嵌套条目都没有时按「扫描不完整」中止整轮（零删除，见已知边界）
- **集合 etag 子树跳过**：不支持 Depth:infinity 的服务器（坚果云形态）的逐目录扫描，在「集合 etag 深层传播」探测通过（修改二层探测文件后父/祖先集合 etag 均变化，`etagPropagation`，7 天能力缓存）且 scan-cache 新鲜（6 小时内有过全量下降）时，按「父目录清单里子集合 etag 未变」跳过子树 PROPFIND —— 无变化轮请求数从 N+1 降到 1。被跳过子树的远端条目按基线合成参与决策（误判方向是漏变更而非误删，见已知边界）；三层防御 = 探测验证 + 运行时异常回落（被跳过子树内出现冲突 / 条件 412 / 复查失配迹象 → 轮末告警 + 下轮强制全量）+ 6 小时周期性全量对账
- **本地脏路径快速核对**：fs.watch 事件即时登记脏路径集（NFC 归一、去抖窗口内不丢路径），仅 watch 触发轮携带提示走「基线合成 + 逐脏路径 lstat 核对」（≤512 条，超限 / 基线损坏自动回落全量 walk）；定时 / 启动 / 手动 / follow-up 轮恒全量扫描 —— watch 事件不保证完整，脏集只是加速手段，正确性由周期性全量对账兜底
- 无基线保护：新设备 / 新文件 / 基线损坏时绝不产生删除传播；两侧均在时按大小 / mtime / 内容哈希收敛（adopt）或交由用户决策
- 服务器能力探测与档位（A 条件请求强保护 / B 覆盖前复查 / C 只读）：公共能力（etag 行为、条件请求、Depth: infinity 等）按 origin+账号缓存 7 天；**写权限按远端根路径分别判定**（同一服务器不同子树可各自落 A/B/C 档），降级原因（如「服务器拒绝写入（HTTP 403）」）展示在 UI
- 整轮熔断：连续 5 次网络类终态失败（重试耗尽的网络错误或 5xx/429）后本轮快速终止，剩余文件下一轮重试 —— 单轮时长有上界，持续 503 的服务器不会把每个待传文件各拖满重试预算
- **限速与限流尊重**：每源（origin）令牌桶限速，设置页「请求限速」可配每秒请求上限（`server.netOpts.ratePerSec`，空 = 未设置、0 = 明确不限速）；**已知服务器档案**自动启用保守默认（坚果云 `*.jianguoyun.com` 默认 4 次/秒 —— 该服务有请求频率配额且不支持 Depth:infinity、逐目录扫描请求多；用户显式配置永远优先，含显式 0 覆盖）；429 / 503 / 423 一律尊重 `Retry-After`（秒数与 HTTP 日期两种形态，30s 封顶）退避重试，PUT 仅这三类「服务端明确未处理」状态重发；连续网络类失败另触发跨轮指数退避（见调度策略）
- 冲突检测：同一文件两侧均变更且策略为「询问我」时，回调渲染层弹窗等待用户选择，支持「对本轮剩余冲突都这样处理」；疑似上次中断上传残缺文件的冲突附带提示文案
- **半截上传识别与自动重传**：取消或网络中断的 PUT 可能在服务器留下半截文件。上传意图（WAL intent）记录上传前的远端指纹与写入时刻，PUT 以网络类错误 / 用户取消 / 读流失败收场时意图保持开放；下一轮恢复期按判定链识别「自己的半截」（本地未变 + 远端指纹已变 + 远端小于本地 + 流式前缀校验通过），命中后本轮强制重新上传，零冲突零弹窗。判定不了的场景（超内容校验上限 / GET 失败）保持保守：按冲突处理并在弹窗提示「可能是上次中断的上传留下的残缺文件」
- 并发传输池（1–8 可调），单文件失败不中断其他文件；崩溃安全由意图日志在下一轮恢复采纳
- **规模与响应性**：本地扫描与数万条目的规划 / 入表循环分片让出事件循环（不饿调度器心跳、不卡界面）；进度事件经 150ms 时间节流（每相位首事件与终态事件不受限），本地扫描带 250ms 粒度进度（phase='scan'）；远端目录选择器与待处理挂起面板对长列表分批渲染
- **删除安全**：异常情况下绝不批量误删 —— ① 单轮待删超过 `max(50, 基线条目数×20%)` 时整批挂起进待处理面板（删除确认类记录，确认前零删除，逐条 / 批量「确认删除 / 保留不删」）；② 本地删除一律经 `ztools.shellTrashItem` 进系统回收站（macOS 废纸篓 / Windows 回收站），失败跳过该文件并记录，**绝不退化 unlink**；③ 本地根健康检查：根目录不存在 / 不可读 / 空目录但基线非空（疑似外置盘、网络盘掉线后挂载点残留）→ 整轮中止零删除；④ 远端根 404 后被重建且本地基线非空 → 删除传播禁用，delete-local 改判为「恢复上传」（远端缺失是根消失伪象，复活取向），全部重新上传成功后自动恢复；⑤ 空目录清理：因本轮同步删除而变空的目录，两端自底向上清理（远端 DELETE 前逐目录 PROPFIND 复核，他机新写入即跳过）
- **计时器纪律**：引擎内全部计时器（重试退避 / 锁静置与续租 / 连接与无进展超时 / 取消轮询 / watch 去抖）一律经 `require('node:timers')`（libuv 通道）创建，绝不用全局 `setTimeout` / `setInterval` —— 宿主 `contextIsolation:false` 下 preload 的全局计时器就是 Blink DOM timer，页面进入隐藏态后会被钳到 ≥1s。由单元测试与 e2e 的静态检查双轨守护（源码与构建产物均不得出现裸计时器调用）
- **自动同步调度器（preload 侧）**：定时轮询 / 启动同步 / fs.watch 触发 / 手动同步全部由 `preload/scheduler.mts` 在 preload 侧调度（`node:timers` + 按时间戳到期扫描，对宿主隐藏节流免疫），渲染层只订阅事件与请求（`services.scheduler`）。多实例（主窗口视图 + 独立窗口并存）经文件协调：`scheduler/leader.lock` 心跳选举唯一自动调度者；非 leader 的手动同步走 `manual-requests.jsonl` 委托；每目录互斥锁 `locks/<h>.lock` 保证两实例同时手动同步同一目录时串行化（不重复上传、不写坏基线）。无卸载事件的进程死亡一律靠 TTL 接管兜底；`plugin.json` 声明 `backgroundRunning:true`（隐藏时 Blink 不节流，交互不被钳制）。用户「后台运行」开关（默认开）关闭 = 隐藏时挂起自动调度、进入时恢复。冲突语义：手动轮且渲染层订阅在线 → 转发弹窗等待选择；后台轮 / 委托代跑 / 兜底代跑一律 `defer` 挂起（待处理冲突通道统一处理）。调度器与引擎对宿主（ZTools）的全部运行期依赖收敛为显式端口（`preload/host.mts` 的 `HostPorts`：storageRoot / trashItem / notify / config / lifecycle，默认绑定 `window.ztools` 且现取不缓存）—— 无头 / 测试形态可整体注入替换，是引擎移出渲染进程的前置（进程拆分待宿主平台确认）
- **调度策略**：轮末按机器可读摘要（`failureClass` / `openIntents` / `breaker`）分类排程 —— **全局并发**：每 origin（WebDAV 服务器）并发 1 × 全局上限 3（`prefs.schedulerMaxConcurrent` 可覆盖，钳位 1–4）；手动 / watch 触发插队，但队列中等待过久的轮视为被饿死、插队不得越过（interval 任务不饿死）；**跨轮退避**：连续网络类失败起按指数拉长同步间隔（有上限），成功清零，手动同步无视退避且成功后清零；退避期内 watch 触发只合并成一个到期点，退避到期轮全量对比吸收；**开放意图 follow-up**：轮末存在开放上传意图且非熔断 / 非取消时按短延迟抖动排后续轮，优先于跨轮退避（本机有未完成工作要尽快收敛），连续无进展回落常规排程；**让出**：不计失败，短延迟抖动重排，连续多次按 interval 收敛；**睡眠唤醒**：tick 检测到时钟跳变后到期任务延迟数秒（多目录抖动）再补跑，跳变后短窗内的网络类失败不计入退避（唤醒期网络未就绪不是服务器故障）；**冲突挂起**：后台轮 defer 后轮末以「部分完成，有 N 个待处理冲突」收场并经 `ztools.showNotification` 系统提醒一次（同批不重复，处理后再出现才再提醒），主界面目录条展示待处理数、面板支持逐条三选一 /「对剩余冲突都这样处理」/「暂时忽略此冲突」；**熔断归因**：渲染层轮末展示经 `scheduler.summarizeRound` 纯函数产出 —— 熔断轮显示「服务器连续无响应 + 最后失败摘要」，完全相同的错误消息折叠为一条（带次数）

### preload 构建（esbuild 单文件打包，TypeScript 源码）

preload 源码为 **TypeScript（ESM 语法，`.mts` 扩展名）** 并在 `tsconfig.preload.json` 下 **strict 全开** 做类型检查：`services.mts`（引擎 + 门面）、`scheduler.mts`（调度器）、`store.mts`（存储层）、`types.mts`（共享领域类型，单一事实源—— 渲染层 `env.d.ts` 只做 re-export，手写两份的历史结束）、`saxes.d.ts`（saxes 无官方类型的最小使用面声明）。公共门面类型 `ServicesPublic` 由 `services.mts` 的实现推导（测试直检后门在 preload 侧裁剪，渲染层类型不暴露）；渲染层 tsconfig 同步收紧为 `strict: true`（`noImplicitAny` 渐进中）。

`services.mts`（及其依赖）由 esbuild 打成**单文件 CJS 产物** `preload/dist/services.js`（`--platform=node --format=cjs --target=node20 --sourcemap=linked`，Node 内置模块 external），`plugin.json` 的 `preload` 字段指向该产物 —— Electron preload 仍是 CJS，源码的模块风格不影响运行形态。单文件意味着安装为 asar（zpx）形态时没有任何运行时 `node_modules` 依赖需要打包。`npm run build:preload` 单独构建；`npm run build` 会一并执行。开发模式（`ztools dev`）下宿主同样从 `plugin.json` 解析 preload —— 改动 preload 源码后需要重新 `npm run build:preload` 才会在宿主生效。

**开发 / 测试的 Node 版本要求 ≥ 22.18**（`package.json` engines）：e2e 与单测的「源码轨道」直接在 Node 中加载 `.mts` 源码（原生类型剥离，只允许可擦除语法—— 无 enum / namespace / `import =`），与「构建产物轨道」双轨对照；低于该版本时源码轨道不可用（构建产物与宿主运行不受影响）。

### 性能与规模

按数万文件规模设计，5 万文件基准（2026-10-02 复测，Apple M1 / Node 22 / 本机回环实测）：本地扫描 5 万文件约 2.7s；远端扫描逐目录 501 请求约 17.3s、Depth:infinity 单请求约 21.3s（响应体 20.0MB）；无变化轮（含扫描 + 规划 + 收尾）逐目录约 24.4s、单请求约 23.5s（规划本身仅约 0.4s）；峰值堆内存约 130–170MB、进程 RSS 峰值约 290MB，随条目数线性。扫描形态按服务器能力自动选择：支持 `Depth: infinity` 的服务器（Nextcloud 等）走单请求；不支持的自动回落逐目录；**探测验证集合 etag 随深层修改传播的服务器**（探测新增 `etagPropagation` 实测，7 天 TTL 能力缓存）在逐目录形态下按「父清单里子集合 etag 未变」跳过子树 PROPFIND —— 坚果云形态（2,000 文件 / 100 目录）无变化轮请求数从 102 降到 2；探测不通过的服务器行为与跳过机制引入前完全一致，误判方向由「运行时异常回落全量 + 6 小时周期对账 + 扫描不完整零删除」三层防御兜底。本地侧 watch 轮另有脏路径快速核对（fs.watch 事件登记的脏集仅为加速手段，interval/startup/manual 轮恒全量扫描兜底正确性）。

### 已知边界

- **同步生命周期与宿主进程绑定**：同步引擎与调度器运行在插件 preload（渲染进程），**ZTools 宿主退出 / 被杀时同步随之停止**，不会以任何形式脱离宿主后台常驻；期间其他设备的变更在宿主下次启动后的首轮同步补齐（意图日志 WAL 与租约锁 TTL 保证崩溃 / 强退后的安全恢复）。`plugin.json` 的 `backgroundRunning:true` 只解决「窗口隐藏时 Blink 计时器节流」（隐藏不暂停自动同步），**不是**宿主退出后继续同步。独立同步进程是长期方向（需宿主平台提供插件级后台进程能力）。
- **删除安全的取舍**：
  - **批量删除阈值以「未经确认的删除」计数**：已确认（choice=delete）与已选择保留（choice=keep）的删除不计入 `max(50, 基线×20%)`——已确认的整批否则永远无法执行；阈值只拦截「本轮突然出现的大批量删除」这一危险信号；
  - **本地根目录被删光会被空目录保护拦截**：根目录存在但零条目且基线非空时整轮中止（典型形态：挂载点残留），用户真的删光本地全部文件也会命中 —— 保守取向，需检查目录配置或经待处理面板确认（每轮提示原因）；
  - **远端根重建保护是粘性的**：404 重建后保护持续生效（delete-local 改判为重新上传）直至「本地未变 + 远端缺失」的待和解集合清零；期间若有文件**永远传不上去**（如超服务器大小上限），删除传播会一直暂缓并每轮提示 —— 需用户处理该文件或调整目录配置；保护期内用户经面板确认过的删除仍会执行（显式同意优先）；
  - **回收站删除依赖宿主**：`ztools.shellTrashItem` 不可用（宿主异常 / 测试环境缺失）时本地删除全部跳过并逐条报错，不退化 unlink；回收站无法容纳的超大目录（系统盘空间不足等）同理逐文件跳过；
  - **空目录清理只处理「因本轮同步删除而变空」的目录**：用户自己删光文件留下的空目录（本地侧）、以及历史轮次遗留的空目录不在清理范围（引擎基线只记录文件，不追踪目录）；本地含被忽略文件（如 `.DS_Store`）的目录因非空自然跳过；
  - **远端空目录清理与他机写入的竞态窗**：清理前逐目录 PROPFIND 复核已把窗口压缩到「复核 → DELETE」之间（毫秒级），该窗内他机写入的新文件仍可能随目录被集合 DELETE 递归删除 —— 多设备同时整理目录结构的场景请错峰操作。
- **基线丢失/损坏的固有代价**：无基线保护语义下，两次同步之间被删除的文件会因「仅一侧存在 → 视为新增」而重新下载回来（复活）；其中一侧被修改过的文件会进入冲突。这是保守取向（宁可复活/询问，绝不误删）的固有代价。
- **无哈希漏检**：未开启深度校验且基线无 lhash 时，「等长覆写且 mtime 不变或落在容差内」的本地修改无法检测；远端侧「等长且 etag/mtime 均不变」的修改任何方案都无法检测（除非全量下载比对）。
- **深度校验的代价**：开启后按周期重算本地**全部**文件的哈希，大目录会明显增加每轮耗时与磁盘读取（设置页有同步提示）。
- **本地 mtime 容差探测**：通过在同步目录写入临时探测文件实测 mtime 粒度（FAT/exFAT 类 2 秒 → 2s 容差，其余 1s）；探测失败保守取 2s，略放宽漏检窗口。
- **fingerprint-unstable 仅是启发式**：至少 3 个不同文件各自出现「仅指纹变化、内容相同」才标记服务器指纹不稳定；标记只影响消歧策略的选择，不影响数据安全。
- **能力探测目录对其他 WebDAV 客户端短暂可见**：服务器能力探测需在远端同步根下真实写入（`<root>/.wdsync-probe-<随机串>/sub/probe.txt`，一层嵌套用于验证 Depth:infinity 是否真的返回深层条目，存活秒级），存续期间其他 WebDAV 客户端会看到该目录。缓解手段：点前缀命名（多数客户端可隐藏或易于识别）、探测目录内仅一层子目录单文件、用完整体 DELETE；进程崩溃留下的残留按前缀 + 时龄门槛在同步轮扫描后与探测启动时双通道清理。无法对不配合的客户端彻底隐藏，如实说明。
- **跨平台文件名与排除**：
  - **NFC 规范化**：内部 key 全链路 NFC 归一（`store.nfc`）；远端 / 本地的 NFD（分解形）文件名按 `origName` 原样访问，两侧 NFD/NFC 变体折叠为同一条目（e2e FN0 实测）。大小写折叠用 `toLowerCase`，Unicode 特殊折叠（如土耳其 İ）为已知近似；
  - **大小写冲突不静默覆盖**：同目录下「仅大小写不同」的文件（本地对 / 远端对 / 跨侧各一）在规划层检出后，涉及的文件本轮跳过一切上传 / 下载 / 冲突收敛并逐组报错，请重命名其一；**删除传播不受限**（删除一侧正是消解手段，下轮自动恢复）。纯大小写敏感环境（Linux ↔ Linux）下同一对文件也会被拦（保守取向）；
  - **Windows 文件名预检**：上传前（macOS 上同样）校验非法字符（`< > : " | ? *` 与控制字符）、保留设备名（CON/NUL/COM1–9 等，含带扩展名形态）、段尾空格或点、路径过长（rel > 240 字符；win32 上另按本机完整路径 ≤ 259 判定）。命中按 BAD_FILENAME 记入持续失败退避表（**不重试撞墙**，重命名后自动恢复）；win32 下载侧同样预检（**未在真实 Windows 上验证**，macOS 开发机仅直检纯函数）。长路径策略按经典 MAX_PATH 260 判定，不探测 Windows 10 1607+ 的长路径开关；
  - **默认排除（不可关闭）**：`.DS_Store`、`._*`、`~$*`、`.Spotlight-V100`、`.Trashes`、`Thumbs.db`、`ehthumbs.db`、`desktop.ini` 等 OS / Office 本机垃圾始终排除（与「忽略隐藏文件」开关独立 —— 它们不是用户业务文件，跨机同步只会传播垃圾）。用户可在设置页追加 glob 规则（`*` 不跨目录段；含 `/` 时按完整相对路径匹配），上限 200 条；
  - **目录重叠校验**：保存同步目录时校验与既有目录的本地 / 远端路径不得嵌套或相同（win/darwin 按大小写折叠比较，与默认卷文件系统一致；Linux 大小写敏感）。
- **Depth:infinity 单请求扫描**：
  - **能力结论最多 7 天可信**：探测用嵌套探测文件验证过服务器确实返回深层条目，但缓存过期后服务器行为可能变化；非 207 / 解析失败会自动回落逐目录模式（多花一次请求，同步不中断）；
  - **运行时浅响应阀门是启发式**：基线含大量嵌套文件（> max(50, 基线×20%)）而单请求响应一个嵌套条目都没有时按「扫描不完整」中止。远端真的被整体清空深层文件（正常大规模删除）也会命中该阀门 —— 该场景本就会被批量删除确认通道拦截，用户确认后照常执行；个别深层文件（≤ 阈值）被删不触发；
  - **目录 etag 子树跳过优化未启用**：多数服务器的集合 etag 不随子条目（或仅随直接子条目）变化，探测成本高且误判方向是漏掉远端变更；单请求扫描已覆盖其主要收益。
- **凭据混淆（如实说明：防随手窥视，不是强加密）**：WebDAV 密码经 **AES-256-GCM** 混淆后写入 `ztools.dbStorage`（密文 `wdsync1:...`，随机 iv + GCM 完整性校验），密钥为本机 pluginData 下 32 字节随机文件（`secretbox.key`，0600）。**密钥与密文同机同盘**：能读本机任意文件的人同样能解开 —— 它防的是翻数据库文件 / 诊断导出 / 截图这类「随手窥视」，防不了有本机文件访问权的攻击者。密钥文件丢失 / 损坏时密码按丢失处理（界面显示空密码，重输即可）；pluginData 不可写时退化为明文保存（尽力而为，不阻断）。e2e FN5 扫描确认：轮次 errors / warnings / summary 序列化与失败退避表中均不出现密码与 Authorization 头值；纯浏览器预览（无 preload）不加密（localStorage 演示形态，无真实凭据）。
- **http 明文连接**：服务器地址为非回环的 `http://` 时，主界面卡片与设置页给出常驻警告（密码与文件内容可被网络中间人窃听），但**不阻止使用**（内网自建 / 调试场景合法）。

## 📁 项目结构

```
.
├── src-ztools/
│   ├── logo.png              # 插件图标
│   ├── plugin.json           # 插件配置（feature: WebDAV 同步；pluginSetting.backgroundRunning；preload 指向 preload/dist/services.js）
│   ├── dist/                 # 渲染层构建产物（vite build 输出）
│   └── preload/
│       ├── package.json      # CommonJS 标记（dist 产物的模块上下文；源码 .mts 为 ESM 语法）
│       ├── services.mts      # Node 能力层源码（TS，strict）：dav（WebDAV 客户端）/ fsx（文件系统）/ sync（同步引擎）+ 调度器挂载与宿主生命周期钩子 + 公共门面类型导出
│       ├── scheduler.mts     # 自动同步调度器源码（TS，strict；DirSlot 状态机 / leader 选举 / 手动委托 / 目录互斥锁；无 Vue / DOM 依赖）
│       ├── store.mts         # 存储层源码（TS，strict；deviceId / 基线 / WAL / 服务器能力缓存 / 凭据混淆 secretbox）
│       ├── types.mts         # 共享领域类型（单一事实源；渲染层 env.d.ts re-export）
│       ├── host.mts          # 宿主依赖端口层（HostPorts：storageRoot/trash/notify/config/lifecycle；默认绑定 window.ztools 现取不缓存，无头/测试可注入）
│       ├── saxes.d.ts        # saxes 依赖的最小类型声明（无官方类型）
│       └── dist/services.js  # esbuild 单文件打包产物（CJS；plugin.json preload 入口）
├── src/
│   ├── main.ts               # 入口（引入 uno.css / main.scss）
│   ├── main.scss             # 设计令牌与基础样式
│   ├── App.vue               # 路由：主界面 / 设置页 + 冲突弹窗
│   ├── env.d.ts              # window.services / window.ztools 类型声明
│   ├── composables/
│   │   ├── store.ts          # 全局状态：配置、目录、同步编排、调度器订阅
│   │   ├── options.ts        # 设置页选项表
│   │   ├── format.ts         # 时间 / 字节格式化
│   │   └── toast.ts          # 顶部通知
│   ├── components/
│   │   ├── AppIcon.vue       # 内联 SVG 图标
│   │   ├── icons.ts          # 图标路径表
│   │   ├── ui/               # 基础 UI 组件（Button / IconButton / Input / Switch / Select / Dropdown / Modal / Segmented / Toasts）
│   │   ├── TopBar.vue        # 顶部栏（Logo / 连接状态 / 更多菜单 / 设置）
│   │   ├── ServerCard.vue    # WebDAV 服务器卡片 + 测试连接
│   │   ├── DirRow.vue        # 同步目录行（状态 / 进度 / 摘要 / 待处理挂起条）
│   │   ├── StatusBar.vue     # 底部状态栏 + 立即同步
│   │   ├── DirFormModal.vue  # 添加 / 修改同步目录弹窗（含远端目录浏览器）
│   │   ├── RemoteDirModal.vue # 远端目录逐级浏览选择（长列表分批渲染）
│   │   ├── ConflictModal.vue # 文件冲突处理弹窗
│   │   └── PendingConflictsModal.vue # 待处理挂起面板（后台冲突 + 删除确认；长列表分批渲染）
│   └── views/
│       ├── MainView.vue      # 主界面（含首次未配置空状态）
│       └── SettingsView.vue  # 设置页（连接 / 同步 / 高级 / 状态）
├── test/
│   ├── dav-server.mjs        # 迷你 WebDAV 服务器（含档位/畸形 XML/只读子路径/深度行为开关，仅测试用）
│   ├── sync-e2e.mjs          # 同步引擎端到端测试（--built 切换为跑构建产物，--fast 跳过慢组）
│   ├── store-unit.mjs        # 存储层单元测试
│   ├── host-load-check.mjs   # 宿主 Electron 加载验证（目录 / asar 两种安装形态）
│   ├── bench-saxes.mjs       # multistatus 解析基准（5 万条目耗时 / 内存 / 产物体积）
│   ├── bench-verify.mjs      # 解析器产物正确性核对基准
│   ├── bench-round.mjs       # 同步轮基准（5 万文件的扫描 / 规划 / 无变化轮）
│   └── bench-etag-skip.mjs   # etag 子树跳过基准（N+1 逐目录形态的无变化轮改造前后对比）
├── CHANGELOG.md
├── index.html
├── uno.config.ts
├── vite.config.js
└── tsconfig.json
```

## 🚀 快速开始

```bash
npm install
npm run dev            # 开发模式（ZTools 自动加载 http://localhost:5173；preload 用 preload/dist 产物）
npm run build          # vue-tsc + vite build（渲染层）+ esbuild 打包 preload
npm run test           # 单元 + e2e（源码）+ e2e（构建产物）
npm run test:e2e       # 仅 e2e（源码模式）
npm run test:e2e:built # 构建 preload 并对产物跑同一套 e2e
```

### 宿主加载验证（可选）

`node test/host-load-check.mjs` 用宿主仓库自带的 Electron（相对路径缺省 `D:\workspace\self\ZTools`，可传参覆盖）按宿主 `pluginManager` 的 webPreferences 形态真实加载 preload 产物，对迷你 DAV 服务器完成一次「连接 + 上传 + 空轮 no-op」同步；目录形态与 asar（zpx 的实体格式）各验一遍。需先 `npm run build`。

### 性能基准（可选）

`node --expose-gc test/bench-round.mjs [files=50000] [dirs=500]` 对迷你 DAV 服务器跑同步轮基准（本地 / 远端扫描、首轮 adopt、无变化轮的耗时与内存，逐目录与 Depth:infinity 两种扫描形态各测一遍）；`node --expose-gc test/bench-etag-skip.mjs [files=2000] [dirs=100]` 跑 etag 子树跳过基准（坚果云形态 N+1 逐目录扫描下，「探测通过跳过 / 探测不通过不跳过 / watch 脏路径快速核对」三种形态的无变化轮请求数与耗时对比）。`node --expose-gc test/bench-saxes.mjs` 是纯解析基准（5 万条目 multistatus）。三者均为手动运行，不进 `npm test`。

### 界面预览（无需 ZTools 宿主 / WebDAV 服务器）

纯浏览器打开 dev server 时组件自动降级（localStorage 存储而非 dbStorage）。可用演示场景查看全部状态：

| URL | 画面 |
| --- | --- |
| `/?demo=empty` | 首次未配置 |
| `/?demo=main` | 已连接已配置 |
| `/?demo=add` | 添加同步目录弹窗 |
| `/?demo=syncing` | 正在同步（进度 37%） |
| `/?demo=conflict` | 同步冲突 + 处理弹窗 |
| `/?demo=done` | 同步完成摘要 |
| `/?demo=settings` | 设置页 |

## 🧪 端到端测试

`npm run test:e2e` 会启动 `test/dav-server.mjs`（迷你 WebDAV 实现），并直接在 Node 中加载 preload 的同步引擎，覆盖：连接测试、首次上传、无变更空跑、远端变更下载、冲突（保留本地 / 同时保留）、隐藏文件忽略、仅下载模式、删除传播、目录监听、调度器状态机 / leader 选举 / 目录互斥锁、删除安全（批量删除阈值与挂起确认 / 回收站删除 / 本地根健康检查 / 远端根 404 重建保护 / 空目录清理，DS 系列，每项含「正常通过 + 保护生效」两类用例）、跨平台与配置安全（NFC 规范化 / 内置垃圾与用户排除规则 / Windows 文件名预检 / 大小写冲突检测与消解 / 目录重叠校验 / 凭据混淆与输出泄漏扫描 / 调度器解密链路，FN 系列）、性能与规模（Depth:infinity 单请求扫描 / 逐目录回落 / 浅响应阀门 / 探测硬化 / 进度事件节流与终态送达，B3 / B4 系列）。

### 测试工件与 `.throttle-bench`

e2e / 取消用例会在 `test/` 下重建点前缀运行目录（`.dav-root*`），历史一次性压测还会在仓库根留下 `.throttle-bench` 一类工作目录 —— 它们都是**运行工件而非源码**：`.gitignore` 已忽略，且 `host-load-check` 的 asar 内容检查会把 `test/`、`.dav-root*`、`.throttle-bench` 等一律拒于打包产物之外（zpx 的实体是 asar，绝不携带仓库资产）。本地残留直接删除即可。

## 📚 相关资源

- [ZTools 官方文档](https://github.com/ztool-center/ztools)
- [ZTools API 类型](https://www.npmjs.com/package/@ztools-center/ztools-api-types)
- [Vue 3 文档](https://vuejs.org/)

## 📄 开源协议

MIT License
