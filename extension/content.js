// 内容脚本：识别帖子页面、注入悬浮面板、收集图片与附件、接管链接点击。
// 下载本身由后台 Service Worker 通过 aria2 完成，这里只负责「告诉后台下什么」。
'use strict';

(() => {
  if (window.__pawchiveDownloaderInstalled) return;
  window.__pawchiveDownloaderInstalled = true;

  const POST_PATH_RE = /^\/([a-z0-9_-]+)\/user\/(\d+)\/post\/(\d+)/i;
  const THUMB_STRIP_ID = 'pd-thumbs';
  const PANEL_NAV_ID = 'pd-nav';

  let cachedBlockWords = [];

  // -------------------------------------------------------------------------
  // 广告 / 弹窗拦截
  // -------------------------------------------------------------------------
  // 站点会在页面里注入第三方弹窗脚本（实测 excavatenearbywand.com 的
  // on.js / profile.min.js，混淆过的 popunder），点页面任意位置就会弹出
  // phonydepth.com 的 iframe。这些地址在 rules.json 里已经被网络层拦掉；
  // 这里再做一层防御，覆盖「域名被换掉」的情况。
  const AD_BLOCK_ENABLED = true;
  const AD_HOST_PATTERNS = [
    /(^|\.)excavatenearbywand\.com$/i,
    /(^|\.)phonydepth\.com$/i,
    /(^|\.)onclickads\.net$/i,
    /(^|\.)popads\.net$/i,
    /(^|\.)popcash\.net$/i,
    /(^|\.)propellerads\.com$/i,
    /(^|\.)propellerpops\.com$/i,
    /(^|\.)adcash\.com$/i,
    /(^|\.)clickadu\.com$/i,
    /(^|\.)exoclick\.com$/i,
    /(^|\.)juicyads\.com$/i,
    /(^|\.)trafficjunky\.net$/i,
    /(^|\.)adsterra\.com$/i,
    /(^|\.)hilltopads\.net$/i
  ];

  function hostOf(url) {
    try {
      return new URL(String(url), location.href).hostname;
    } catch (err) {
      return '';
    }
  }

  function isAdUrl(url) {
    if (!url) return false;
    const text = String(url);
    if (text === 'about:blank' || text.startsWith('javascript:')) return false;
    const host = hostOf(text);
    if (!host) return false;
    return AD_HOST_PATTERNS.some((re) => re.test(host));
  }

  function installAdBlock() {
    if (!AD_BLOCK_ENABLED) return;
    if (window.__pdAdBlockInstalled) return;
    window.__pdAdBlockInstalled = true;

    // 1) 弹窗：真正拦截 window.open 的是主世界脚本 main-guard.js
    //    （隔离世界 patch window.open 对页面脚本无效，两者是不同 window）。
    //    这里负责「预授权」：用户真的点了某个链接时，把目标 URL 报给主世界，
    //    主世界只放行预授权过的地址，其余跨域弹窗一律拒绝。
    function preAuthorize(url) {
      if (!url) return;
      const message = { __pdAuth: 'pawchive-downloader', url: String(url) };
      try {
        // 顶层窗口，以及所有子 frame（主世界 guard 在每个 frame 里都装了一份）
        window.postMessage(message, location.origin);
        for (let i = 0; i < window.frames.length; i += 1) {
          try {
            window.frames[i].postMessage(message, location.origin);
          } catch (err) {
            // 跨域 frame 发不过去，忽略
          }
        }
      } catch (err) {
        // 忽略
      }
    }

    function preAuthorizeFromEvent(event) {
      const anchor =
        event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      // 只预授权站内/附件这类真实链接，且排除广告黑名单
      if (isAdUrl(anchor.href)) return;
      preAuthorize(anchor.href);
    }

    document.addEventListener(
      'click',
      (event) => {
        const anchor =
          event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (anchor && isAdUrl(anchor.href)) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          console.debug('[Pawchive Downloader] 已拦截广告链接:', anchor.href.slice(0, 120));
          return;
        }
        preAuthorizeFromEvent(event);
      },
      true
    );
    document.addEventListener('auxclick', preAuthorizeFromEvent, true);
    // 键盘/脚本触发的新窗口（例如 target=_blank 的 a.click()）也登记一下
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter') return;
        const active = document.activeElement;
        if (active && active.tagName === 'A' && !isAdUrl(active.href)) preAuthorize(active.href);
      },
      true
    );

    // 2) 广告 iframe（弹窗有时是往页面里塞 iframe）
    const nativeIframeSrc = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      'src'
    );
    if (nativeIframeSrc && nativeIframeSrc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: nativeIframeSrc.enumerable,
        get: nativeIframeSrc.get,
        set(value) {
          if (isAdUrl(value)) {
            console.debug('[Pawchive Downloader] 已拦截广告 iframe:', String(value).slice(0, 120));
            return;
          }
          nativeIframeSrc.set.call(this, value);
        }
      });
    }
  }

  installAdBlock();

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------
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

  function guessFilename(url) {
    let name = '';
    try {
      const parsed = new URL(url);
      const f = parsed.searchParams.get('f');
      name = f ? decodeMaybe(f) : decodeMaybe(parsed.pathname.split('/').pop() || '');
    } catch (err) {
      name = '';
    }
    return name || '';
  }

  // -------------------------------------------------------------------------
  // 帖子信息
  // -------------------------------------------------------------------------
  function getPostInfo() {
    const match = location.pathname.match(POST_PATH_RE);
    if (!match) return null;
    const authorEl = document.querySelector('.post__user-name');
    const titleEl = document.querySelector('.post__title');
    const author = authorEl ? authorEl.textContent.replace(/\s+/g, ' ').trim() : '';
    const title = titleEl
      ? applyBlockWords(titleEl.textContent.replace(/\s+/g, ' ').trim(), cachedBlockWords)
      : '';
    return {
      platform: match[1].toLowerCase(),
      userId: match[2],
      postId: match[3],
      author,
      title
    };
  }

  function postKey(info) {
    return info ? `${info.platform}|${info.userId}|${info.postId}` : '';
  }

  // -------------------------------------------------------------------------
  // 收集图片 / 附件
  // -------------------------------------------------------------------------
  const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|avif|apng|bmp|svg)(?:$|[?#])/i;
  const VIDEO_EXT_RE = /\.(?:mov|mp4|m4v|webm|avi|mkv|flv|wmv|mpg|mpeg|ts|m2ts|ogv|3gp|rmvb|rm)(?:$|[?#])/i;

  function isImageName(name) {
    return IMAGE_EXT_RE.test(String(name));
  }

  function isVideoName(name) {
    return VIDEO_EXT_RE.test(String(name));
  }

  function collectItems() {
    const images = [];
    const files = [];
    const seenImageUrls = new Set();
    const seenFileUrls = new Set();

    const pushImage = (url, name) => {
      if (!url || !/^https?:/i.test(url)) return;
      const clean = url.split('#')[0];
      if (seenImageUrls.has(clean)) return;
      seenImageUrls.add(clean);
      images.push({ url: clean, name: name || '' });
    };

    const pushFile = (url, name) => {
      if (!url || !/^https?:/i.test(url)) return;
      const clean = url.split('#')[0];
      if (seenFileUrls.has(clean)) return;
      seenFileUrls.add(clean);
      files.push({ url: clean, name: name || '' });
    };

    // 1) 文件区图片链接：极少数指向视频，归入「文件」
    document.querySelectorAll('a.fileThumb.image-link[href]').forEach((anchor) => {
      const dlName = decodeMaybe(anchor.getAttribute('download') || '');
      const name = dlName || guessFilename(anchor.href);
      if (isVideoName(name)) {
        pushFile(anchor.href, name);
        return;
      }
      pushImage(anchor.href, dlName);
    });

    // 2) 正文内嵌图片（patreon 等），排除缩略图避免重复计数
    document
      .querySelectorAll('.post__content img[src], .post__body img[src], img.post__image')
      .forEach((img) => {
        if (img.closest) {
          if (img.closest('a.fileThumb')) return;
          if (img.closest('.pd-thumbs')) return;
        }
        const url = img.currentSrc || img.getAttribute('data-src') || img.src;
        if (url && !url.startsWith('data:') && !/\/thumbnail\//i.test(url)) {
          pushImage(url);
        }
      });

    // 3) 非图片附件（zip / 音频 / 视频等），保留原名、不编号
    document
      .querySelectorAll('a.fileThumb[href]:not(.image-link), a[download][href]')
      .forEach((anchor) => {
        if (anchor.closest && anchor.closest('a.fileThumb.image-link')) return;
        const name = decodeMaybe(anchor.getAttribute('download') || '') || guessFilename(anchor.href);
        if (isImageName(name)) {
          pushImage(anchor.href, name);
          return;
        }
        pushFile(anchor.href, name);
      });

    // 图片带帖子内 1 基序号；附件无序号
    const out = images.map((img, i) => ({
      url: img.url,
      name: img.name,
      kind: 'image',
      index: i + 1
    }));
    files.forEach((file) => out.push({ url: file.url, name: file.name, kind: 'file', index: 0 }));
    return out;
  }

  function collectImages() {
    return collectItems().filter((x) => x.kind === 'image');
  }

  function applySkipRules(items, skipFirst, skipLast) {
    const first = Math.max(0, Math.min(skipFirst || 0, items.length));
    const last = Math.max(first, items.length - Math.max(skipLast || 0, 0));
    return items.slice(first, last);
  }

  // 封面判定：优先看文件名是不是 cover.*（站点用 download="cover.jpeg" 标注封面）。
  // 实测 fanbox 帖子的文件列表里，视频常常排在封面之前，所以「第一张」并不可靠；
  // 只有在整帖都找不到 cover.* 时才回退到「跳过第一张」。
  const COVER_NAME_RE = /^cover(?:[._-]|$)/i;

  function filterCover(images, platform) {
    if (String(platform).toLowerCase() !== 'fanbox') return images;
    const withoutCover = images.filter((item) => !COVER_NAME_RE.test(String(item.name || '')));
    if (withoutCover.length !== images.length) return withoutCover; // 命中 cover.*
    if (images.length > 1) return images.slice(1); // 没找到就跳过第一张
    return images;
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------
  function ensurePanel() {
    if (document.getElementById('pd-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'pd-panel';
    panel.innerHTML = `
      <div class="pd-panel__head">
        <span class="pd-panel__logo">⬇</span>
        <span class="pd-panel__title">Pawchive 下载器</span>
        <span class="pd-panel__count" id="pd-count"></span>
      </div>
      <div class="pd-panel__nav" id="pd-nav"></div>
      <div class="pd-panel__row">
        <button class="pd-btn pd-btn--primary" id="pd-download">下载帖子全部图片</button>
        <button class="pd-btn pd-btn--cancel" id="pd-cancel" style="display:none">✕ 取消</button>
        <button class="pd-btn" id="pd-copy">复制图片链接</button>
      </div>
      <div class="pd-panel__status" id="pd-status"></div>
      <div class="pd-panel__engine" id="pd-engine"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('pd-download').addEventListener('click', downloadAll);
    document.getElementById('pd-copy').addEventListener('click', copyAllLinks);
    document.getElementById('pd-cancel').addEventListener('click', cancelQueue);
    refreshCount();
  }

  function setPanelForPost(onPost) {
    const downloadBtn = document.getElementById('pd-download');
    const copyBtn = document.getElementById('pd-copy');
    if (downloadBtn) downloadBtn.style.display = onPost ? '' : 'none';
    if (copyBtn) copyBtn.style.display = onPost ? '' : 'none';
  }

  function showCancelButton(show) {
    const el = document.getElementById('pd-cancel');
    if (el) el.style.display = show ? '' : 'none';
  }

  function refreshCount() {
    const el = document.getElementById('pd-count');
    if (!el) return;
    const count = collectImages().length;
    const label = count > 0 ? `${count} 张` : '';
    if (el.textContent !== label) el.textContent = label;
  }

  function showStatus(text, kind) {
    const el = document.getElementById('pd-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
  }

  function formatSpeed(bytesPerSecond) {
    const value = Number(bytesPerSecond) || 0;
    if (value <= 0) return '';
    if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
    return `${(value / 1024).toFixed(0)} KB/s`;
  }

  // -------------------------------------------------------------------------
  // 与后台通信
  // -------------------------------------------------------------------------
  let lastEngine = { ready: false, version: '', dir: '', maxParallel: 0, speed: 0 };
  let lastPostSummary = null;
  let lastGlobal = { total: 0, queued: 0, active: 0, done: 0, failed: 0 };
  // 后台算好的「本帖子 / 其他帖子」未完成工作量（与 lastGlobal 同源同刻）
  let lastWork = { mineActive: 0, mineQueued: 0, othersActive: 0, othersQueued: 0 };

  function renderEngine() {
    const el = document.getElementById('pd-engine');
    if (!el) return;
    if (lastEngine.ready) {
      const speed = formatSpeed(lastEngine.speed);
      el.textContent =
        `aria2 ${lastEngine.version || ''} · 并行 ${lastEngine.maxParallel || '?'}` +
        (speed ? ` · ${speed}` : '');
      el.dataset.kind = 'ok';
    } else if (lastEngine.error) {
      el.textContent = lastEngine.error;
      el.dataset.kind = 'warn';
    } else {
      el.textContent = 'aria2 引擎未就绪';
      el.dataset.kind = 'warn';
    }
  }

  // 只展示「未完成」的工作量，已完成/失败的历史不进这两句话，
  // 否则会出现「本帖子已下完、其他帖子还多一个」的错觉。
  // work 由后台按同一条消息内自洽计算，这里直接照抄，不再自己相减。
  function renderQueue() {
    const work = lastWork || { mineActive: 0, mineQueued: 0, othersActive: 0, othersQueued: 0 };
    const global = lastGlobal;
    const mineTotal = work.mineActive + work.mineQueued;
    const othersTotal = work.othersActive + work.othersQueued;

    if (mineTotal === 0 && othersTotal === 0) {
      showCancelButton(false);
      if (global.done || global.failed) {
        showStatus(
          `空闲（最近完成 ${global.done}，失败 ${global.failed}）`,
          global.failed ? 'warn' : 'ok'
        );
      } else {
        showStatus('');
      }
      return;
    }

    const parts = [];
    if (mineTotal > 0) {
      const finishedInBatch = (lastPostSummary && lastPostSummary.done) || 0;
      // 分母优先用后台按这个帖子给的权威总数（含 isImage 历史），拿不到才退回
      // 「在途 + 已完成」的估算。以前一律用估算值，而分子来自广播、分母来自查询
      // 响应，两个来源时序不同，分母会额外抖一下。
      const knownTotal = (lastPostSummary && lastPostSummary.count) || 0;
      const total = knownTotal > 0 ? knownTotal : mineTotal + finishedInBatch;
      parts.push(
        `本帖子：${finishedInBatch}/${total} 完成` +
          (work.mineActive ? `，下载中 ${work.mineActive}` : '') +
          (work.mineQueued ? `，排队 ${work.mineQueued}` : '')
      );
    }
    if (othersTotal > 0) {
      parts.push(
        `其他帖子：${othersTotal} 个文件` +
          (work.othersActive ? `（下载中 ${work.othersActive}，排队 ${work.othersQueued}）` : '（排队中）')
      );
    }
    showStatus(parts.join('；'), global.failed ? 'warn' : 'info');
    showCancelButton(true);
  }

  function applyStatus(message) {
    lastEngine = { ...lastEngine, ...(message.engine || {}) };
    lastGlobal = message.global || lastGlobal;
    if (message.log) lastEngine.error = message.engine && message.engine.ready ? '' : message.log;
    renderEngine();

    // 这条消息是不是在说「我当前页面的这个帖子」？
    //   - 查询响应：带 key，且等于本页认定的 key；
    //   - 广播：后台查 tabKeys 得到 key（查不到是空串）；内容脚本还没认出帖子时自己也是空串。
    // 判定依据是"两边都非空且相等"，否则这份 work/posts 不属于本页，不能采用。
    const myKey = postKey(getPostInfo());
    const messageKey = typeof message.key === 'string' ? message.key : null;
    const forMe = !myKey
      ? messageKey === null || messageKey === '' // 本页还不是帖子页：只认全局数据
      : messageKey === null || messageKey === myKey;

    // lastWork 是跨消息累積的状态。后台在没有已知 key 时会发 work: null，
    // 这里必须保留上一份有效值，绝不能退回「按空 key 算」的全零快照 ——
    // 那正是「本帖子：0/1 完成」与「其他帖子：1 个文件」来回跳的来源。
    if (message.work && forMe) {
      lastWork = message.work;
    }

    if (forMe) {
      const key = myKey;
      const found = (message.posts || []).find((p) => p.key === key) || null;
      if (found) {
        lastPostSummary = {
          count: found.total,
          imageCount: found.imageCount,
          done: found.done,
          failed: found.failed,
          active: found.active,
          queued: found.queued
        };
      } else if (key) {
        lastPostSummary = { count: 0, done: 0, failed: 0, active: 0, queued: 0 };
      }
    }
    renderQueue();
    refreshCount();
  }

  async function refreshStatus() {
    try {
      const info = getPostInfo();
      const result = await chrome.runtime.sendMessage({
        type: 'PD_GET_STATUS',
        key: info ? postKey(info) : ''
      });
      if (result && result.engine) applyStatus(result);
    } catch (err) {
      // 后台可能正忙，忽略
    }
  }

  // 只上报「本标签页当前是哪个帖子」，让后台广播里的 work 能和这里口径一致。
  // 后台 SW 被回收后这张表会丢，所以定时补报一次（各自 5 秒很便宜）。
  function reportTabKey() {
    try {
      const info = getPostInfo();
      chrome.runtime
        .sendMessage({ type: 'PD_GET_STATUS', key: info ? postKey(info) : '', keyOnly: true })
        .catch(() => {});
    } catch (err) {
      // 扩展上下文失效时忽略
    }
  }

  // 供扩展弹窗查询：当前页面是不是帖子页、有多少图片/附件、队列进度
  function currentPostPayload() {
    const info = getPostInfo();
    if (!info) return { post: null };
    const items = collectItems();
    const images = items.filter((x) => x.kind === 'image').length;
    const summary = lastPostSummary || { count: 0, done: 0, failed: 0, active: 0, queued: 0 };
    // 队列里还剩多少用 lastWork（只算未完成），不要用含历史的 count
    const remaining = lastWork.mineActive + lastWork.mineQueued;
    return {
      post: {
        ...info,
        imageCount: images,
        fileCount: items.length - images,
        ...summary,
        count: remaining,
        active: lastWork.mineActive,
        queued: lastWork.mineQueued
      }
    };
  }

  // -------------------------------------------------------------------------
  // 下载动作
  // -------------------------------------------------------------------------
  async function downloadAll() {
    const info = getPostInfo();
    if (!info) return;

    const images = collectImages();
    const settings = await chrome.storage.sync.get({ skipFirst: 0, skipLast: 0, blockCover: true });
    let candidates = images;
    let skippedCover = 0;
    if (settings.blockCover && info.platform === 'fanbox') {
      candidates = filterCover(images, info.platform);
      skippedCover = images.length - candidates.length;
    }
    const selected = applySkipRules(candidates, settings.skipFirst, settings.skipLast);

    if (selected.length === 0) {
      showStatus(
        `没有可下载的图片（共 ${images.length} 张，被「跳过封面/跳过前·后 N 张」过滤掉了）`,
        'warn'
      );
      return { ok: false, error: '没有可下载的图片' };
    }

    showStatus('正在提交到 aria2…', 'info');
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PD_ENQUEUE',
        post: info,
        items: selected
      });
      if (!result || !result.ok) throw new Error((result && result.error) || '提交失败');
      if (result.duplicate) {
        showStatus('这些图片已经在队列或已下载', 'info');
      } else {
        showStatus(
          `已加入队列：${result.added} 张图片` +
            (skippedCover ? `（自动跳过封面 ${skippedCover} 张）` : '') +
            '，切换页面不会中断',
          'ok'
        );
      }
      await refreshStatus();
      return { ok: true, added: result.added || 0, duplicate: !!result.duplicate };
    } catch (err) {
      showStatus('加入队列失败：' + err.message, 'warn');
      return { ok: false, error: err.message };
    }
  }

  const singleInflight = new Set();

  async function downloadSingleItem(item, btn) {
    const info = getPostInfo();
    if (!info) throw new Error('当前页面不是帖子页面');
    if (singleInflight.has(item.url)) return '';
    singleInflight.add(item.url);
    if (btn) {
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.textContent = '⏳';
    }
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PD_DOWNLOAD_ONE',
        post: info,
        items: [item]
      });
      if (!result || !result.ok) throw new Error((result && result.error) || '下载失败');
      if (btn) btn.textContent = '✓';
      return result.file || '';
    } catch (err) {
      if (btn) btn.textContent = '✗';
      throw err;
    } finally {
      singleInflight.delete(item.url);
      if (btn) {
        setTimeout(() => {
          btn.disabled = false;
          delete btn.dataset.busy;
        }, 1500);
      }
      refreshStatus();
    }
  }

  async function cancelQueue() {
    const info = getPostInfo();
    if (!info) return;
    showStatus('正在取消…', 'info');
    try {
      await chrome.runtime.sendMessage({ type: 'PD_CANCEL', key: postKey(info) });
      await refreshStatus();
    } catch (err) {
      showStatus('取消失败', 'warn');
    }
  }

  async function copyAllLinks() {
    const items = collectImages();
    if (items.length === 0) {
      showStatus('当前帖子没有检测到图片', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(items.map((item) => item.url).join('\n'));
      showStatus(`已复制 ${items.length} 个图片链接`, 'ok');
    } catch (err) {
      showStatus('复制失败，请检查剪贴板权限', 'warn');
    }
  }

  // -------------------------------------------------------------------------
  // 接管左键/中键点击附件链接
  // -------------------------------------------------------------------------
  function handleFileLinkClick(e) {
    if (e.defaultPrevented) return;
    const isAux = e.type === 'auxclick';
    if (isAux ? e.button !== 1 : e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const anchor = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!anchor) return;
    // 扩展自身 UI 不拦截（缩略图条里的链接只是滚动定位用）
    if (anchor.closest && anchor.closest('#pd-panel, .pd-thumbs')) return;
    const info = getPostInfo();
    if (!info) return;

    const item = collectItems().find((x) => x.url === anchor.href);
    if (!item) return;

    e.preventDefault();
    e.stopPropagation();
    downloadSingleItem(item)
      .then((file) => {
        if (file) showStatus(`已交给 aria2：${file}`, 'ok');
      })
      .catch((err) => {
        showStatus('下载失败：' + err.message, 'warn');
      });
  }

  // -------------------------------------------------------------------------
  // 每张图片旁的「⬇ 下载」按钮
  // -------------------------------------------------------------------------
  function attachImageButtons() {
    const items = collectItems();
    const itemByUrl = new Map(items.map((item) => [item.url, item]));

    document.querySelectorAll('a.fileThumb.image-link[href]').forEach((anchor) => {
      const figure = anchor.closest('figure') || anchor.parentElement;
      if (!figure || figure.querySelector('.pd-img-btn-wrap')) return;
      const item = itemByUrl.get(anchor.href);
      if (!item) return;

      const wrap = document.createElement('span');
      wrap.className = 'pd-img-btn-wrap';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pd-img-btn';
      btn.textContent = '⬇ 下载';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        downloadSingleItem(item, btn).catch((err) => {
          showStatus('下载失败：' + err.message, 'warn');
        });
      });

      wrap.appendChild(btn);
      figure.appendChild(wrap);
    });
  }

  // -------------------------------------------------------------------------
  // 正文框最上方的密集缩略图条
  // -------------------------------------------------------------------------
  function addThumbnailStrip() {
    const filesSection = document.querySelector('.post__files');
    if (!filesSection) return;

    const items = collectItems();
    const itemByUrl = new Map(items.map((item) => [item.url, item]));

    const thumbs = [];
    document.querySelectorAll('a.fileThumb.image-link[href]').forEach((anchor) => {
      const img = anchor.querySelector && anchor.querySelector('img');
      const thumbUrl = img && (img.currentSrc || img.getAttribute('data-src') || img.src);
      if (thumbUrl && thumbUrl.startsWith('http')) {
        thumbs.push({ fullUrl: anchor.href, thumbUrl });
      }
    });
    if (thumbs.length === 0) return;

    let strip = document.getElementById(THUMB_STRIP_ID);
    if (!strip) {
      strip = document.createElement('div');
      strip.id = THUMB_STRIP_ID;
      strip.className = 'pd-thumbs';
    }

    const postBody = document.querySelector('.post__body');
    if (postBody) {
      if (strip.parentNode !== postBody || postBody.firstChild !== strip) {
        postBody.insertBefore(strip, postBody.firstChild);
      }
    } else {
      const contentEl = document.querySelector('.post__content');
      if (contentEl) {
        if (!strip.parentNode || strip.previousSibling !== contentEl) contentEl.after(strip);
      } else if (!strip.parentNode || strip.nextSibling !== filesSection) {
        filesSection.before(strip);
      }
    }

    if (strip.dataset.count === String(thumbs.length)) return;
    strip.dataset.count = String(thumbs.length);
    strip.textContent = '';

    thumbs.forEach((thumb) => {
      const link = document.createElement('a');
      link.className = 'pd-thumb-link';
      link.href = thumb.fullUrl;
      link.title = thumb.fullUrl;

      const img = document.createElement('img');
      img.className = 'pd-thumb-img';
      img.src = thumb.thumbUrl;
      img.loading = 'lazy';
      img.alt = '';
      link.appendChild(img);

      const item = itemByUrl.get(thumb.fullUrl);
      if (item) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pd-thumb-dl';
        btn.textContent = '⬇';
        btn.title = '下载原图';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          downloadSingleItem(item, btn).catch((err) => {
            showStatus('下载失败：' + err.message, 'warn');
          });
        });
        link.appendChild(btn);
      }

      link.addEventListener('click', (e) => {
        e.preventDefault();
        // 只在正文的文件区里找原始缩略图链接，避免命中缩略图条自己
        const target = Array.from(document.querySelectorAll('a.fileThumb.image-link[href]')).find(
          (a) => a.href === thumb.fullUrl && !a.closest('.pd-thumbs')
        );
        if (target && target.scrollIntoView) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
        window.open(thumb.fullUrl, '_blank');
      });
      strip.appendChild(link);
    });
  }

  // -------------------------------------------------------------------------
  // 作者主页：未存档帖子打大红 X
  // -------------------------------------------------------------------------
  // 注意：站点给「所有」卡片都加了 post-card--preview 类（实测 35/35），
  // 只有真正未存档的卡片才有 .state-badge--preview 徽标（实测 3/35）。
  // 所以绝不能拿 post-card--preview 当判据，否则整页都会被打红叉。
  function isUnarchivedCard(card) {
    if (!card) return false;
    if (card.querySelector('.state-badge--preview')) return true;
    const badge = card.querySelector('.state-badge');
    if (badge) {
      const text = (badge.getAttribute('aria-label') || '') + ' ' + (badge.getAttribute('title') || '');
      if (/haven['’]?t archived/i.test(text)) return true;
    }
    return false;
  }

  function markUnarchivedPosts() {
    document.querySelectorAll('article.post-card').forEach((card) => {
      const unarchived = isUnarchivedCard(card);
      const marked = card.classList.contains('pd-unarchived');
      if (unarchived && !marked) {
        card.classList.add('pd-unarchived');
        const x = document.createElement('span');
        x.className = 'pd-unarchived-x';
        x.title = '该帖子尚未被站点存档';
        card.appendChild(x);
      } else if (!unarchived && marked) {
        card.classList.remove('pd-unarchived');
        const x = card.querySelector('.pd-unarchived-x');
        if (x) x.remove();
      }
    });
  }

  // -------------------------------------------------------------------------
  // 面板顶部的上一页/下一页导航
  // -------------------------------------------------------------------------
  let navRetryPending = false;

  function updatePanelNav() {
    const navEl = document.getElementById(PANEL_NAV_ID);
    if (!navEl) return;
    while (navEl.firstChild) navEl.removeChild(navEl.firstChild);

    const topNav = document.querySelector('nav.post__nav-links');
    if (!topNav) {
      navEl.style.display = 'none';
      return;
    }
    const items = topNav.querySelectorAll('li.post__nav-item');
    if (items.length === 0) {
      navEl.style.display = 'none';
      return;
    }

    const currentPathname = location.pathname + location.search;
    let added = 0;
    let sawSelfLink = false;
    items.forEach((li) => {
      const linkEl = li.querySelector('a');
      const link = document.createElement('a');
      link.className = 'pd-panel-nav-link' + (linkEl ? '' : ' pd-panel-nav-link--disabled');
      link.textContent = li.textContent.replace(/\s+/g, ' ').trim();
      if (linkEl) {
        let targetPath = null;
        try {
          const u = new URL(linkEl.href, location.href);
          targetPath = u.pathname + u.search;
        } catch (err) {
          targetPath = linkEl.href;
        }
        if (targetPath === currentPathname) {
          sawSelfLink = true;
          return;
        }
        link.href = linkEl.href;
        link.title = linkEl.textContent.trim();
      }
      navEl.appendChild(link);
      added += 1;
    });
    navEl.style.display = added > 0 ? '' : 'none';

    if (sawSelfLink && !navRetryPending) {
      navRetryPending = true;
      setTimeout(() => {
        navRetryPending = false;
        applyRoute();
      }, 800);
    }
  }

  // -------------------------------------------------------------------------
  // 预加载下一页缩略图
  // -------------------------------------------------------------------------
  // 实测：缩略图 CDN 返回 `Cache-Control: public, max-age=31536000, immutable`，
  // 预热过的地址 3ms 命中缓存，没预热过要 500ms 左右。所以这里只做一件事：
  // 把下一页的缩略图用 fetch 串一遍，翻页后立刻可见。
  // 注意 v1 的问题是「预加载了但下一张就被 LRU 挤掉」——一页可能有几十张，
  // 所以这里改成最多 4 个并发、总数封顶，并在进入新页面后清掉旧的预热队列。
  let lastPreloadNext = '';
  let preloadToken = 0;
  const PRELOAD_LIMIT = 60;
  const PRELOAD_CONCURRENCY = 4;
  const THUMBNAIL_RE = /\/thumbnail\//i;
  const ATTR_URL_RE = /(?:data-src|src|data-original|srcset)\s*=\s*"([\s\S]*?)"/gi;

  function extractThumbnailUrls(html, limit) {
    const urls = new Set();
    let match;
    ATTR_URL_RE.lastIndex = 0;
    while ((match = ATTR_URL_RE.exec(html)) !== null) {
      // srcset 的格式是 "url1 1x, url2 2x"，逐个拆开
      for (const candidate of match[1].split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (!url) continue;
        const absolute = url.startsWith('http')
          ? url
          : url.startsWith('//')
            ? `${location.protocol}${url}`
            : url.startsWith('/')
              ? `${location.origin}${url}`
              : '';
        if (absolute && THUMBNAIL_RE.test(absolute)) {
          urls.add(absolute);
          if (urls.size >= limit) return Array.from(urls);
        }
      }
    }
    return Array.from(urls);
  }

  function preloadNextThumbnails() {
    const nextLink = document.querySelector('nav.post__nav-links a.next[href]');
    if (!nextLink) return;
    const nextUrl = nextLink.href;
    if (!nextUrl || nextUrl === lastPreloadNext) return;
    lastPreloadNext = nextUrl;
    const token = (preloadToken += 1);

    fetch(nextUrl, { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.text();
      })
      .then(async (html) => {
        const urls = extractThumbnailUrls(html, PRELOAD_LIMIT);
        let index = 0;
        let loaded = 0;
        const worker = async () => {
          while (index < urls.length) {
            // 已经切到别的帖子了就别再占带宽
            if (token !== preloadToken) return;
            const url = urls[index];
            index += 1;
            try {
              const resp = await fetch(url, { cache: 'force-cache' });
              if (resp.body) await resp.arrayBuffer();
              loaded += 1;
            } catch (err) {
              // 单张失败不影响其余
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PRELOAD_CONCURRENCY, urls.length) }, worker)
        );
        if (token === preloadToken && urls.length > 0) {
          console.log(`[Pawchive Downloader] 已预加载下一页缩略图 ${loaded}/${urls.length} 张`);
        }
      })
      .catch((err) => {
        console.warn('[Pawchive Downloader] 预加载下一页失败:', nextUrl, err);
      });
  }

  // -------------------------------------------------------------------------
  // 路由与刷新
  // -------------------------------------------------------------------------
  let lastPath = '';
  let routeRefreshTimer = null;
  let countTimer = null;
  let routeObserver = null;

  const scheduleCountRefresh = () => {
    if (countTimer !== null) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      refreshPostUi();
    }, 400);
  };

  function refreshPostUi() {
    attachImageButtons();
    addThumbnailStrip();
    refreshCount();
  }

  function ensurePostUi() {
    ensurePanel();
    setPanelForPost(true);
    refreshPostUi();
    refreshStatus();

    if (routeObserver) {
      routeObserver.disconnect();
      routeObserver = null;
    }
    const postRoot =
      document.querySelector('.post__body') ||
      document.querySelector('.post__files') ||
      document.querySelector('.post__content') ||
      null;
    if (postRoot) {
      routeObserver = new MutationObserver(scheduleCountRefresh);
      routeObserver.observe(postRoot, { childList: true, subtree: true });
    }

    [800, 2000, 4000].forEach((delay) => setTimeout(refreshPostUi, delay));
    setTimeout(preloadNextThumbnails, 1500);
  }

  function applyRoute() {
    ensurePanel();
    updatePanelNav();
    reportTabKey();
    if (getPostInfo()) {
      ensurePostUi();
    } else {
      setPanelForPost(false);
      lastPostSummary = null;
      lastWork = { mineActive: 0, mineQueued: 0, othersActive: 0, othersQueued: 0 };
      refreshStatus();
    }
    markUnarchivedPosts();
  }

  function handleLocationChange(force) {
    const path = location.pathname + location.search;
    if (!force && path === lastPath) return;
    lastPath = path;
    if (routeRefreshTimer) clearTimeout(routeRefreshTimer);
    routeRefreshTimer = setTimeout(() => {
      routeRefreshTimer = null;
      applyRoute();
    }, 300);
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  chrome.storage.sync.get({ blockWords: [] }, (settings) => {
    cachedBlockWords = normalizeBlockWords(settings.blockWords);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.blockWords) {
      cachedBlockWords = normalizeBlockWords(changes.blockWords.newValue);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'PD_STATUS') {
      applyStatus(message);
      return undefined;
    }
    if (message.type === 'PD_GET_STATUS') {
      sendResponse(currentPostPayload());
      return undefined;
    }
    if (message.type === 'PD_DOWNLOAD_ALL') {
      if (!getPostInfo()) {
        sendResponse({ ok: false, error: '当前页面不是帖子页面' });
        return undefined;
      }
      downloadAll()
        .then((result) => sendResponse(result || { ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      return true; // 异步响应
    }
    return undefined;
  });

  window.addEventListener('popstate', () => handleLocationChange(true));
  window.addEventListener('htmx:pushedIntoHistory', () => handleLocationChange(true));
  window.addEventListener('htmx:afterSwap', () => handleLocationChange(true));
  window.addEventListener('htmx:afterSettle', () => handleLocationChange(true));
  document.addEventListener('click', handleFileLinkClick);
  document.addEventListener('auxclick', handleFileLinkClick);

  // 兜底轮询：只比较路径字符串，开销极小
  setInterval(handleLocationChange, 1000);
  // 进度兜底轮询（后台广播偶发丢失时也能回显）
  setInterval(refreshStatus, 1500);
  // 定时补报当前帖子 key（后台 SW 重启后会丢，补报让广播口径不漂）
  setInterval(reportTabKey, 5000);
  // 列表页卡片懒加载，定时补标未存档帖子
  setInterval(() => {
    if (document.querySelector('article.post-card')) markUnarchivedPosts();
  }, 1200);

  handleLocationChange();
})();
