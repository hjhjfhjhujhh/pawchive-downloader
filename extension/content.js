// 内容脚本：识别帖子页面、注入悬浮面板、收集图片与附件、接管链接点击。
// 下载本身由后台 Service Worker 通过 aria2 完成，这里只负责「告诉后台下什么」。
'use strict';

(() => {
  if (window.__pawchiveDownloaderInstalled) return;
  window.__pawchiveDownloaderInstalled = true;

  const POST_PATH_RE = /^\/([a-z0-9_-]+)\/user\/(\d+)\/post\/(\d+)/i;
  const THUMB_STRIP_ID = 'pd-thumbs';
  const PANEL_NAV_ID = 'pd-nav';

  // 「标题屏蔽字」默认值：与弹窗里的示例内容一致，装好即生效。
  // 这里必须和 background.js / popup.js 的 DEFAULT_BLOCK_WORDS 保持一致：
  // 用户在弹窗里点保存前，页面上的标题就得按同样的规则清理，
  // 否则入队时（content.js）和建目录时（background.js）算出来的标题会不一样。
  const DEFAULT_BLOCK_WORDS = ['(Pixiv Fanbox)', 'patreon'];

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

  // 未存档帖子：站点只给缩略图（文件区是 .post__thumbnail > figure > img，
  // 没有任何 a.fileThumb 链接），并在标题旁放 .state-badge--preview 徽标
  // （aria-label = "haven't archived this post yet"，与作者主页卡片同一套标记）。
  // 实测对照：未存档帖 18 个 .post__thumbnail、0 个 a.fileThumb；
  //           已存档帖 5 个 a.fileThumb.image-link + 同样数量的 .post__thumbnail
  //           （后者包在链接里）——所以不能只看 .post__thumbnail 来判断。
  function isUnarchivedPost() {
    const badge = document.querySelector('.state-badge--preview');
    if (badge) {
      const text = `${badge.getAttribute('aria-label') || ''} ${badge.getAttribute('title') || ''}`;
      // 徽标存在但没有文案时也认（站点改文案不至于失效）
      if (!text.trim() || /haven['’]?t archived/i.test(text)) return true;
    }
    // 兜底：文件区只有预览缩略图、没有任何附件链接 = "Previews only"
    return (
      document.querySelectorAll('a.fileThumb[href]').length === 0 &&
      document.querySelectorAll('.post__files .post__thumbnail img, .post__files figure img').length > 0
    );
  }

  // 未存档帖子能拿到的只有缩略图（img.pawchive.pw/thumbnail/…，文件名是哈希）
  function collectThumbnails() {
    const urls = [];
    const seen = new Set();
    document
      .querySelectorAll('.post__files .post__thumbnail img, .post__files figure img')
      .forEach((img) => {
        const raw = img.currentSrc || img.getAttribute('data-src') || img.src || '';
        if (!raw || !/^https?:/i.test(raw)) return;
        const clean = raw.split('#')[0];
        if (seen.has(clean)) return;
        seen.add(clean);
        urls.push(clean);
      });
    return urls;
  }

  function collectItems() {
    // 未存档帖子：没有全尺寸图片链接，只能下缩略图。这里直接短路上报，
    // 后续的按钮文案、复制、计数都会自动跟着走同一份数据。
    if (isUnarchivedPost()) {
      return collectThumbnails().map((url, i) => ({
        url,
        name: '', // 缩略图 URL 的末段是哈希，交给后台 guessFilename 取名
        kind: 'image',
        index: i + 1
      }));
    }

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
  // 面板拖动
  //
  // 按住左上角的标题栏（.pd-panel__head）即可把面板拖到任意位置。
  // 用 Pointer Events：鼠标 / 触摸 / 触控笔同一套代码。pointermove /
  // pointerup 挂在 document 上并按 pointerId 过滤（同时仍然 setPointerCapture），
  // 因为只挂标题栏的话，指针一旦离开标题栏就收不到事件 —— 实测Chromium 在
  // 捕获生效后并不保证继续把 move 派发给捕获元素；挂 document 则指针移出
  // 面板、甚至移出窗口都照样跟手。
  //
  // 位置**不持久化**：拖完只在当前页面内有效，刷新/切页后回到 CSS 默认位置
  // （左下角）。所以拖动时改成 left/top 定位、去掉 right/bottom，并对视口做
  // 钳制，保证面板不会整块被拖到看不见的地方。
  // 拖动过程用 transform 位移（每帧最多写一次，只走合成层），松手才落到 left/top。
  // -------------------------------------------------------------------------
  const PANEL_MIN_VISIBLE_X = 60; // 水平方向至少留这么多像素在视口内
  const PANEL_MIN_VISIBLE_Y = 32; // 竖直方向至少留这么高（够抓手标题栏）

  let panelPos = null; // { left, top } 相对视口；null = 仍用 CSS 默认位置
  let dragState = null;
  let dragFrame = 0;
  let panelDragInstalled = false;
  let panelSuppressClick = false;

  function viewportSize() {
    return {
      w: window.innerWidth || document.documentElement.clientWidth || 0,
      h: window.innerHeight || document.documentElement.clientHeight || 0
    };
  }

  // 把坐标钳制到「面板始终有可抓的部分留在视口内」
  function clampPanelPos(left, top) {
    const panel = document.getElementById('pd-panel');
    const size = viewportSize();
    const width = (panel && panel.offsetWidth) || 260;
    const maxLeft = Math.max(0, size.w - PANEL_MIN_VISIBLE_X);
    const maxTop = Math.max(0, size.h - PANEL_MIN_VISIBLE_Y);
    return {
      left: Math.min(Math.max(Number(left) || 0, PANEL_MIN_VISIBLE_X - width), maxLeft),
      top: Math.min(Math.max(Number(top) || 0, 0), maxTop)
    };
  }

  function applyPanelPos(pos) {
    const panel = document.getElementById('pd-panel');
    if (!panel) return;
    // 拖动中用的是 transform 位移，落位时必须清掉，否则两者会叠加
    panel.style.transform = '';
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  // 按最新指针位置重算并写入 transform（由 rAF 合并，每帧最多一次）
  function applyDragFrame() {
    dragFrame = 0;
    if (!dragState) return;
    const panel = document.getElementById('pd-panel');
    if (!panel) return;
    const rawLeft = dragState.clientX - dragState.grabX;
    const rawTop = dragState.clientY - dragState.grabY;
    if (!dragState.moved) {
      // 抖动阈值：避免「点一下」被判成拖动
      if (Math.abs(rawLeft - dragState.startLeft) < 3 && Math.abs(rawTop - dragState.startTop) < 3) {
        return;
      }
      dragState.moved = true;
    }
    const next = clampPanelPos(rawLeft, rawTop);
    panelPos = next;
    panel.style.transform = `translate3d(${next.left - dragState.startLeft}px, ${
      next.top - dragState.startTop
    }px, 0)`;
  }

  function scheduleDragFrame() {
    if (dragFrame) return;
    if (typeof requestAnimationFrame === 'function') {
      dragFrame = requestAnimationFrame(applyDragFrame);
    } else {
      dragFrame = setTimeout(applyDragFrame, 16);
    }
  }

  function endPanelDrag(event) {
    if (!dragState) return;
    // 只收尾「发起拖动的那根指针」
    if (event && event.pointerId !== undefined && event.pointerId !== dragState.pointerId) return;
    const { pointerId, moved } = dragState;
    const panel = document.getElementById('pd-panel');
    dragState = null;
    if (dragFrame) {
      // 取消挂起的那一帧，用最后一次指针位置一次性落位
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(dragFrame);
      else clearTimeout(dragFrame);
      dragFrame = 0;
    }
    if (moved) {
      // 这次抬手不该被当成「点击标题栏」，压掉紧跟着的那次 click
      panelSuppressClick = true;
      setTimeout(() => {
        panelSuppressClick = false;
      }, 0);
    }
    if (panel) {
      panel.classList.remove('pd-panel--dragging');
      try {
        if (pointerId != null && panel.hasPointerCapture(pointerId)) {
          panel.releasePointerCapture(pointerId);
        }
      } catch (err) {
        // 指针已经没了，忽略
      }
      // 把拖动中的 transform 落成 left/top（没真正移动过就保持 CSS 默认位置）
      if (moved && panelPos) applyPanelPos(panelPos);
    }
  }

  function installPanelDrag() {
    if (panelDragInstalled) return;
    const panel = document.getElementById('pd-panel');
    if (!panel) return;
    const handle = panel.querySelector('.pd-panel__head');
    if (!handle) return;
    panelDragInstalled = true;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false) return; // 只认主键/单指
      if (dragState) return; // 已经有一根指针在拖了
      // 不要把拖动当成文本选择，也不要在原生拖拽里加戏
      event.preventDefault();
      event.stopPropagation();

      const rect = panel.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        // 记录抓取点相对面板左上角的偏移：无论从标题栏哪一处按下，面板都不会跳一下
        grabX: event.clientX - rect.left,
        grabY: event.clientY - rect.top,
        startLeft: rect.left,
        startTop: rect.top,
        clientX: event.clientX,
        clientY: event.clientY,
        moved: false
      };
      try {
        // 捕获指针：即便监听挂在 document 上，这也能让浏览器把事件继续标给本页
        panel.setPointerCapture(event.pointerId);
      } catch (err) {
        // 少数环境下不支持，靠 document 上的监听兜底
      }
      panel.classList.add('pd-panel--dragging');
    });

    // 拖动期间挂在 document 上：指针离开标题栏/面板、甚至移出窗口都不会丢
    document.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      event.preventDefault();
      dragState.clientX = event.clientX;
      dragState.clientY = event.clientY;
      scheduleDragFrame();
    });
    document.addEventListener('pointerup', endPanelDrag);
    document.addEventListener('pointercancel', endPanelDrag);
    // 捕获意外丢失也要收尾，否则面板会永远停在 transform 上
    panel.addEventListener('lostpointercapture', endPanelDrag);
  }

  // 拖动结束后的那一次 click 不应该是「点击标题栏」
  document.addEventListener(
    'click',
    (event) => {
      if (!panelSuppressClick) return;
      const panel = document.getElementById('pd-panel');
      if (panel && panel.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
      panelSuppressClick = false;
    },
    true
  );

  // 窗口缩小 / 缩放后重新钳制：把可能已经跑到视口外的面板拉回来
  let panelResizeTimer = null;
  window.addEventListener('resize', () => {
    if (!panelPos || dragState || panelResizeTimer !== null) return;
    panelResizeTimer = setTimeout(() => {
      panelResizeTimer = null;
      if (!panelPos || dragState) return;
      const next = clampPanelPos(panelPos.left, panelPos.top);
      if (next.left === panelPos.left && next.top === panelPos.top) return;
      panelPos = next;
      applyPanelPos(panelPos);
    }, 200);
  });

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------
  function ensurePanel() {
    if (document.getElementById('pd-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'pd-panel';
    panel.innerHTML = `
      <div class="pd-panel__head" title="按住这里可以拖动面板">
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
      <div class="pd-panel__feedback" id="pd-feedback"></div>
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

  // 未存档帖子只有缩略图可下：把两个按钮的文案/配色切到「缩略图」模式。
  // 在每个会重绘面板的入口都调一次（route 切换、DOM 变化、延迟刷新），幂等。
  const LABEL_IMAGES = '下载帖子全部图片';
  const LABEL_THUMBS = '下载全部缩略图';
  const LABEL_COPY_IMAGES = '复制图片链接';
  const LABEL_COPY_THUMBS = '复制缩略图链接';

  function applyPanelMode() {
    const downloadBtn = document.getElementById('pd-download');
    const copyBtn = document.getElementById('pd-copy');
    if (!downloadBtn || !copyBtn) return false;
    const thumbs = isUnarchivedPost();

    const label = thumbs ? LABEL_THUMBS : LABEL_IMAGES;
    if (downloadBtn.textContent !== label) downloadBtn.textContent = label;
    downloadBtn.classList.toggle('pd-btn--thumbs', thumbs);
    downloadBtn.title = thumbs ? '该帖子尚未存档，只能下载缩略图' : '';

    const copyLabel = thumbs ? LABEL_COPY_THUMBS : LABEL_COPY_IMAGES;
    if (copyBtn.textContent !== copyLabel) copyBtn.textContent = copyLabel;
    copyBtn.title = thumbs ? '复制这个帖子的缩略图链接' : '';
    return thumbs;
  }

  // 进度行：只由 renderQueue 写（下载队列 / 本帖子三个数字）
  function showStatus(text, kind) {
    const el = document.getElementById('pd-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
  }

  // 反馈行：下载按钮的结果、复制结果、错误等「一次性」消息。
  // 与进度行分开，否则下一次轮询/广播就会把它盖掉（用户看不到"已加入队列"）。
  let feedbackTimer = null;
  function showFeedback(text, kind) {
    const el = document.getElementById('pd-feedback');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = null;
    if (!text) return;
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null;
      el.textContent = '';
      el.dataset.kind = '';
    }, 4000);
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
  // 本页面点下载按钮提交成功过的文件数（只在内存里：刷新页面自然归零）。
  // 与下载历史无关 —— 只统计「这一次页面里我提交了多少个文件」。
  let submittedThisPage = 0;

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

  // 进度文案：三个数字
  //   全局未完成队列长度（X）＝ 所有帖子里还没下完的文件数
  //   本帖未完成（Y）      ＝ 属于当前帖子的未完成文件数
  //   本页提交数（Z）      ＝ **本页面**点下载按钮提交过的文件数
  //      —— 只存在内存里，跟下载历史无关，刷新页面即归零。
  //
  //   Y > 0 → `本帖子：X(Y/Z)`（括号外是总队列，括号里是「本帖剩余 / 本页提交」）
  //   Y = 0 但 X > 0 → `下载队列：X`
  //   都 0 → `空闲`
  //
  // 例：本帖子提交 10 个 → 10(10/10) → 9(9/10) → …；手动再下 1 个 → 8(8/11)；
  //     别的页面又下 10 个 → 18(8/11)；刷新后提交数归零 → 18(8/0)。
  function renderQueue() {
    const work = lastWork || { mineActive: 0, mineQueued: 0, othersActive: 0, othersQueued: 0 };
    const global = lastGlobal || { queued: 0, active: 0, done: 0, failed: 0 };
    const mineUnfinished = work.mineActive + work.mineQueued;
    // 全局数来自「全部记录」、本帖数来自 work，两者正常来自同一条消息的快照；
    // 但两条消息（广播/轮询）时间不同，极端情况下会出现 全局 < 本帖。取大值兜底，
    // 免得出现「本帖子：3(8/10)」这种自相矛盾的显示。
    const queueLength = Math.max((global.queued || 0) + (global.active || 0), mineUnfinished);

    if (queueLength === 0) {
      showCancelButton(false);
      showStatus('空闲', 'ok');
      return;
    }
    if (mineUnfinished === 0) {
      // 本页这个帖子没有在途文件（例如刚刷新、或都在别的页面）→ 只报队列长度
      showCancelButton(false);
      showStatus(`下载队列：${queueLength}`, 'info');
      return;
    }
    showCancelButton(true);
    showStatus(`本帖子：${queueLength}(${mineUnfinished}/${submittedThisPage})`, 'info');
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
      // 同一个帖子汇总有**两种消息形状**，这里两种都要认：
      //   - 广播 PD_STATUS：posts 是数组，元素 {key, total, imageCount, done, failed, active, queued}
      //   - 查询 PD_GET_STATUS：post 是对象 {count, imageCount, done, failed, active, queued}
      // 以前只认 posts，而 1.5 秒一次的查询响应里没有 posts → 每次都把 lastPostSummary
      // 清零，分母退回「在途 + 0」，面板就在「4/5（广播）」和「0/1（查询后）」之间跳。
      let summary = null;
      if (message.post && typeof message.post === 'object' && !Array.isArray(message.post)) {
        summary = message.post;
      } else if (Array.isArray(message.posts)) {
        const found = message.posts.find((p) => p.key === key);
        if (found) {
          // 广播里的字段名是 total，查询响应里是 count，统一成 count
          summary = { ...found, count: found.total };
        } else if (key) {
          // 广播里明确没有这个帖子 → 这个帖子确实没有任何记录了
          summary = { count: 0, imageCount: 0, done: 0, failed: 0, active: 0, queued: 0 };
        }
      }
      // 两种都没有就保留上一份值，绝不能清零 —— 清零同样会造成 0/1 抖动
      if (summary) {
        lastPostSummary = {
          count: summary.count || 0,
          imageCount: summary.imageCount || 0,
          done: summary.done || 0,
          failed: summary.failed || 0,
          active: summary.active || 0,
          queued: summary.queued || 0
        };
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

  // 供扩展弹窗查询：当前页面是不是帖子页、有多少图片/附件、队列进度。
  // ★ 一定要带上 engine：弹窗要显示「下载目录」，但引擎状态在后台 SW 手里，
  //   弹窗只跟内容脚本说话。以前这里只回 { post }，而弹窗读 response.engine.dir，
  //   于是帖子页上必然抛 TypeError，整段文案永远停在 HTML 里那句占位提示上。
  function currentPostPayload() {
    const engine = {
      ready: !!lastEngine.ready,
      version: lastEngine.version || '',
      dir: lastEngine.dir || ''
    };
    const info = getPostInfo();
    if (!info) return { post: null, engine };
    const items = collectItems();
    const images = items.filter((x) => x.kind === 'image').length;
    const summary = lastPostSummary || { count: 0, done: 0, failed: 0, active: 0, queued: 0 };
    // 队列里还剩多少用 lastWork（只算未完成），不要用含历史的 count
    const remaining = lastWork.mineActive + lastWork.mineQueued;
    return {
      engine,
      post: {
        ...info,
        // 未存档帖子（只有缩略图）：弹窗据此把按钮文案/配色换成缩略图模式
        unarchived: isUnarchivedPost(),
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

    const thumbsMode = isUnarchivedPost();
    const unit = thumbsMode ? '缩略图' : '图片';
    const images = collectImages();
    const settings = await chrome.storage.sync.get({ skipFirst: 0, skipLast: 0, blockCover: true });
    let candidates = images;
    let skippedCover = 0;
    // 未存档帖子只有缩略图、没有 download 文件名，cover.* 判据失效；
    // 此时再按「找不到 cover 就跳过第一张」处理会白丢一张，所以缩略图模式不做封面过滤。
    if (!thumbsMode && settings.blockCover && info.platform === 'fanbox') {
      candidates = filterCover(images, info.platform);
      skippedCover = images.length - candidates.length;
    }
    const selected = applySkipRules(candidates, settings.skipFirst, settings.skipLast);

    if (selected.length === 0) {
      showFeedback(
        `没有可下载的${unit}（共 ${images.length} 张，被「跳过封面/跳过前·后 N 张」过滤掉了）`,
        'warn'
      );
      return { ok: false, error: `没有可下载的${unit}` };
    }

    showFeedback('正在提交到 aria2…', 'info');
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PD_ENQUEUE',
        post: info,
        items: selected
      });
      if (!result || !result.ok) throw new Error((result && result.error) || '提交失败');
      // 只统计真正进了队列的文件；重复（added=0）不算「本次提交」
      submittedThisPage += result.added || 0;
      if (result.duplicate) {
        showFeedback(
          result.skippedDone
            ? `这些${unit}已经下载过了（弹窗设置里可开启「允许重新下载」）`
            : `这些${unit}已经在下载队列里了`,
          'info'
        );
      } else {
        showFeedback(
          `已加入队列：${result.added} 张${unit}` +
            (skippedCover ? `（自动跳过封面 ${skippedCover} 张）` : '') +
            (thumbsMode ? '（该帖未存档，只有缩略图）' : '') +
            '，切换页面不会中断',
          'ok'
        );
      }
      await refreshStatus();
      return { ok: true, added: result.added || 0, duplicate: !!result.duplicate };
    } catch (err) {
      showFeedback('加入队列失败：' + err.message, 'warn');
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
      // 单文件下载也算「本页面提交」
      submittedThisPage += 1;
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
    showFeedback('正在取消…', 'info');
    try {
      await chrome.runtime.sendMessage({ type: 'PD_CANCEL', key: postKey(info) });
      await refreshStatus();
    } catch (err) {
      showFeedback('取消失败', 'warn');
    }
  }

  async function copyAllLinks() {
    const unit = isUnarchivedPost() ? '缩略图' : '图片';
    const items = collectImages();
    if (items.length === 0) {
      showFeedback(`当前帖子没有检测到${unit}`, 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(items.map((item) => item.url).join('\n'));
      showFeedback(`已复制 ${items.length} 个${unit}链接`, 'ok');
    } catch (err) {
      showFeedback('复制失败，请检查剪贴板权限', 'warn');
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
        if (file) showFeedback(`已交给 aria2：${file}`, 'ok');
      })
      .catch((err) => {
        showFeedback('下载失败：' + err.message, 'warn');
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
          showFeedback('下载失败：' + err.message, 'warn');
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
            showFeedback('下载失败：' + err.message, 'warn');
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
  // 所以这里封顶 60 张、并在进入新页面后清掉旧的预热队列。
  //
  // 实测（18 张缩略图、冷缓存、并发 4/8/12）：3.4s / 2.0s / 1.4s。
  // 用户通常点开帖子 1~3 秒内就点 next，所以：
  //   - 预热必须**尽早**开始（页面一就绪就跑，不再等 1.5 秒）；
  //   - 并发提到 8（再高会和当前页自己的首屏图片抢带宽，收益也变小）；
  //   - 用低优先级，别和首屏图片抢。
  let lastPreloadNext = '';
  let preloadToken = 0;
  let preloadRetryTimer = null;
  let preloadRetryCount = 0;
  const PRELOAD_LIMIT = 60;
  const PRELOAD_CONCURRENCY = 8;
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

  // 站点的上一页/下一页导航栏渲染得比 document_idle 晚（实测 688ms 时才有），
  // 所以找不到 next 链接时短暂重试，别错过预热窗口；找到就取消重试。
  const PRELOAD_RETRY_MS = 200;
  const PRELOAD_RETRY_LIMIT = 15; // ≈3 秒

  function schedulePreloadRetry() {
    if (preloadRetryTimer !== null || preloadRetryCount >= PRELOAD_RETRY_LIMIT) return;
    preloadRetryCount += 1;
    preloadRetryTimer = setTimeout(() => {
      preloadRetryTimer = null;
      preloadNextThumbnails();
    }, PRELOAD_RETRY_MS);
  }

  function preloadNextThumbnails() {
    const nextLink = document.querySelector('nav.post__nav-links a.next[href]');
    if (!nextLink) {
      schedulePreloadRetry();
      return;
    }
    const nextUrl = nextLink.href;
    if (!nextUrl || nextUrl === lastPreloadNext) return;

    // 已经找到 next 了，停掉重试链
    preloadRetryCount = 0;
    if (preloadRetryTimer !== null) {
      clearTimeout(preloadRetryTimer);
      preloadRetryTimer = null;
    }
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
              // 低优先级：别和当前页首屏正在加载的图片抢带宽
              const resp = await fetch(url, { cache: 'force-cache', priority: 'low' });
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
    applyPanelMode(); // 未存档帖子 → 按钮换成「下载全部缩略图」+ 橙色
    attachImageButtons();
    addThumbnailStrip();
    refreshCount();
    // 导航栏是站点后渲染的：每次重绘顺手试一次（内部有去重，找到就不重复请求）
    preloadNextThumbnails();
  }

  function ensurePostUi() {
    ensurePanel();
    installPanelDrag(); // 幂等：面板建好后接上拖动能力
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
    // 预热下一页缩略图：立刻开始（原来等 1.5 秒，实测那样用户早就点 next 了）
    preloadNextThumbnails();
  }

  function applyRoute() {
    ensurePanel();
    installPanelDrag(); // 幂等：面板建好后接上拖动能力
    applyPanelMode(); // 非帖子页也要把文案复位成默认（没有 preview 徽标 → 默认模式）
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
    const firstRun = lastPath === '';
    lastPath = path;
    if (routeRefreshTimer) clearTimeout(routeRefreshTimer);
    // 首次进入（document_end）直接渲染，别等防抖：面板越早出现越好。
    // 之后的 htmx 切换才用很短的防抖，避免连续事件里重复渲染。
    const delay = firstRun ? 0 : 80;
    routeRefreshTimer = setTimeout(() => {
      routeRefreshTimer = null;
      applyRoute();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  chrome.storage.sync.get({ blockWords: DEFAULT_BLOCK_WORDS }, (settings) => {
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
  // 尽最早开始预热下一页（document_idle 时 DOM 已就绪，next 链接是服务端渲染的）。
  // 后面 applyRoute → ensurePostUi 还会再调一次，靠 lastPreloadNext 去重。
  preloadNextThumbnails();
})();
