// 后台 Service Worker：aria2 JSON-RPC 下载引擎 + 全局扁平调度
//
// 设计要点（对应 v2 的改动）：
// 1. 下载交给 aria2c（多连接、断点续传、自身重试），不再依赖 chrome.downloads；
//    aria2 由原生消息宿主 helper/host.py 拉起，本文件只通过 JSON-RPC 驱动它。
// 2. 队列是全局扁平的：每个文件独立排队，不再被帖子分隔。并行名额用
//    「当前进行中下载最少的帖子优先」来分配，因此 8 个名额会被多个帖子交错使用。
// 3. aria2 不支持 WebSocket 事件（本机 1.37.0 未编译该特性），所以用一个
//    chrome.alarms 定时器轮询 tellActive / tellStopped 来推进队列与进度。
'use strict';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const ALARM_TICK = 'pawchive-tick';
// 注意：chrome.alarms 的最小周期会被 Chrome 钳到 30 秒，太慢，不能当作调度心跳。
// 真正的轮询用自排队的 setTimeout（顺便让 SW 在下载期间保持存活），
// alarms 只在「SW 被回收 / 浏览器重启」后把循环重新拉起来。
const ALARM_RECOVERY_MINUTES = 1;
const TICK_MS = 1200;
const NATIVE_HOST = 'com.pawchive.downloader';

// 「标题屏蔽字」的默认值：与弹窗里的示例内容保持一致，装好就生效，不需要用户
// 先手动填一遍。注意语义：用户清空后点保存，存下来的是空数组，空数组优先于
// 这里的默认值 —— 那代表「我确实不想屏蔽任何词」，不能被默认值覆盖回去。
const DEFAULT_BLOCK_WORDS = ['(Pixiv Fanbox)', 'patreon'];

const DEFAULT_SETTINGS = {
  skipFirst: 0,
  skipLast: 0,
  maxParallel: 8,
  blockWords: DEFAULT_BLOCK_WORDS.slice(),
  downloadDir: '',
  blockCover: true,
  // 已完成的同一文件再点下载时，是否允许重新下（默认开）。
  // 关掉就退回旧行为：把 done 当重复直接跳过。
  allowRedownload: true
};

const MAX_ENGINE_RETRIES = 2; // aria2 自身 max-tries=5 之外的额外重试次数
const CHECK_INTERVAL_MS = 1500; // 同一个 gid 的 tellStatus 最小间隔
const STALL_TIMEOUT_MS = 60000; // 交给 aria2 后 60 秒仍查不到状态视为异常
const CONSECUTIVE_FAILURE_LIMIT = 3;
const FAILURE_NOTIFY_MIN_INTERVAL_MS = 20000;

// aria2 的 errorCode 说明（只列常见的几个，便于把「Download aborted」翻成人话）
const ARIA2_ERROR_HINTS = {
  1: 'aria2 内部错误',
  3: '文件已存在或找不到文件',
  9: '磁盘空间不足',
  13: '文件已存在',
  16: '打开/创建文件失败（staging 临时目录不可写？）',
  18: '创建目录或打开文件失败（staging 临时目录不可写，或映射盘不可用）',
  19: '域名解析失败（网络/DNS 问题）',
  22: 'HTTP 响应异常（服务器拒绝了请求）',
  23: '重试次数用尽',
  24: 'HTTP 授权失败',
  29: '服务器暂时不可用'
};

function describeAria2Error(status) {
  if (!status) return '未知错误';
  const code = Number(status.errorCode);
  const raw = status.errorMessage || status.status || '';
  let hint = ARIA2_ERROR_HINTS[code];
  // 16/18 基本都是目录/文件写不进去：把 aria2 实际使用的临时目录带上，
  // 否则用户看到的只是一个「不可写」的结论，不知道该改哪里。
  if ((code === 16 || code === 18) && cfg.staging) {
    return `写入失败：aria2 无法在「${cfg.staging}」及其子目录下创建文件（${raw}）；` +
      '可在扩展弹窗点「检测下载/临时目录可写性」查看具体哪个目录不可写。';
  }
  if (hint) {
    return raw && raw !== hint ? `${hint}（${raw}）` : hint;
  }
  return raw || `errorCode ${status.errorCode}`;
}

const STATE_KEY = 'pdState';

// ---------------------------------------------------------------------------
// 运行时状态（SW 被回收后由 chrome.storage.session 恢复）
// ---------------------------------------------------------------------------
let cfg = {
  url: '',
  secret: '',
  dir: '',
  root: '',
  staging: '',
  stagingWritable: null,
  maxParallel: 0,
  ready: false,
  version: ''
};
let records = {}; // id -> record
let tracker = {}; // gid -> { id, path, seq, startedAt, nextCheckAt, checkCount }
let seqCounter = 0; // 跨帖子分配顺序，用于从旧到新铺满并行名额
let lastLog = ''; // 面板上显示的一行诊断信息
let failureStreak = 0;
let lastFailureNotifyAt = 0;
let downloading = false; // 本 SW 实例里调度器是否在跑
let inflightPump = false;
let currentSpeed = 0; // aria2 汇报的瞬时总速度（字节/秒）
let tickTimer = null; // 自排队轮询定时器

let engineStarting = null;

// tabId -> 该标签页自己报告的帖子 key（由内容脚本在 PD_GET_STATUS 里带上）。
// 用它而不是从 tab.url 现推，广播才能和内容脚本的口径完全一致。
const tabKeys = new Map();

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
async function loadState() {
  try {
    const data = await chrome.storage.session.get(STATE_KEY);
    const state = data[STATE_KEY];
    if (state && typeof state === 'object') {
      records = state.records || {};
      tracker = state.tracker || {};
      seqCounter = state.seqCounter || 0;
    }
  } catch (err) {
    // 忽略：从空状态开始
  }
}

async function saveState() {
  try {
    await chrome.storage.session.set({
      [STATE_KEY]: { records, tracker, seqCounter }
    });
  } catch (err) {
    // 忽略
  }
}

async function getSettings() {
  try {
    return await chrome.storage.sync.get(DEFAULT_SETTINGS);
  } catch (err) {
    return { ...DEFAULT_SETTINGS };
  }
}

function setLog(message) {
  lastLog = message;
}

// 引擎状态快照（含 staging，方便在弹窗里看出「aria2 到底往哪写」）
function engineSummary() {
  return {
    ready: cfg.ready,
    version: cfg.version,
    dir: cfg.dir,
    staging: cfg.staging,
    stagingWritable: cfg.stagingWritable,
    maxParallel: cfg.maxParallel,
    speed: currentSpeed,
    blockCover: cfg.blockCover,
    bridgeUrl: bridge.url,
    bridgeReady: !!bridge.token,
    bridgeError: bridge.lastError
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------
async function rpc(method, params, timeoutMs) {
  if (!cfg.url || !cfg.secret) throw new Error('aria2 未就绪');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    const response = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'pd',
        method,
        params: [`token:${cfg.secret}`, ...(params || [])]
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body && body.error) {
      const err = new Error(body.error.message || 'aria2 RPC 错误');
      err.code = body.error.code;
      throw err;
    }
    return body ? body.result : null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// aria2 进程：交给原生宿主启动 / 复用
// ---------------------------------------------------------------------------
async function pingAria2() {
  try {
    const version = await rpc('aria2.getVersion', [], 3000);
    if (version && version.version) {
      cfg.version = version.version;
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

function sendNative(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
        if (settled) return;
        settled = true;
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 与宿主通信：下载相关的一切都走「独立模式」HTTP 桥
//
// 为什么不再允许浏览器拉起 aria2：原生消息拉起的宿主是普通权限，它启动的
// aria2 同样没有提升权限，写 %LOCALAPPDATA%、%TEMP%、映射盘一律
// errorCode=18 Permission denied。aria2 必须由用户以管理员权限运行的
// run-as-admin.cmd 启动。所以：
//   - bridge_info / status → 走原生消息（临时宿主，只读 config.json，不启动 aria2）
//   - start / move / diagnose → 只走桥，桥不在就明确报错，不再偷偷回退
// ---------------------------------------------------------------------------
const BRIDGE_URL = 'http://127.0.0.1:16850/rpc';
const BRIDGE_TIMEOUT_MS = 5000;
const BRIDGE_CALL_TIMEOUT_MS = 30000;

let bridge = { url: BRIDGE_URL, token: '', lastError: '', checkedAt: 0 };

function learnBridge(response) {
  if (!response) return false;
  if (response.bridgeUrl) bridge.url = response.bridgeUrl;
  if (response.bridgeToken) {
    bridge.token = response.bridgeToken;
    return true;
  }
  return false;
}

async function callBridge(message, timeoutMs) {
  if (!bridge.token) {
    // 没有令牌就先向原生消息宿主问一次（它读得到 config.json）
    const info = await nativeCommand({ action: 'bridge_info' });
    if (!learnBridge(info)) {
      throw new Error('拿不到辅助程序令牌（config.json 不可读？）');
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || BRIDGE_CALL_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(bridge.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, token: bridge.token }),
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(
      `连不上辅助程序（${bridge.url}）：请双击 helper\\run-as-admin.cmd 并同意 UAC，保持窗口打开`
    );
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 403) {
    // 令牌过期（辅助程序重启过）→ 重新取一次再试一遍
    const info = await nativeCommand({ action: 'bridge_info' });
    if (learnBridge(info)) {
      const retry = await fetch(bridge.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message, token: bridge.token })
      });
      if (retry.ok) {
        bridge.lastError = '';
        return retry.json();
      }
    }
    throw new Error('辅助程序令牌无效，请重启扩展或重新运行 run-as-admin.cmd');
  }
  if (!resp.ok) throw new Error(`辅助程序返回 HTTP ${resp.status}`);
  bridge.lastError = '';
  bridge.checkedAt = Date.now();
  return resp.json();
}

// 只走原生消息（用于取桥接信息、查询状态；绝不启动 aria2）
async function nativeCommand(message) {
  return sendNative(message);
}

// 只走桥：拿不到就明确失败，不回退到「浏览器拉起 aria2」
async function bridgeCommand(message) {
  return callBridge(message);
}

async function hostDiagnose() {
  const result = await bridgeCommand({ action: 'diagnose' });
  if (result && typeof result === 'object') {
    result.extensionSide = {
      via: result.via === 'bridge' ? '独立模式（start-helper.cmd）' : '浏览器拉起（原生消息）',
      bridgeUrl: bridge.url,
      bridgeReady: !!bridge.token,
      bridgeError: bridge.lastError
    };
  }
  return result;
}

async function ensureEngine() {
  if (cfg.ready && cfg.url && cfg.secret) {
    // 先探活：aria2 可能被关掉/崩了，此时 cfg.ready 不能信
    const alive = await pingAria2();
    if (alive) {
      // 并行数可能刚在弹窗里改过，顺手同步给 aria2
      const settings = await getSettings();
      if (String(cfg.maxParallel) !== String(settings.maxParallel)) {
        await applyGlobalOptions(settings);
      }
      return true;
    }
    cfg.ready = false;
    setLog('aria2 连接丢失，正在重新启动…');
  }
  if (engineStarting) return engineStarting;

  engineStarting = (async () => {
    const settings = await getSettings();
    let response;
    try {
      response = await bridgeCommand({ action: 'start', downloadDir: settings.downloadDir || '' });
    } catch (err) {
      // 桥不通就是唯一原因：下载相关的一切都由独立模式辅助程序负责，
      // 扩展不再自己拉起 aria2（那样启动的进程没有提升权限，写盘必失败）。
      setLog(err.message);
      cfg.ready = false;
      return false;
    }
    if (!response || !response.ok) {
      // 宿主明确报错（例如权限不足以重启已有 aria2）时把原因显示出来，
      // 不要笼统写成「aria2 启动失败」。
      setLog(
        `${(response && response.error) || 'aria2 启动失败'}` +
          (response && response.runningDir ? `（当前实例目录：${response.runningDir}）` : '')
      );
      cfg.ready = false;
      return false;
    }
    cfg.url = response.url;
    cfg.secret = response.secret;
    cfg.dir = response.dir;
    cfg.root = String(response.dir || '').replace(/[\\/]+$/, '');
    cfg.staging = String(response.staging || '').replace(/[\\/]+$/, '');
    cfg.stagingWritable = null; // 由诊断结果更新
    cfg.version = response.version || '';
    cfg.ready = true;
    learnBridge(response);
    setLog(
      `aria2 ${cfg.version} 就绪（端口 ${response.port}${response.reused ? '，复用已有实例' : ''}，独立模式）`
    );
    await applyGlobalOptions(settings);
    return true;
  })();

  try {
    return await engineStarting;
  } finally {
    engineStarting = null;
  }
}

async function applyGlobalOptions(settings) {
  cfg.maxParallel = Math.max(1, Math.min(16, parseInt(settings.maxParallel, 10) || 8));
  cfg.blockCover = settings.blockCover !== false;
  try {
    // aria2 的全局 dir 是 staging（本地磁盘）；用户的下载根目录 cfg.dir 由原生宿主
    // 负责，不要被这里覆盖掉。cfg.root 只是 cfg.dir 去掉结尾分隔符的版本。
    const global = await rpc('aria2.getGlobalOption');
    if (global && global.dir) cfg.staging = String(global.dir).replace(/[\\/]+$/, '');
    if (cfg.dir) cfg.root = String(cfg.dir).replace(/[\\/]+$/, '');
    await rpc('aria2.changeGlobalOption', [
      { 'max-concurrent-downloads': String(cfg.maxParallel) }
    ]);
  } catch (err) {
    // 忽略：下一轮调度会再试
  }
}

// ---------------------------------------------------------------------------
// 文件名与路径（与 v1 规则保持一致）
// ---------------------------------------------------------------------------
function decodeMaybe(value) {
  let text = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    let decoded = text;
    try {
      decoded = decodeURIComponent(text);
    } catch (err) {
      // 存在非法转义时保留原文
    }
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/g, '')
    .trim();
}

function guessFilename(url) {
  let name = '';
  try {
    const parsed = new URL(url);
    const f = parsed.searchParams.get('f');
    name = f ? decodeMaybe(f) : decodeMaybe(parsed.pathname.split('/').pop() || '');
  } catch (err) {
    name = '';
  }
  name = sanitizeName(name);
  return name || `file_${Date.now()}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBlockWords(value) {
  const list = Array.isArray(value) ? value : [];
  return Array.from(new Set(list.map((word) => String(word).trim()).filter(Boolean)));
}

function applyBlockWords(text, words) {
  let result = String(text);
  for (const word of words) {
    result = result.replace(new RegExp(escapeRegExp(word), 'gi'), '');
  }
  return result
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\)\s*/g, '')
    .replace(/\s*（）\s*/g, '')
    .replace(/\s*\[\]\s*/g, '')
    .trim();
}

// 图片：pawchive/作者-平台-作者ID/帖子ID-标题/序号-文件名
// 附件：pawchive/作者-平台-作者ID/帖子ID-标题/原名
function buildPath(post, item, settings) {
  const blockWords = normalizeBlockWords(settings.blockWords);
  const authorFolder = sanitizeName(`${post.author || 'unknown'}-${post.platform}-${post.userId}`);
  const title = applyBlockWords(post.title || '', blockWords);
  const postFolder = sanitizeName(`${post.postId}-${title || 'untitled'}`);
  const base = sanitizeName(item.name) || guessFilename(item.url);
  const file = item.kind === 'file' ? base : `${item.index}-${base}`;
  return { path: `pawchive/${authorFolder}/${postFolder}/${file}`, file, postFolder };
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------
function postKeyOf(post) {
  return `${post.platform}|${post.userId}|${post.postId}`;
}

function createRecord(post, item, settings) {
  const key = postKeyOf(post);
  const built = buildPath(post, item, settings);
  seqCounter += 1;
  return {
    id: `r${Date.now().toString(36)}_${seqCounter}`,
    key,
    post: {
      platform: post.platform,
      userId: post.userId,
      postId: post.postId,
      title: post.title || '',
      author: post.author || ''
    },
    url: item.url,
    name: item.name || '',
    kind: item.kind,
    index: item.index || 0,
    path: built.path,
    file: built.file,
    seq: seqCounter,
    status: 'pending',
    gid: '',
    engineRetries: 0,
    error: ''
  };
}

// 把一条已经结束（完成/失败）的记录重新排队。
//
// 为什么复用而不是新建：同一个帖子重复点「下载」时，如果每次都新建记录，
// 队列里就会堆出重复行、帖子统计也会翻倍。复用后表现是那一行从「完成」变回
// 「排队」，与用户点按钮的直觉一致。路径/标题按**当前**设置重算。
function reviveRecord(record, post, item, settings) {
  const built = buildPath(post, item, settings);
  seqCounter += 1;
  record.post = {
    platform: post.platform,
    userId: post.userId,
    postId: post.postId,
    title: post.title || '',
    author: post.author || ''
  };
  record.url = item.url;
  record.name = item.name || '';
  record.kind = item.kind;
  record.index = item.index || 0;
  record.path = built.path;
  record.file = built.file;
  record.seq = seqCounter;
  record.status = 'pending';
  record.gid = '';
  record.engineRetries = 0;
  record.error = '';
  delete record.attemptAt;
  return record;
}

function recordsFor(key) {
  return Object.values(records).filter((r) => r.key === key);
}

function summarizePost(key) {
  const list = recordsFor(key);
  const images = list.filter((r) => r.kind === 'image');
  return {
    key,
    count: list.length,
    imageCount: images.length,
    queued: list.filter((r) => r.status === 'pending').length,
    active: list.filter((r) => r.status === 'active').length,
    done: list.filter((r) => r.status === 'done').length,
    failed: list.filter((r) => r.status === 'failed').length
  };
}

function globalSummary() {
  const list = Object.values(records);
  return {
    total: list.length,
    queued: list.filter((r) => r.status === 'pending').length,
    active: list.filter((r) => r.status === 'active').length,
    done: list.filter((r) => r.status === 'done').length,
    failed: list.filter((r) => r.status === 'failed').length
  };
}

// 把「本帖子 / 其他帖子」的**未完成**工作量算清楚。
// 注意：不能拿「记录总数 - 本帖子记录数」来推其他帖子 —— 记录数含历史
// （已完成/已失败，只有到浏览器重启才随 storage.session 清空），拿它去减
// 就会出现「本帖子已下完，其他帖子却还显示 1 个」这种多一个的现象。
// 这里统一只统计 pending/active，并且和 global 取自同一份 records 快照。
function workSummary(recordsList, key) {
  const mine = key ? recordsList.filter((r) => r.key === key) : [];
  const mineWork = mine.filter((r) => r.status === 'pending' || r.status === 'active');
  const othersWork = recordsList.filter(
    (r) => r.key !== key && (r.status === 'pending' || r.status === 'active')
  );
  return {
    mineActive: mineWork.filter((r) => r.status === 'active').length,
    mineQueued: mineWork.filter((r) => r.status === 'pending').length,
    othersActive: othersWork.filter((r) => r.status === 'active').length,
    othersQueued: othersWork.filter((r) => r.status === 'pending').length
  };
}

function notifyFailures() {
  failureStreak += 1;
  if (failureStreak < CONSECUTIVE_FAILURE_LIMIT) return;
  const now = Date.now();
  if (now - lastFailureNotifyAt < FAILURE_NOTIFY_MIN_INTERVAL_MS) return;
  lastFailureNotifyAt = now;
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create(
        'pawchive-download-failures',
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'Pawchive 下载器',
          message: `已连续 ${failureStreak} 个文件下载失败（aria2 重试后仍未成功），请检查网络或下载目录。`
        },
        () => {}
      );
    }
  } catch (err) {
    // 忽略通知错误
  }
}

// ---------------------------------------------------------------------------
// 调度核心
// ---------------------------------------------------------------------------
function activeCountsByKey() {
  const counts = new Map();
  for (const record of Object.values(records)) {
    if (record.status === 'active') {
      counts.set(record.key, (counts.get(record.key) || 0) + 1);
    }
  }
  return counts;
}

// 领取下一个待下载项：优先选择「当前进行中下载最少」的帖子，
// 这样并行名额会在多个帖子之间交错铺开，而不是被单个帖子占满。
function pump() {
  const counts = activeCountsByKey();
  let active = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const dispatched = [];

  while (active < cfg.maxParallel) {
    let best = null;
    for (const record of Object.values(records)) {
      if (record.status !== 'pending') continue;
      const load = counts.get(record.key) || 0;
      if (!best || load < best.load || (load === best.load && record.seq < best.record.seq)) {
        best = { record, load };
      }
    }
    if (!best) break;
    const { record } = best;
    record.status = 'active';
    counts.set(record.key, (counts.get(record.key) || 0) + 1);
    active += 1;
    dispatched.push(record);
  }
  return dispatched;
}

function buildDownloadParams(record) {
  const options = {
    out: record.file,
    // 千万不要伪造浏览器 UA / Referer：实测 n2.pawchive.pw 会对带
    // 浏览器 User-Agent 的请求直接返回 403（无论 referer 设成什么），
    // 用 aria2 默认 UA、不带 referer 反而正常。这些图片/附件本来就是
    // 公开资源，不需要任何鉴权头。
    'max-connection-per-server': '8',
    split: '8',
    continue: 'true'
  };
  // aria2 的 per-download `dir` 是相对「aria2 的工作目录」解析的，不是相对全局 dir
  // （实测相对路径会落到 aria2c.exe 所在的 helper 目录里）。所以这里必须用绝对路径：
  //   - 有 staging 时：绝对路径 = staging + 帖子相对目录（本地磁盘，aria2 写得进去）
  //   - 没 staging 时：退回 下载根目录 + 帖子相对目录
  const rel = record.path.split('/').slice(0, -1).join('/');
  const base = cfg.staging || cfg.root;
  if (base && rel) {
    options.dir = `${base}\\${rel.split('/').join('\\')}`;
  } else if (rel) {
    options.dir = rel;
  }
  return options;
}

// aria2 下载完成后，把文件从 staging 搬到最终归档目录（这一步在原生宿主里做，
// 因为 aria2 无法写入映射的网络盘，后端 Python 可以）。
async function moveToTarget(record) {
  const response = await bridgeCommand({
    action: 'move',
    rel: record.path,
    downloadDir: cfg.dir
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || '搬运文件失败');
  }
  return response;
}

async function dispatch(record) {
  try {
    const gid = await rpc('aria2.addUri', [[record.url], buildDownloadParams(record)]);
    // 这条记录可能在 addUri 往返期间被用户单独取消（已从 records 里删掉）。
    // 那就必须补一次 forceRemove —— 否则 aria2 会继续把它下完并留在 staging 里，
    // 而扩展这边已经没有任何记录指向它，等于一条无声的孤儿任务。
    if (!records[record.id]) {
      try {
        await rpc('aria2.forceRemove', [gid]);
      } catch (err) {
        // 已经不在了也无所谓
      }
      return false;
    }
    record.gid = gid;
    record.attemptAt = Date.now();
    tracker[gid] = {
      id: record.id,
      seq: record.seq,
      engine: 'aria2',
      startedAt: Date.now(),
      nextCheckAt: Date.now() + 900,
      checkCount: 0
    };
    return true;
  } catch (err) {
    record.status = 'pending';
    record.gid = '';
    record.error = err.message;
    setLog(`加入 aria2 失败：${err.message}`);
    return false;
  }
}

async function runCycle() {
  if (inflightPump) return;
  inflightPump = true;
  try {
    if (!cfg.ready && !(await ensureEngine())) return;

    const dispatched = pump();
    let added = 0;
    for (const record of dispatched) {
      if (await dispatch(record)) added += 1;
    }
    if (added > 0) await saveState();

    await syncWithAria2();
  } catch (err) {
    setLog(`调度异常：${err.message}`);
    if (/fetch|Failed|HTTP|aria2 未就绪/.test(String(err.message))) {
      cfg.ready = false;
    }
  } finally {
    inflightPump = false;
  }
}

// 轮询 aria2：推进状态、处理失败、广播进度
async function syncWithAria2() {
  const now = Date.now();
  const active = (await rpc('aria2.tellActive', [['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorCode', 'errorMessage', 'files']])) || [];

  const activeGids = new Set();
  let speed = 0;
  for (const item of active) {
    activeGids.add(item.gid);
    speed += Number(item.downloadSpeed || 0);
    const entry = tracker[item.gid];
    if (entry) entry.lastSeen = now;
  }
  currentSpeed = speed;

  // 完成 / 失败：不靠计数差，而是逐个查询已消失的 gid 的最终状态，
  // 避免「计数 -1」误判（例如下载被取消或被打断）。
  const finished = [];
  for (const [gid, entry] of Object.entries(tracker)) {
    if (activeGids.has(gid)) continue;
    if (now < (entry.nextCheckAt || 0)) continue;
    entry.nextCheckAt = now + CHECK_INTERVAL_MS;
    entry.checkCount = (entry.checkCount || 0) + 1;

    let status = null;
    try {
      status = await rpc('aria2.tellStatus', [gid]);
    } catch (err) {
      // 状态查不到（例如 aria2 重启过），按丢失处理
      status = null;
    }

    if (status && status.status === 'complete') {
      finished.push({ gid, entry, ok: true });
    } else if (status && (status.status === 'error' || status.status === 'removed')) {
      finished.push({ gid, entry, ok: false, error: describeAria2Error(status) });
    } else if (!status && entry.checkCount >= 2) {
      finished.push({ gid, entry, ok: false, error: 'aria2 中已丢失该任务' });
    } else if (status && entry.checkCount >= 2) {
      finished.push({ gid, entry, ok: false, error: status.errorMessage || '未知状态' });
    }
  }

  let changed = false;
  for (const item of finished) {
    delete tracker[item.gid];
    const record = records[item.entry.id];
    changed = true;
    if (!record) continue;
    if (item.ok) {
      // 先从 staging 搬到目标目录；搬运失败同样按失败处理（会自动重试，
      // 重试时 aria2 发现 staging 里已有完整文件会秒过，只会重试搬运）
      try {
        await moveToTarget(record);
        record.status = 'done';
        record.gid = '';
        record.error = '';
        failureStreak = 0;
      } catch (err) {
        record.error = `文件已下载但搬运失败：${err.message}`;
        if (record.engineRetries < MAX_ENGINE_RETRIES) {
          record.engineRetries += 1;
          record.status = 'pending';
          record.gid = '';
          record.seq = seqCounter + 1;
          seqCounter += 1;
        } else {
          record.status = 'failed';
          record.gid = '';
          notifyFailures();
        }
      }
    } else if (record.status === 'cancelled') {
      // 用户取消，不算失败
    } else if (record.engineRetries < MAX_ENGINE_RETRIES) {
      record.engineRetries += 1;
      record.status = 'pending';
      record.gid = '';
      record.error = item.error;
      record.seq = seqCounter + 1; // 重试排到队尾，不阻塞其他文件
      seqCounter += 1;
      setLog(`重试（第 ${record.engineRetries} 次）：${record.file} — ${item.error}`);
    } else {
      record.status = 'failed';
      record.gid = '';
      record.error = item.error;
      notifyFailures();
    }
  }

  // 兜底：交给 aria2 后长时间查不到状态的任务（例如 addUri 成功但 aria2 立刻重启）
  for (const [gid, entry] of Object.entries(tracker)) {
    if (entry.checkCount) continue;
    const record = records[entry.id];
    if (!record || record.status !== 'active') continue;
    if (now - entry.startedAt > STALL_TIMEOUT_MS) {
      delete tracker[gid];
      record.status = 'pending';
      record.gid = '';
      changed = true;
      setLog(`任务超时重置：${record.file}`);
    }
  }

  if (changed) await saveState();
}

// ---------------------------------------------------------------------------
// 循环控制：有活干就用自排队定时器高频推进，没活干就停
// ---------------------------------------------------------------------------
function hasWork() {
  return Object.values(records).some((r) => r.status === 'pending' || r.status === 'active');
}

function scheduleTick() {
  if (tickTimer !== null) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    tick().catch(() => {});
  }, TICK_MS);
}

async function tick() {
  if (!hasWork()) {
    downloading = false;
    await chrome.alarms.clear(ALARM_TICK);
    await broadcast();
    return;
  }
  await runCycle();
  await broadcast();
  // 队列还没清空就继续排下一跳
  if (hasWork()) scheduleTick();
}

// 标签页关闭时清掉它上报的 key
chrome.tabs.onRemoved.addListener((tabId) => {
  tabKeys.delete(tabId);
});

// 兜底心跳：SW 被回收或浏览器重启后，靠它把循环重新拉起来
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_TICK) return;
  tick().catch(() => {});
});

async function ensureLoop() {
  // 高频心跳：alarms 的最小周期是 30 秒，只用来做恢复兜底
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: ALARM_RECOVERY_MINUTES });
  if (!hasWork()) return;
  downloading = true;
  scheduleTick();
  await broadcast();
}

chrome.runtime.onStartup.addListener(() => {
  ensureLoop().catch(() => {});
});

// ---------------------------------------------------------------------------
// 进度广播
// ---------------------------------------------------------------------------
let lastBroadcast = '';
let broadcastTimer = null;

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast().catch(() => {});
  }, 900);
}

async function broadcast() {
  const list = Object.values(records);
  const posts = {};
  for (const record of list) {
    const entry =
      posts[record.key] ||
      { key: record.key, post: record.post, total: 0, active: 0, done: 0, failed: 0, queued: 0 };
    entry.total += 1;
    entry[record.status === 'pending' ? 'queued' : record.status] += 1;
    posts[record.key] = entry;
  }
  const global = globalSummary();

  const postList = Object.values(posts);
  const signature = JSON.stringify([cfg.ready, cfg.version, cfg.dir, cfg.maxParallel, currentSpeed, global, postList, lastLog]);
  if (signature === lastBroadcast) return;
  lastBroadcast = signature;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    return;
  }
  // 每个帖子 key 的 work 只算一次（同一条消息内所有字段都取自同一份 list）
  const workCache = new Map();
  for (const tab of tabs) {
    if (tab.id == null) continue;
    // 不在这里从 tab.url 现推 key —— 内容脚本自己知道当前帖子的 key，
    // 由它随 PD_GET_STATUS 报上来。
    const tabKey = tabKeys.get(tab.id);
    // ★ 没有 key 就不发 work（发 null）。
    //   以前这里发的是「按空 key 算出来的 work」，那会把本帖子自己的在途文件
    //   算进「其他帖子」，于是面板在「本帖子：1/2 完成，下载中 1」和
    //   「其他帖子：1 个文件（排队中）」之间来回跳（本帖子 0/1 那半边就是这么来的）。
    //   tabKeys 是异步填的（内容脚本 5 秒补报一次），冷启动/刚切页面时确实会短暂没有，
    //   所以这里必须容错，而不是拿空 key 硬算。
    let work = null;
    if (tabKey) {
      if (!workCache.has(tabKey)) workCache.set(tabKey, workSummary(list, tabKey));
      work = workCache.get(tabKey);
    }
    const payload = {
      type: 'PD_STATUS',
      key: tabKey || '',
      engine: engineSummary(),
      log: lastLog,
      global,
      work,
      posts: postList
    };
    try {
      await chrome.tabs.sendMessage(tab.id, payload);
    } catch (err) {
      // 该标签页没有内容脚本，忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 消息处理
// ---------------------------------------------------------------------------
function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item.url === 'string' && /^https?:/i.test(item.url))
    .map((item) => ({
      url: item.url,
      name: typeof item.name === 'string' ? item.name : '',
      kind: item.kind === 'file' ? 'file' : 'image',
      index: Number(item.index) || 0
    }));
}

async function handleEnqueue(message) {
  const post = message.post || {};
  const items = normalizeItems(message.items);
  if (!post.platform || !post.postId || items.length === 0) {
    return { ok: false, error: '没有可下载的文件' };
  }
  if (!(await ensureEngine())) {
    return { ok: false, error: lastLog || 'aria2 引擎不可用' };
  }

  const settings = await getSettings();
  const key = postKeyOf(post);
  // 「允许重新下载」开关（默认开）：关掉时已完成的同一文件会被跳过，
  // 表现与旧版一致（防止重复下载、避免目标目录里堆出 xxx (1).ext）。
  const allowRedownload = settings.allowRedownload !== false;

  // 同一帖子的同一个 URL：
  //   - 排队中 / 下载中 → 永远跳过（避免重复入队）
  //   - 已完成         → 开关开：**复活**那条记录重新排队；开关关：跳过并计数
  //   - 失败           → 总是复活重下（失败不算"已下载"，不受开关影响）
  // 以前不看开关，把 done 一律当重复跳过，于是"一键下载完成后再点没反应"。
  const inFlight = new Set(
    recordsFor(key)
      .filter((r) => r.status === 'pending' || r.status === 'active')
      .map((r) => r.url)
  );
  const doneByUrl = new Map();
  const failedByUrl = new Map();
  for (const record of recordsFor(key)) {
    if (record.status === 'done') doneByUrl.set(record.url, record);
    else if (record.status === 'failed') failedByUrl.set(record.url, record);
  }

  let added = 0;
  let skippedDone = 0;
  for (const item of items) {
    if (inFlight.has(item.url)) continue;
    inFlight.add(item.url);

    const done = doneByUrl.get(item.url);
    if (done && !allowRedownload) {
      skippedDone += 1; // 已在本地下过，且用户关掉了「允许重新下载」
      continue;
    }
    const finished = done || failedByUrl.get(item.url);
    if (finished) {
      // 同一批里重复出现的 URL 只复活一次
      doneByUrl.delete(item.url);
      failedByUrl.delete(item.url);
      reviveRecord(finished, post, item, settings);
      added += 1;
      continue;
    }

    const record = createRecord(post, item, settings);
    records[record.id] = record;
    added += 1;
  }
  if (added === 0) {
    return {
      ok: true,
      added: 0,
      duplicate: true,
      skippedDone,
      summary: summarizePost(key)
    };
  }

  await saveState();
  await ensureLoop();
  return { ok: true, added, summary: summarizePost(key) };
}

async function handleDownloadOne(message) {
  const post = message.post || {};
  const items = normalizeItems(message.items);
  if (!post.platform || !post.postId || items.length === 0) {
    return { ok: false, error: '没有可下载的文件' };
  }
  if (!(await ensureEngine())) {
    return { ok: false, error: lastLog || 'aria2 引擎不可用' };
  }
  const item = items[0];

  // 单文件下载允许覆盖已完成的同 URL 记录（用户可能想重新下）
  const key = postKeyOf(post);
  for (const record of recordsFor(key)) {
    if (record.url === item.url && record.status === 'done') delete records[record.id];
  }

  const settings = await getSettings();
  const record = createRecord(post, item, settings);
  record.priority = true;
  records[record.id] = record;
  await saveState();
  await ensureLoop();
  return { ok: true, added: 1, file: record.file };
}

// 队列空了就撤掉定时器/alarm，别让 SW 白白醒着
async function clearAlarmIfIdle() {
  if (hasWork()) return;
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  downloading = false;
  try {
    await chrome.alarms.clear(ALARM_TICK);
  } catch (err) {
    // 忽略
  }
}

// 把一个文件从队列里摘掉：先删记录（pump 立刻能拿到空出来的名额），
// 再断掉 aria2 里的任务（进行中的要 forceRemove，否则只是移出等待队列）。
async function dropRecord(record) {
  delete records[record.id];
  if (!record.gid) return;
  try {
    await rpc('aria2.forceRemove', [record.gid]);
  } catch (err) {
    // gid 已经结束/被移除时这里会报错，忽略
  }
  delete tracker[record.gid];
}

async function handleCancel(message) {
  const key = message.key;
  const victims = Object.values(records).filter(
    (r) => r.key === key && (r.status === 'pending' || r.status === 'active')
  );

  for (const record of victims) await dropRecord(record);

  if (victims.length > 0) setLog(`已取消 ${victims.length} 个文件`);
  await saveState();
  await clearAlarmIfIdle();
  await broadcast();
  return { ok: true, cancelled: victims.length };
}

// 单文件取消：弹窗队列里每一行的「✕」走这里。
// 排队中的直接移除；下载中的先 forceRemove 断连接再移除（与「中止全部」同语义）。
async function handleCancelOne(message) {
  const id = typeof message.id === 'string' ? message.id : '';
  const record = id ? records[id] : null;
  if (!record) return { ok: false, error: '该文件已经不在队列里（可能已完成或已被取消）' };
  if (record.status === 'done' || record.status === 'failed') {
    return { ok: false, error: '该文件已经结束，不需要取消' };
  }

  const wasActive = record.status === 'active';
  const file = record.file;
  await dropRecord(record);
  setLog(wasActive ? `已取消下载：${file}` : `已取消排队：${file}`);

  await saveState();
  await clearAlarmIfIdle();
  await broadcast();
  return { ok: true, file, wasActive };
}

async function handleCancelAll() {
  const victims = Object.values(records).filter(
    (r) => r.status === 'pending' || r.status === 'active'
  );

  for (const record of victims) await dropRecord(record);

  if (victims.length > 0) setLog(`已中止全部下载（${victims.length} 个文件）`);
  await saveState();
  await clearAlarmIfIdle();
  await broadcast();
  return { ok: true, cancelled: victims.length };
}

async function handleStatus(message, sender) {
  // 内容脚本会上报它认定的帖子 key，存下来给广播用（保证两边口径一致）
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  if (senderTabId != null && typeof message.key === 'string') {
    if (message.key) tabKeys.set(senderTabId, message.key);
    else tabKeys.delete(senderTabId);
  }

  const list = Object.values(records);
  const key = typeof message.key === 'string' ? message.key : '';
  const result = {
    type: 'PD_GET_STATUS',
    // ★ 回带本次计算所用的 key：前端的 lastWork 是跨消息累積的状态
    //   （广播里可能没有 work），带上 key 前端才能判断这份 work 是不是
    //   属于当前这个帖子，避免把别的帖子的 work 当自己的用。
    key,
    engine: engineSummary(),
    log: lastLog,
    // work 与 global 取自同一份 list，内容和时序都对得上，前端直接用即可
    work: workSummary(list, key),
    global: globalSummary()
  };
  if (key) {
    result.post = summarizePost(key);
  }
  if (message.queue) {
    // 供弹窗展示「当前下载/排队列表」：先按帖子、再按排队顺序
    result.queue = Object.values(records)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.seq - b.seq))
      .map((r) => {
        const post = r.post;
        return {
          id: r.id,
          key: r.key,
          file: r.file,
          kind: r.kind,
          status: r.status,
          error: r.error || '',
          post: { platform: post.platform, userId: post.userId, postId: post.postId }
        };
      });
  }
  return result;
}

async function handleEngineStart() {
  // 用户手动点「启动 aria2」意味着环境可能变了（比如刚用管理员权限起了辅助程序），
  // 所以重置桥的缓存，让它重新探测一次，而不是继续吃冷却期的旧结论。
  bridge.lastError = '';
  cfg.ready = false;
  const ok = await ensureEngine();
  if (ok) await ensureLoop();
  return { ok, log: lastLog, engine: engineSummary() };
}

// 让宿主逐个候选目录做 aria2 级写入探测，把结论显示到弹窗上。
// 这类问题（staging 不可写）必须让 aria2 自己试，Python 能写不算数。
async function handleDiagnose() {
  try {
    const response = await hostDiagnose();
    return response || { ok: false, error: '宿主无响应' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 设置变更：只把并行数同步给 aria2，不动引擎状态（重启引擎会打断下载）
async function handleApplySettings() {
  const settings = await getSettings();
  if (cfg.ready) await applyGlobalOptions(settings);
  return {
    ok: true,
    log: lastLog,
    engine: engineSummary()
  };
}

async function handleClearFinished() {
  for (const record of Object.values(records)) {
    if (record.status === 'done' || record.status === 'failed' || record.status === 'cancelled') {
      delete records[record.id];
    }
  }
  await saveState();
  await broadcast();
  return { ok: true, global: globalSummary() };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return undefined;

  const run = async () => {
    switch (message.type) {
      case 'PD_ENQUEUE':
        return handleEnqueue(message);
      case 'PD_DOWNLOAD_ONE':
        return handleDownloadOne(message);
      case 'PD_CANCEL':
        return handleCancel(message);
      case 'PD_CANCEL_ONE':
        return handleCancelOne(message);
      case 'PD_CANCEL_ALL':
        return handleCancelAll();
      case 'PD_GET_STATUS':
        return handleStatus(message, sender);
      case 'PD_ENGINE_START':
        return handleEngineStart();
      case 'PD_APPLY_SETTINGS':
        return handleApplySettings();
      case 'PD_DIAGNOSE':
        return handleDiagnose();
      case 'PD_CLEAR_FINISHED':
        return handleClearFinished();
      default:
        return undefined;
    }
  };

  run()
    .then((result) => sendResponse(result || { ok: false, error: '未知请求' }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // 异步响应
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(async () => {
  await loadState();
  // 上次 SW 被回收时可能留下「进行中」的孤立记录：aria2 里若已没有对应
  // gid，syncWithAria2 会在两轮内把它们重置为 pending 或标记失败。
  const orphan = Object.values(records).filter((r) => r.status === 'active' && !tracker[r.gid]);
  for (const record of orphan) {
    record.status = 'pending';
    record.gid = '';
  }
  if (orphan.length) await saveState();
  if (hasWork()) {
    await ensureEngine();
    await ensureLoop();
  }
})();
