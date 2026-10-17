// 弹窗：aria2 引擎状态 + 下载设置 + 全局队列一览
'use strict';

const $ = (selector) => document.querySelector(selector);

// 「标题屏蔽字」默认值：与弹窗里的示例内容一致（装好即生效、不必先手填）。
// 空数组是有效值 —— 用户清空并保存后就该什么都不屏蔽，所以这里只在
// storage 里没有这个键时才用默认值（chrome.storage.sync.get 的语义）。
const DEFAULT_BLOCK_WORDS = ['(Pixiv Fanbox)', 'patreon'];

const DEFAULT_SETTINGS = {
  skipFirst: 0,
  skipLast: 0,
  maxParallel: 8,
  blockWords: DEFAULT_BLOCK_WORDS.slice(),
  downloadDir: '',
  blockCover: true,
  // 已完成的同一文件再点下载时是否允许重新下（默认开）
  allowRedownload: true
};

let lastStatus = null;
let statusPoll = null;
let autoStartRequested = false;
let currentPostKey = ''; // 当前标签页的帖子 key，用于把「其他帖子」算准

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
function loadSettings() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
    $('#skipFirst').value = settings.skipFirst;
    $('#skipLast').value = settings.skipLast;
    $('#maxParallel').value = settings.maxParallel;
    $('#downloadDir').value = settings.downloadDir || '';
    $('#blockWords').value = (settings.blockWords || []).join('\n');
    $('#blockCover').checked = settings.blockCover !== false;
    // 老版本没有这个键 → 默认开
    $('#allowRedownload').checked = settings.allowRedownload !== false;
  });
}

function parseCount(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function saveSettings() {
  const skipFirst = parseCount($('#skipFirst').value);
  const skipLast = parseCount($('#skipLast').value);
  const maxParallel = Math.min(16, Math.max(1, parseCount($('#maxParallel').value) || 8));
  const downloadDir = $('#downloadDir').value.trim();
  const blockWords = Array.from(
    new Set(
      $('#blockWords')
        .value.split(/[\r\n,，]+/)
        .map((word) => word.trim())
        .filter(Boolean)
    )
  );
  const blockCover = $('#blockCover').checked;
  const allowRedownload = $('#allowRedownload').checked;

  await chrome.storage.sync.set({
    skipFirst,
    skipLast,
    maxParallel,
    downloadDir,
    blockWords,
    blockCover,
    allowRedownload
  });

  $('#skipFirst').value = skipFirst;
  $('#skipLast').value = skipLast;
  $('#maxParallel').value = maxParallel;
  $('#downloadDir').value = downloadDir;
  $('#blockWords').value = blockWords.join('\n');
  $('#blockCover').checked = blockCover;
  $('#allowRedownload').checked = allowRedownload;

  // 并行数改动立即同步给 aria2，不必重启引擎
  chrome.runtime.sendMessage({ type: 'PD_APPLY_SETTINGS' });
  const status = $('#saveStatus');
  status.textContent = '✅ 已保存';
  setTimeout(() => {
    status.textContent = '';
  }, 1600);
}

// ---------------------------------------------------------------------------
// 当前标签页
// ---------------------------------------------------------------------------
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function isTargetSite(url) {
  return !!url && /^https?:\/\/([a-z0-9-]+\.)*(pawchive|kemono)\.(pw|su|party)\//.test(url);
}

// 站点内的「帖子页」判断（与 content.js 的 POST_PATH_RE 保持一致）
const POST_PATH_RE = /\/([a-z0-9_-]+)\/user\/(\d+)\/post\/(\d+)/i;

function isPostUrl(url) {
  try {
    return POST_PATH_RE.test(new URL(url).pathname);
  } catch (err) {
    return false;
  }
}

// 弹窗打开时决定「当前帖子」这块要不要显示。
//
// 以前这里不管在哪个页面都固定写一句「未检测到 pawchive/kemono 帖子页面」——
// 设置页大多数时候都开在别的网站上，那行字纯属噪声。现在：
//   - 非目标站点：整块隐藏；
//   - 站内非帖子页：只给一句中性提示（没有东西可下，按钮也收起来）；
//   - 帖子页：显示下载目录 + 图片数 + 队列情况。
async function refreshPostInfo(retried) {
  const section = $('#postSection');
  const infoEl = $('#postInfo');
  const downloadBtn = $('#downloadBtn');
  const dlStatus = $('#dlStatus');
  if (!infoEl || !downloadBtn) return;

  const showBlock = (visible) => {
    if (section) section.hidden = !visible;
  };
  const setInfo = (text, kind) => {
    infoEl.textContent = text || '';
    infoEl.classList.toggle('warn', kind === 'warn');
    infoEl.classList.toggle('hint', kind === 'hint');
  };

  const tab = await getActiveTab();
  const url = (tab && tab.url) || '';

  if (!isTargetSite(url)) {
    // 设置页在别的网站上打开：不显示任何"未检测到"的提示
    showBlock(false);
    downloadBtn.disabled = true;
    currentPostKey = '';
    return;
  }

  if (!isPostUrl(url)) {
    showBlock(true);
    setInfo('当前不是帖子页面：打开某个帖子后，可以在这里一键下载整帖。', 'hint');
    downloadBtn.hidden = true;
    if (dlStatus) dlStatus.textContent = '';
    currentPostKey = '';
    return;
  }

  // 帖子页：问内容脚本要当前帖子的信息
  showBlock(true);
  downloadBtn.hidden = false;
  chrome.tabs.sendMessage(tab.id, { type: 'PD_GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.post) {
      // 内容脚本没就绪（典型场景：扩展刚重载/刚安装，页面上的脚本还没刷新）。
      // 刚打开弹窗时内容脚本可能还在 300ms 防抖里，给一次重试机会。
      if (!retried) {
        setTimeout(() => refreshPostInfo(true), 600);
        return;
      }
      setInfo('页面还没就绪：刷新一下这个帖子页，再点扩展图标。', 'warn');
      downloadBtn.disabled = true;
      return;
    }

    currentPostKey = `${response.post.platform}|${response.post.userId}|${response.post.postId}`;
    // 未存档帖子只有缩略图：按钮文案/配色跟着换，别让弹窗和面板说的不一样
    const unarchived = !!response.post.unarchived;
    downloadBtn.textContent = unarchived ? '下载当前帖子全部缩略图' : '下载当前帖子全部图片';
    downloadBtn.classList.toggle('thumb', unarchived);
    downloadBtn.title = unarchived ? '该帖子尚未存档，只能下载缩略图' : '';
    // count 现在特指「仍在队列里（排队+下载中）」的数量，不含已完成的历史记录，
    // 否则会出现「已经在队列 2 个」但其实只剩 1 个在下的多一个现象。
    const queuedNow = response.post.count || 0;
    const finished = (response.post.done || 0) + (response.post.failed || 0);
    const lines = [];
    // 内容脚本的响应里带 engine（下载目录）。老版本内容脚本没有这个字段，
    // 这里必须容错 —— 之前直接读 response.engine.dir，帖子页上会抛异常，
    // 结果整段文案永远停在 HTML 里那句初始文本上。
    const dir = (response.engine && response.engine.dir) || '';
    if (dir) lines.push(dir);
    lines.push(
      `${unarchived ? '缩略图' : '图片'} ${response.post.imageCount} 张` +
        (queuedNow ? `，队列中 ${queuedNow} 个` : '，队列为空') +
        (finished ? `（本次已完成 ${finished}）` : '')
    );
    setInfo(lines.join('\n'), '');
    downloadBtn.disabled = false;
  });
}

// ---------------------------------------------------------------------------
// 队列与引擎状态
// ---------------------------------------------------------------------------
function renderStatus(status) {
  lastStatus = status;

  const engine = status.engine || {};
  const badge = $('#engineBadge');
  const info = $('#engineInfo');
  const startBtn = $('#engineStart');

  if (engine.ready) {
    badge.textContent = `就绪 v${engine.version || '?'}`;
    badge.className = 'badge badge--ok';
    const speed = Number(engine.speed) || 0;
    const speedText =
      speed > 0
        ? speed > 1024 * 1024
          ? ` · ${(speed / 1024 / 1024).toFixed(1)} MB/s`
          : ` · ${(speed / 1024).toFixed(0)} KB/s`
        : '';
    info.textContent =
      `并行 ${engine.maxParallel || '?'}${speedText}\n下载根目录：${engine.dir || '(默认)'}`;
    startBtn.style.display = 'none';
  } else {
    badge.textContent = '未就绪';
    badge.className = 'badge badge--warn';
    // 浏览器已经不允许再拉起 aria2（那样启动的进程没有提升权限、写盘必失败），
    // 所以这里直接告诉用户该去启动辅助程序。
    info.textContent =
      (status.log ? status.log + '\n' : '') +
      '请双击 helper\\run-as-admin.cmd（UAC 点「是」）并保持窗口打开，然后点下面的按钮重试。';
    startBtn.style.display = '';
    startBtn.textContent = '重新连接辅助程序';
  }

  // 临时目录：aria2 只能写本地磁盘，这里显出来便于排查 403/权限类失败
  const stagingEl = $('#stagingInfo');
  if (engine.staging) {
    stagingEl.textContent = `aria2 临时目录：${engine.staging}`;
  } else {
    stagingEl.textContent = '';
  }

  const global = status.global || { total: 0, queued: 0, active: 0, done: 0, failed: 0 };
  const activeTotal = global.queued + global.active;
  const queueBadge = $('#queueBadge');
  queueBadge.textContent = activeTotal > 0 ? `进行中 ${activeTotal}` : '空闲';
  queueBadge.className = 'badge' + (activeTotal > 0 ? ' badge--ok' : '');
  $('#queueSummary').textContent =
    `合计 ${global.total} 个文件：完成 ${global.done}，失败 ${global.failed}，` +
    `下载中 ${global.active}，排队 ${global.queued}`;
  $('#cancelAll').disabled = activeTotal === 0;

  renderFileList(status.queue || []);
}

const STATUS_LABEL = {
  pending: '排队',
  active: '下载中',
  done: '完成',
  failed: '失败'
};

// 正在等待后台响应的单文件取消请求（列表每秒重绘，靠它保持按钮禁用状态）
const cancellingIds = new Set();
let queueMsgTimer = null;

function showQueueMessage(text, kind) {
  const el = $('#queueMsg');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
  if (queueMsgTimer) clearTimeout(queueMsgTimer);
  queueMsgTimer = null;
  if (!text) return;
  queueMsgTimer = setTimeout(() => {
    queueMsgTimer = null;
    el.textContent = '';
  }, 4000);
}

// 只改这一个按钮的状态（不重绘整个列表：重绘会把按钮节点换掉，还会丢焦点）
function setCancelButtonBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? '…' : '✕';
  btn.title = busy ? '正在取消…' : '取消这个文件的下载';
}

// 取消单个文件：排队中的直接移出队列；下载中的请后台 forceRemove 断掉连接。
function cancelOneFile(record, btn) {
  if (!record || cancellingIds.has(record.id)) return;
  cancellingIds.add(record.id);
  setCancelButtonBusy(btn, true);
  showQueueMessage(`正在取消：${record.file}`, 'info');

  chrome.runtime.sendMessage({ type: 'PD_CANCEL_ONE', id: record.id }, (response) => {
    cancellingIds.delete(record.id);
    setCancelButtonBusy(btn, false);
    if (chrome.runtime.lastError || !response) {
      showQueueMessage('取消失败：无法连接后台', 'warn');
    } else if (!response.ok) {
      showQueueMessage(`取消失败：${response.error || '未知原因'}`, 'warn');
    } else {
      showQueueMessage(`已取消：${response.file || record.file}`, 'ok');
    }
    refreshQueueStatus();
  });
}

function renderFileList(records) {
  const list = $('#fileList');
  list.textContent = '';

  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'files__empty';
    empty.textContent = '当前没有排队或下载中的文件。';
    list.appendChild(empty);
    return;
  }

  let currentKey = '';
  for (const record of records) {
    if (record.key !== currentKey) {
      currentKey = record.key;
      const group = document.createElement('div');
      group.className = 'files__group';
      const samePost = records.filter((r) => r.key === record.key);
      const finished = samePost.filter((r) => r.status === 'done' || r.status === 'failed').length;
      group.textContent =
        `${record.post.platform}/${record.post.postId}　${finished}/${samePost.length}`;
      list.appendChild(group);
    }

    const row = document.createElement('div');
    row.className = 'files__row';

    const dot = document.createElement('span');
    dot.className = `files__dot files__dot--${record.status}`;
    dot.title = record.error || STATUS_LABEL[record.status] || record.status;

    const name = document.createElement('span');
    name.className = 'files__name';
    name.textContent = record.file;
    name.title = record.error ? `${record.file}\n${record.error}` : record.file;

    const meta = document.createElement('span');
    meta.className = 'files__meta';
    meta.textContent =
      record.status === 'failed'
        ? '失败'
        : STATUS_LABEL[record.status] || record.status;

    row.append(dot, name, meta);

    // 只有还没结束的文件才给取消按钮（已完成/失败的用「清除已完成」）
    if (record.status === 'pending' || record.status === 'active') {
      const busy = cancellingIds.has(record.id);
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'files__cancel';
      cancelBtn.textContent = busy ? '…' : '✕';
      cancelBtn.title = busy ? '正在取消…' : '取消这个文件的下载';
      cancelBtn.setAttribute('aria-label', `取消下载 ${record.file}`);
      cancelBtn.disabled = busy;
      cancelBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelOneFile(record, cancelBtn);
      });
      row.appendChild(cancelBtn);
    }

    list.appendChild(row);
  }
}

function refreshQueueStatus() {
  chrome.runtime.sendMessage({ type: 'PD_GET_STATUS', queue: true, key: currentPostKey }, (response) => {
    if (chrome.runtime.lastError || !response || !response.engine) return;
    renderStatus(response);
    // 打开弹窗时顺手把引擎拉起来，省得先去点一次下载
    if (!response.engine.ready && !autoStartRequested) {
      autoStartRequested = true;
      chrome.runtime.sendMessage({ type: 'PD_ENGINE_START' }, () => refreshQueueStatus());
    }
  });
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
$('#save').addEventListener('click', () => {
  saveSettings().catch((err) => {
    $('#saveStatus').textContent = '保存失败：' + err.message;
  });
});

$('#engineStart').addEventListener('click', () => {
  const badge = $('#engineBadge');
  badge.textContent = '连接中…';
  $('#engineInfo').textContent = '正在连接辅助程序（127.0.0.1:16850）…';
  chrome.runtime.sendMessage({ type: 'PD_ENGINE_START' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      $('#engineInfo').textContent = '启动失败：无法连接后台';
      return;
    }
    refreshQueueStatus();
    refreshPostInfo();
  });
});

$('#downloadBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'PD_DOWNLOAD_ALL' }, (response) => {
    const status = $('#dlStatus');
    if (chrome.runtime.lastError || !response) {
      status.textContent = '无法连接页面，请刷新后重试';
      return;
    }
    status.textContent = response.ok ? '已开始下载，可在页面悬浮面板查看进度' : response.error || '发送失败';
  });
});

$('#diagnose').addEventListener('click', () => {
  const out = $('#diagInfo');
  out.textContent = '正在用 aria2 逐个探测…';
  chrome.runtime.sendMessage({ type: 'PD_DIAGNOSE' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      out.textContent = '诊断失败：' + ((response && response.error) || '无响应');
      return;
    }
    const lines = [];
    const side = response.extensionSide || {};
    if (side.via) lines.push(`当前通道：${side.via}`);
    if (typeof response.bridgeElevated === 'boolean') {
      lines.push(
        `辅助程序权限：${response.bridgeElevated ? '管理员' : '普通权限'}` +
          (response.bridgeElevated ? '' : '（aria2 会写盘失败，请改用 run-as-admin.cmd）')
      );
    }
    if (response.runtimeDir) lines.push(`aria2 当前使用：${response.runtimeDir}`);
    lines.push('候选临时目录（aria2 实测写入）：');
    const allBad = (response.candidates || []).length > 0 &&
      (response.candidates || []).every((c) => !c.aria2Writable);
    for (const item of response.candidates || []) {
      lines.push(`  ${item.aria2Writable ? '✅ 可写' : '❌ 不可写'}  ${item.path}`);
    }
    if (response.hint) lines.push(response.hint);
    if (allBad) {
      lines.push('');
      lines.push('→ 关键：要以「候选是否可写」为准。若桥已是管理员但仍全部不可写，');
      lines.push('  说明复用到了没提权的旧 aria2c.exe（需先结束它再重新启动）。');
    }
    lines.push('说明：宿主（Python）能写 ≠ aria2 能写，所以这里必须由 aria2 自己试。');
    out.textContent = lines.join('\n');
    out.style.whiteSpace = 'pre-line';
  });
});

$('#clearFinished').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'PD_CLEAR_FINISHED' }, () => {
    refreshQueueStatus();
  });
});

$('#cancelAll').addEventListener('click', () => {
  const btn = $('#cancelAll');
  btn.disabled = true;
  btn.textContent = '正在中止…';
  chrome.runtime.sendMessage({ type: 'PD_CANCEL_ALL' }, (response) => {
    btn.textContent = '中止全部下载';
    if (chrome.runtime.lastError || !response) {
      $('#queueSummary').textContent = '中止失败：无法连接后台';
      refreshQueueStatus();
      return;
    }
    refreshQueueStatus();
    setTimeout(refreshQueueStatus, 400);
  });
});

loadSettings();
refreshPostInfo();
refreshQueueStatus();
statusPoll = setInterval(refreshQueueStatus, 1000);
window.addEventListener('unload', () => {
  if (statusPoll) clearInterval(statusPoll);
});
