// 主世界（MAIN world）里的弹窗拦截器。
//
// 为什么必须单独一个文件：内容脚本默认跑在**隔离世界**，它 patch window.open
// 对页面自己的脚本完全无效（两者是不同 window 对象）。pawchive 的 popunder
// 脚本跑在页面主世界，所以必须用 manifest 里 world:"MAIN" 的脚本去拦。
//
// 策略：页面自己调用 window.open 时，只放行「用户真的点了的链接」——
// content.js（隔离世界）在点击/中键点击时通过 window.postMessage 把目标 URL
// 登记到预授权集合，其余一律拒绝。这样既能挡掉 popunder，又不影响用户
// 用中键正常打开帖子/附件链接。
'use strict';

(() => {
  if (window.__pdMainGuardInstalled) return;
  window.__pdMainGuardInstalled = true;

  const PREAUTH_TTL_MS = 2000;
  const preAuth = new Map(); // url -> 过期时间戳
  let blockedCount = 0;

  // 供子 frame 查询顶层窗口的预授权集合
  window.__pdMainGuardAuth = preAuth;

  function prune(now) {
    for (const [url, until] of preAuth) {
      if (until < now) preAuth.delete(url);
    }
  }

  // 只放行「同源」或「显式预授权」的地址。跨域弹窗一律拒绝，
  // 因为本站的正常弹窗（中键开链接）都会先经过 content.js 预授权。
  function decide(rawUrl, now) {
    prune(now);
    let resolved;
    try {
      resolved = new URL(String(rawUrl), location.href);
    } catch (err) {
      return { allow: true, url: String(rawUrl) }; // 传了奇怪的东西，交给浏览器
    }
    const text = resolved.href;
    if (preAuth.has(text) || preAuth.has(String(rawUrl))) {
      return { allow: true, url: text };
    }
    // 子 frame 里的弹窗：顶层窗口可能才是收到预授权的那个
    try {
      if (window !== window.top && window.top.__pdMainGuardAuth) {
        const topAuth = window.top.__pdMainGuardAuth;
        if (topAuth.has(text) || topAuth.has(String(rawUrl))) {
          return { allow: true, url: text };
        }
      }
    } catch (err) {
      // 跨域拿不到 top，忽略
    }
    if (resolved.hostname === location.hostname) {
      return { allow: true, url: text };
    }
    if (resolved.protocol === 'about:' || resolved.protocol === 'javascript:') {
      return { allow: true, url: text };
    }
    return { allow: false, url: text };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__pdAuth !== 'pawchive-downloader') return;
    const url = String(data.url || '');
    if (!url) return;
    preAuth.set(url, Date.now() + PREAUTH_TTL_MS);
  });

  try {
    const nativeOpen = window.open;
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: false, // 防页面脚本把 window.open 抢回去
      value: function (url, ...rest) {
        const verdict = decide(url, Date.now());
        if (!verdict.allow) {
          blockedCount += 1;
          console.debug(
            '[Pawchive Downloader] 主世界已拦截广告弹窗:',
            verdict.url.slice(0, 120),
            `(第 ${blockedCount} 次)`
          );
          // 直接返回 null：这是浏览器拦截弹窗时的标准语义，
          // 调用方拿不到窗口引用；不要返回 about:blank 的窗口代理，
          // 那会真的开出一个白窗口。
          return null;
        }
        return nativeOpen.apply(window, [url, ...rest]);
      }
    });
  } catch (err) {
    // 定义失败就放弃；网络层 rules.json 仍在兜底
  }
})();
