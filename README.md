# Pawchive 帖子下载器（aria2 版）

`pawchiveDownloader2/extension` 是新的扩展（v2），下载引擎换成了 **aria2**，
通过一个 Python 原生消息宿主（`pawchiveDownloader2/helper`）拉起本机的 `aria2c.exe`。
`pawchiveDownloader2/_unused/extension-old` 是原来的 chrome.downloads 版本，保留作参考。

## 为什么换掉 chrome.downloads

原来的方案靠 `chrome.downloads` 逐个下载，站点防盗链时经常直接失败，只能回退
`fetch + blob`，重试逻辑也不稳定。aria2 自带多连接、断点续传、失败重试，
并且完全不依赖浏览器的下载管理，所以更可靠。

## 组成

```
pawchiveDownloader2/
├── extension/            # MV3 扩展（加载这个目录）
│   ├── manifest.json     # 含 key：扩展 ID 由此确定，见下文「扩展 ID 与密钥」
│   ├── background.js     # 下载调度 + aria2 JSON-RPC 客户端
│   ├── content.js        # 页面识别、悬浮面板、缩略图条、点击接管
│   ├── content.css
│   ├── popup.html/js     # 引擎状态 / 设置 / 全局队列
│   └── icons/
├── helper/               # 原生消息宿主 + 辅助程序
│   ├── host.py           # 接收扩展命令，按需启动/复用 aria2c；--serve 时是 HTTP 桥
│   ├── run_host.cmd      # ★ 浏览器通过它启动 host.py（删了扩展就失联）
│   ├── run-as-admin.cmd  # ★ 用户双击它，以管理员权限启动 HTTP 桥
│   ├── find_python.cmd   # 只用 PATH 里的 Python，被上面三个脚本共用
│   ├── install.cmd       # 注册原生消息宿主（扩展 ID 从 manifest 现算）
│   ├── install_helper.py # 从 manifest 的 key 推导扩展 ID（单一事实来源）
│   ├── make_key.py       # 生成密钥对并算出扩展 ID（换 key 时才用）
│   ├── aria2c.exe        # aria2 1.37.0（不纳入 git，见 .gitignore）
│   └── keys/             # 扩展签名私钥（不参与运行，切勿提交）
├── _test/                # 面板拖动的自测（jsdom + 可选的真浏览器 CDP），见其 README
└── _unused/              # 留档，运行时不参与（见 _unused/old-install/README.md）
```

## 扩展 ID 与密钥（不再写死）

`extension/manifest.json` 里有一个 `key` 字段（RSA 2048 公钥，base64）。浏览器就是用它
决定扩展 ID 的：

```
扩展 ID = SHA256(base64 解码后的公钥 DER) 前 16 字节，每个 nibble 映射到 a..p
```

这条算法已实测核对：拿本机 14 个已安装扩展的 `manifest.json`，用该式算出的 ID
**14/14 与浏览器实际使用的目录名一致**。所以本地加载的扩展 ID 现在是**确定的**：

```
ldigpfmekoeakednbiamcfancpobneaf
```

换机器、换目录、重新加载都不会变。配套工具：

- `python helper\install_helper.py --check-id` —— 校验 manifest 推导值与
  `extension-id.txt` 是否一致（不一致说明 key 被换过）。
- `python helper\install_helper.py --selftest` —— 算法与本项目公钥的自检。
- `python helper\make_key.py` —— 重新生成一对密钥并算出新 ID
  （**会改变扩展 ID**，之后要重跑 `install.cmd` 并重新加载扩展）。
- `_unused/keytest/derive-id.mjs verify` —— 用本机已安装扩展复核算法（Node）。

`helper\keys\private-key.pem` 是配套私钥，**只在打包签名时用得到，不参与运行**。
它被 `.gitignore` 排除；丢了不影响开发（大不了换一对新 key，代价是扩展 ID 变化）。

## Python 依赖

宿主是 Python 脚本，所以**必须有一个 `python` 在 PATH 上**（3.8+）。这是刻意的取舍：
不翻注册表、不找便携版、不捆绑解释器。解释器解析顺序：
`PD_PY` 环境变量 → `helper\python-path.txt` 缓存 → PATH 里的 `python.exe`
→ `py -3` 兜底；首次成功解析后缓存到 `python-path.txt`。

两个实测细节：Microsoft Store 的 `python.exe` 存根
（`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`）会被跳过；原生消息宿主用
`pythonw.exe` 启动，避免闪黑框。想指定别的解释器就设 `PD_PY`。

## 安装

1. **装好 Python 3.8+**（勾选 "Add python.exe to PATH"）。没有它原生消息宿主起不来，
   扩展会一直显示「引擎未就绪」。
2. **注册原生消息宿主**（必须，否则扩展无法启动 aria2）
   双击 `helper\install.cmd`，或在命令行执行。它会把宿主清单写到
   `%LOCALAPPDATA%\...\NativeMessagingHosts\com.pawchive.downloader.json`，
   并在 `HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts` 下注册。
   卸载：`install.cmd uninstall`（注册前会备份旧清单与旧注册表值到
   `helper\host-manifest.<时间戳>.json.bak` 等文件）。
3. 打开 `edge://extensions`（或 `chrome://extensions`）→ 开发者模式 →
   「加载解压缩的扩展」→ 选 `extension` 目录。
4. **扩展 ID 不用手填**：`install.cmd` 会用 `helper\install_helper.py` 从
   `manifest.json` 的 `key` 现算 ID（见上文「扩展 ID 与密钥」），
   所以换机器、换目录、重新加载都不会对不上。想核对就执行
   `python helper\install_helper.py --check-id`。
5. 打开任意 pawchive/kemono 帖子页，右下角出现面板，底部会显示
   `aria2 1.37.0 · 并行 8`。

## 主要行为

- **全局扁平队列**：每个文件独立排队，不再按帖子分批串行。
  并行名额按「当前进行中下载最少的帖子优先」分配，所以 8 个名额会被
  多个帖子交错占用 —— 帖子 A 有 6 个、帖子 B 有 4 个时实际是 4+4 并行，
  而不是先下完 A 再下 B。重试的文件会排到队尾，不阻塞其他文件。
- **下载全部图片**：`下载帖子全部图片` 只收图片（带帖子内 1 基序号）。
- **左下角进度：三个数字**：
  ```
  本帖子：X(Y/Z)
    X = 全局未完成队列长度（所有帖子里还没下完的文件数，含别的标签页/别的帖子）
    Y = 本帖未完成（属于当前页这个帖子的未完成文件数）
    Z = 本页面提交数（在这个页面上点下载按钮提交成功的文件数）
  ```
  - `Z` **只存在内存里**，与下载历史无关：刷新页面即归零；
  - `Y = 0` 但队列里还有活（别的帖子）→ 只显示 `下载队列：X`；
  - 全空 → `空闲`；
  - 例：本页提交 10 个 → `10(10/10)` → `9(9/10)` → `8(8/10)`；手动再下 1 个 →
    `8(8/11)`；别的页面又下 10 个 → `18(8/11)`；刷新后 → `18(8/0)`。
  - 数字来自后台两条数据线（广播 ~1.2s + 查询 1.5s），两者口径已统一，
    **不会再周期性抖动**（见 `调试笔记.md` 第 11 节）。X 取「全局未完成」与「本帖未完成」
    的较大值，避免两条消息时序错开时出现 `3(8/10)` 这种自相矛盾的显示。
- **动作反馈单独一行**：`已加入队列：10 张图片…`、`这些图片已经下载过了…`、`已复制 12 个链接`
  显示在进度行下面，4 秒后自动消失。以前它和进度共用一行，会被下一次轮询立刻盖掉。
- **未存档帖子自动切「缩略图模式」**：站点对没存档的帖子只给预览图
  （文件区是 `.post__thumbnail > figure > img`，全是 `img.pawchive.pw/thumbnail/…`，
  **没有任何 `a.fileThumb` 链接**），标题旁有 `.state-badge--preview` 徽标
  （`aria-label="haven't archived this post yet"`）。此时面板自动变成：
  - 主按钮 `下载全部缩略图`（**橙色**，tooltip 说明「该帖子尚未存档，只能下载缩略图」）；
  - 旁边按钮 `复制缩略图链接`，复制的是缩略图地址；
  - 计数显示缩略图数量（实测该帖 18 个 `.post__thumbnail`）；
  - 弹窗里那颗按钮同步变成 `下载当前帖子全部缩略图`（也是橙色），文案不再谎称「全部图片」。
  判据见 `content.js` 的 `isUnarchivedPost()`：**主判据是 preview 徽标**，兜底是
  「文件区 0 个附件链接 + 有预览图」。**不能只看 `.post__thumbnail`** —— 已存档帖也有，
  只是包在 `a.fileThumb` 里（实测已存档帖 5 个链接 + 5 个 `.post__thumbnail`）。
  缩略图文件名是 URL 末段哈希（站点不给文件名），下载后形如 `1-02780ecf…jpg`。
- **附件/视频逐个下载**：左键/中键点击文件链接即交给 aria2，保留原名、
  与图片存在同一帖子目录（`Ctrl/Alt/Shift/Meta` + 点击不拦截）。
- **保存路径**：`下载根目录/pawchive/作者-平台-作者ID/帖子ID-标题/文件`。
  下载根目录默认取系统「下载」文件夹，可在弹窗里改成绝对路径。
- **标题屏蔽字默认已激活**：弹窗里那两条示例 `(Pixiv Fanbox)`、`patreon` 现在是
  **真实默认值**（不是占位符），装好即从帖子标题里剔除，不用先手动填一遍。
  三处默认值必须保持一致：`background.js`（建目录）、`content.js`（入队时上报标题）、
  `popup.js`（输入框初值），否则同一帖子的标题会被算出两个版本。
  语义：**显式保存的空数组优先于默认值** —— 清空输入框再保存 = 真的不屏蔽任何词，
  不会被默认值偷偷加回来。
- **允许重新下载**（设置项，默认开）：重复点「下载」时，已完成的同一文件会被**复活**
  重新排队（同一条记录从「完成」变回「排队」，不会在列表里堆重复行、也不会新建记录）；
  关闭后则跳过已完成文件、避免重复下载。**失败的文件始终可以重试**，不受开关影响；
  排队中/下载中的同一文件永远跳过（避免重复入队）。目标目录里同名文件不会被覆盖，
  重新下载会存成 `xxx (1).jpg`（由宿主 `handle_move` 保证）。
- **自动跳过封面图**（设置项，默认开）：只对 fanbox 生效，
  「下载帖子全部图片」会跳过封面。判据是文件名 `cover.*`（站点用
  `download="cover.jpeg"` 标注封面）；**整帖都找不到 `cover.*` 时才退回
  「跳过第一张」**，而且只有一张图时不跳。注意不能简单用「第一张」当判据 ——
  实测 fanbox 帖子的文件列表里视频常排在封面之前。附件与视频不受影响。
  **缩略图模式不做封面过滤**：缩略图没有文件名，`cover.*` 判据失效，
  再按「跳过第一张」处理会白丢一张。
- **重试**：aria2 自身 `--max-tries=5 --retry-wait=2`，扩展再加 2 次重试，
  之后标记失败；连续 3 个文件失败会弹浏览器通知。
- **弹窗可看队列、可逐文件取消、可一键中止**：设置页展示「当前下载 / 排队」的逐文件列表
  （按帖子分组，带 排队/下载中/完成/失败 状态点）。**每行的 ✕ 只取消这一个文件** ——
  排队中的直接移出队列，下载中的对 aria2 调 `forceRemove` 真正断掉连接；已完成/失败的行
  不给按钮（归「清除已完成」管）。反馈显示在列表下方（如「已取消：xxx.jpg」）。
  「中止全部下载」按钮仍然一次清掉所有在途文件，不是只清列表。
- **「当前帖子」区只在目标站点出现**：在 pawchive/kemono 帖子页打开弹窗时，显示
  `下载目录 + 图片数 + 队列情况` 和「下载当前帖子全部图片」按钮；站内非帖子页只给一句
  中性提示；**其它网站打开弹窗时整块隐藏**（以前这里会固定显示一句「未检测到…」，
  而设置页大多是在别的网站上打开的，属于噪声）。
  ⚠️ 曾经的 bug：弹窗读 `response.engine.dir`，但 content.js 的 `currentPostPayload()`
  只回 `{ post }`，于是帖子页上必然抛 `TypeError`，文案永远停在 HTML 里那句占位提示上。
  现在 content.js 的回包里带 `engine`，弹窗侧也做了容错（见 `调试笔记.md` 第 9 节）。
- **作者主页**：未存档帖子盖大红 X。判据是 `.state-badge--preview` 徽标
  （或徽标的 `aria-label`/`title` 含 "haven't archived"）。
  **不要**拿 `post-card--preview` 当判据 —— 站点给所有卡片都加了这个类
  （实测 50 张卡片里 50 张都有），用它会把整页都标成未存档；
  未访问卡片另外显示绿框。
- **悬浮面板可拖动**：按住面板左上角的标题栏（抓手光标）就能把它拖到任意位置，
  拖动中面板跟手（每帧一次 transform），松手落位到 `left/top`。位置**不持久化** ——
  刷新或换页后回到默认的左下角，避免「上次拖到角落导致面板看不见」。
  拖动受视口钳制：至少 60px 宽、一整条标题栏始终留在视口内，拖出界也回得来；
  窗口缩小后会自动把面板拉回可视范围。指针事件（鼠标/触摸/触控笔同一套），
  `pointermove/up` 挂在 `document` 上按 `pointerId` 过滤，指针移出窗口也不丢。
  实现见 `content.js` 的「面板拖动」段，自测见 `_test/README.md`。
- **缩略图条**：正文框最上方插入密集缩略图条，点图滚动定位原图，
  右下角小按钮直接下载原图。
- **广告/弹窗拦截**：站点会在页面里注入第三方 popunder 脚本
  （实测 `excavatenearbywand.com` 的 `on.js` / `profile.min.js`），
  **第一次真实鼠标点击/中键**时调用
  `window.open('https://<随机域名>/…')` 开出广告标签页（域名每次不同，
  实测到 `ogfkpyvpe.in` → 跳 `botsdiag.com` → 联盟链），每个标签页只触发一次。
  三层拦掉：
  1. **`main-guard.js`（关键）**：以 `world: "MAIN"` + `run_at: "document_start"`
     注入，在**页面主世界**改写 `window.open`。这一条是必须的 ——
     内容脚本默认跑在隔离世界，它 patch `window.open` 对页面自己的脚本
     **完全无效**（两者是不同 window 对象），我第一版就是这么写错的：
     加了补丁却依然弹广告。
  2. **预授权机制**：`main-guard.js` 只放行「用户真的点了的链接」。
     `content.js`（隔离世界）在 click / auxclick / Enter 时通过
     `window.postMessage({__pdAuth:'pawchive-downloader', url})` 登记目标
     （2 秒有效，并广播给所有子 frame），因此中键打开帖子/附件**照常可用**，
     而广告那种「凭空冒出来的跨域地址」会被拒。
  3. **网络层 `rules.json`**（declarativeNetRequest）：
     - 按域名 block `excavatenearbywand.com` / `phonydepth.com` / `ogfkpyvpe.in` / `botsdiag.com`；
     - **再加一条「第三方脚本一律拦」**（id 10）：在 pawchive/kemono 页面上，
       凡是不是本站域名的 `script` 请求全部 block。实测广告域名是**随机**的
       （一次是 `xfifihbu.in`），按域名封永远封不完；而站点自己的脚本全在
       `pawchive.pw`（作者页/首页/帖子页都核对过），所以这条不会误伤。
     广告脚本开销很大：实测 `/profile.min.js` 一份执行 ~130ms、一次加载 4 份，
     再加一个 208ms 的 payload，**把主线程占住 ~0.7 秒**，下一页的缩略图和面板
     都只能排队等它 —— 这也是「翻页后半秒多才显示」的真正原因。
     拦掉后同一页面：DCL 274ms、面板 289ms、首图 286ms、load 329ms。
  实测：`window.open('https://ogfkpyvpe.in/…')` → BLOCKED 且不开新标签；
  同源地址与「中键预授权过的附件地址」→ ALLOWED。
  要临时关掉 DOM 那两层，把 `content.js` 的 `AD_BLOCK_ENABLED` 改成 `false`
  并删掉 manifest 里的 `world:"MAIN"` 段；关网络层就删 `declarative_net_request`。
- **面板尽量早出现**：`content.js` 从 `document_idle` 改成 `run_at: "document_end"`
  （idle 会等到图片等子资源差不多加载完才注入），并且首次进入不再走 300ms 路由防抖
  （htmx 切换才用 80ms）。实测面板出现在 DCL 后 ~13ms（289ms vs DCL 276ms）。

## 下载目录与 staging（重要）

### aria2 必须由「管理员权限的辅助程序」启动

实测（这台机器上反复对照过）：

```
普通权限 aria2 写 %LOCALAPPDATA% / %TEMP% / D:\Downloads / 甚至桌面
    → errorCode=18  Permission denied
PowerShell / cmd / Python 写同一批目录
    → 正常
管理员权限的 aria2 写同一批目录
    → 正常
```

即 **`aria2c.exe` 这个进程缺的是「提升权限」，不是目录 ACL**（ACL 里
`Everyone` 都是 FullControl）。因此架构上做了硬性限制：

- **浏览器通过原生消息拉起的宿主禁止启动 aria2**：该请求会被直接拒绝并提示
  「请用管理员权限运行 run-as-admin.cmd」。那样启动的 aria2 是普通权限，写盘
  必然失败 —— 这正是之前「扩展偷偷又拉起一个 aria2」的来源。
- aria2 只能由**独立模式**启动：**双击 `helper\run-as-admin.cmd`**（弹 UAC，
  点「是」），保持窗口打开。
- 原生消息通道只保留两个只读用途：`bridge_info`（把桥地址与令牌交给扩展）和
  `status`。**下载相关的 `start` / `move` / `diagnose` 一律走 HTTP 桥**，桥不在
  就明确报错，不再静默回退。
- 令牌为什么这样传：扩展读不到 `config.json`，而临时宿主读得到，所以由它转交；
  辅助程序重启后令牌会变，扩展遇到 403 会自动重新取一次。
- `helper\start-helper.cmd`（普通权限版启动器）已弃用并移到 `_unused\`：
  普通权限下 aria2 写不了盘，它解决不了问题。

### staging 两步下载

即便解决了权限问题，仍保留 staging 机制（对映射网络盘更稳，也便于统一搬运）：

1. **aria2 下到 staging**（默认 `%LOCALAPPDATA%\PawchiveDownloader\staging`）；
2. 下完后扩展请宿主（Python）把成品**移动**到最终归档目录。

- 移动用 `os.replace`，失败自动退回 `shutil.move`，最多重试 3 次；
- 目标同名文件**绝不覆盖**，自动改名成 `xxx (1).ext`；
- 宿主启动时**用 aria2 自己**逐个候选目录做写入探测（`aria2.saveSession`
  写到该目录下的探针文件），选第一个真正写得进去的：
  `config.staging` → `%LOCALAPPDATA%\PawchiveDownloader\staging`
  → `%TEMP%\PawchiveDownloader\staging` → `<下载根目录>\.pd-staging`。
  **必须让 aria2 自己试**：宿主（Python）能写 ≠ aria2 能写。
- **复用实例前会先判断它能不能写**：若已有实例写不进任何目录（典型是先前普通
  权限留下的），会先结束它再以当前权限重启；关不掉时如实报错而不是盲目再起一个
  （否则端口会打架）。这样才能排除「辅助程序已提权、却复用了旧的非提权 aria2」。
- 扩展弹窗有「检测下载/临时目录可写性」按钮，会显示辅助程序权限、aria2 实际
  使用的临时目录、以及每个候选的实测结果。报「创建目录或打开文件失败」时先点它。

## 实现要点（踩过的坑）

- **绝对不要伪造浏览器 `User-Agent` / `Referer`**：站点有多个文件主机，
  `file.pawchive.pw`、`n2.pawchive.pw`、`img.pawchive.pw` 的校验策略不一样。
  实测 `n2.pawchive.pw` 会对**任何带浏览器 User-Agent** 的请求直接返回 **403**
  （把 referer 设成 `pawchive.pw` / `fanbox.pawchive.pw` / 主机自身 / 干脆不带
  都一样 403）；换成 aria2 默认 UA、不带 referer 就正常。而这些图片/附件都是
  公开资源，本来就不需要任何鉴权头，所以最后一个都不加。
- **隔离世界 patch 不了页面的 `window.open`**：这是最坑的一条。内容脚本默认
  跑在隔离世界，`window` 与页面主世界是**两个不同对象**，所以在 content.js 里
  改 `window.open` 对站点脚本毫无作用。要拦站点的弹窗必须用
  `world: "MAIN"` 的独立脚本（`main-guard.js`）。
- **事件 `isTrusted` 决定能否复现广告**：用 CDP `Input.dispatchMouseEvent`
  派发的点击是「可信」的，而用 JS `dispatchEvent` 造的是不可信的；
  popunder 脚本只认真实用户手势，所以合成事件根本触发不出广告
  （我一开始用合成点击测了半天都「没复现」，其实只是没触发）。
- **aria2 的 WebSocket 事件不可用**：随包的 1.37.0 没编译 `WebSocket`
  特性（`aria2c --version` 的 Enabled Features 里没有），所以无法用
  `aria2.onDownloadComplete` 推送。改用轮询 `tellActive` + `tellStatus`。
- **`chrome.alarms` 最小周期是 30 秒**，不能当调度心跳（实测队列只跑一跳就停）。
  现在是自排队的 `setTimeout`（1.2 秒，顺便让 Service Worker 在下载期间保活），
  `chrome.alarms` 只留 1 分钟作为「SW 被回收后重新拉起」的兜底。
- **`dir` 必须是绝对路径**：aria2 的 per-download `dir` 相对「aria2 的工作目录」
  解析，**不是**相对全局 `dir`。用相对路径会把文件落进 `aria2c.exe` 所在的
  helper 目录（实测踩到两次）。现在 staging/最终目录都拼成绝对路径。
- **缩略图预热确实有效，但必须尽早开始**：CDN 返回 `Cache-Control: public, max-age=31536000, immutable`，
  预热过的地址实测 3ms 命中缓存、没预热过约 500ms。实测数据（18 张缩略图、冷缓存）：
  并发 4 → **3.4s**，并发 8 → **2.0s**，并发 12 → 1.4s。所以现在：
  - 预热在页面一就绪就开跑（原来等 1.5 秒，用户通常 1~3 秒内就点 next 了）；
  - 并发 4 → **8**，封顶 60 张，`priority: 'low'`（不和当前页首屏图片抢带宽）；
  - **站点的 `.post__nav-links` 渲染得比 `document_idle` 晚**（实测约 688ms）——
    只调一次会扑空，所以找不到 next 时每 200ms 重试，最多约 3 秒；
  - 同一个 next 只预热一次（`lastPreloadNext` 去重），切页时旧队列作废（token）。
  实测效果：预热完成后翻页，下一页 9 张缩略图 **9/9 命中缓存**（`transferSize: 0`），
  请求从 244ms 就开始、每张 66–72ms；不预热时同样 9 张每张 80–500ms。
  ⚠️ 单靠预热并不能解决「翻页慢」：真正的瓶颈是站点广告脚本占用主线程 ~0.7s
  （见上面「广告/弹窗拦截」里 id 10 的规则）。修掉广告之后同一页面
  首图 286ms、面板 289ms；预热的价值是让图片从缓存直接出，不用再等网络。
- **同一个帖子汇总有两种消息形状，必须都认**：广播 `PD_STATUS` 用
  `posts: [{key, total, …}]`，查询 `PD_GET_STATUS` 用 `post: {count, …}`。
  content.js 的 `applyStatus` 以前只认 `posts`，于是 1.5 秒一次的查询响应
  把 `lastPostSummary` 清零 → 面板在「4/5（广播）」和「0/1（查询后按在途重算）」
  之间来回跳，看起来像随机数（实测就是 `(0/1, 4/5)`、`(0/2, 3/5)` 这种成对交替）。
  现在两种形状都映射成同一份 `{count, done, failed, active, queued}`；
  **两种都拿不到时保留上一份值**，绝不清零。回归测试：`_test/panel-counts.test.mjs`。
- `manifest.json` 里声明了 `http://127.0.0.1/*` 的 host permission，
  扩展才能直接对 aria2 的 JSON-RPC 端口发请求。
- **批处理里 `if` 块内不能 `echo %VAR%` 做校验**：cmd 在解析整个括号块时就展开了
  变量，那时 `VAR` 还是空的，检查会**静默失效**（实测踩到）。要校验就放子程序里。
- **不要用 `echo %VAR% | find " "` 判空/判空格**：cmd 的 `echo` 会输出**尾随空格**，
  `find " "` 必然命中，逻辑刚好反过来（同样实测踩到）。现在改成「Python 校验后写文件、
  批处理用 `set /p` 读回」，绕开 echo 与管道。
- **`find_python.cmd` 优先解析真实 `python.exe` 而不是 `py -3`**：`py -3` 只是个带参数的
  命令行，拿不到配套的 `pythonw.exe`；`run_host.cmd` 用它启动宿主时会变成空变量当命令跑，
  退出码 9009（实测踩到）。`py -3` 现在只作最后兜底。
- **`.cmd` 必须是 GBK + CRLF 且无 BOM**：LF-only 会被 `cmd.exe` 错位解析（见调试笔记 2.13）。
  真源文件放在 `_unused/cmd-src/`（UTF-8），用 `_unused/cmd-src/build-cmds.ps1`
  生成到 `helper/`；不要直接手写 `helper` 下的 `.cmd`。
  （另注：用 `powershell.exe` 5.1 跑带中文的 `.ps1`，脚本自身需要 UTF-8 **BOM**，
  否则它按 GBK 读源码会解析失败。）

## 已知限制

- 队列状态（含已完成记录）存在 `chrome.storage.session`：**浏览器重启或扩展重载后清空**
  （已下载的文件不受影响）。所以关闭「允许重新下载」时，清空记录后仍能重新下载。
- 作者主页的「未访问绿框」依赖 `a.image-link:visited`，和 v1 行为一致。
- 改了下载根目录后，**新任务**会立刻用新目录（每次搬运都由宿主按最新配置执行）；
  staging 位置变更则要等 aria2 重启才生效。

## 排查

- 面板/弹窗显示「aria2 引擎未就绪」：先确认执行过 `helper\install.cmd`，
  再点弹窗里的「启动 aria2」。
- `helper\host.log` 记录宿主的启动与报错；`helper\aria2.<端口>.log` 是 aria2 自己的日志。
- `helper\config.json` 保存 RPC 端口、密钥和上次的下载目录；删掉它可让宿主
  重新生成密钥并重新探测目录。
- 手动关掉 aria2 不会导致扩展失效：后台探活失败会自动让宿主重新拉起。
