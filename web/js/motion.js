/* ============================================================
   motion.js —— 浮层"从缩略图长出来 / 缩回去"的共用动效原语
   （2026-09-30）

   背景：总览的放大层（.bigview/.bv-card）和站点页的全屏弹窗
   （.chart-modal/.chart-modal-box）是同一类交互 ——"点了某个缩略图，
   它长成一张大画布"。两处曾经各写一套，第二套还停在"居中 scale(.965) 弹出"
   的旧观感上。这里把几何计算与关键帧抽出来共用。

   三条经验规则（都是踩出来的，改之前先读）：
   ① **等比缩放**：不要 scale(sx, sy)。横竖比例不一致会把文字和图表拉扯变形，
      看着就是"橡皮泥"。起点比例取 max(w比, h比) —— 恰好框住来源矩形。
   ② **中心锚点**：不要 transform-origin:0 0 + 左上角对齐。人眼看的是缩略图
      **中心**，所以起点位移要按两个矩形的中心差算，生长方向才符合直觉。
   ③ **fill 语义**：退场动画用 fill:'forwards'，播完要等 DOM 卸载再 cancel；
      提前 cancel 会让元素弹回初始样式（闪一帧）。
   ============================================================ */
(function () {
  'use strict';

  /* 进场：快起慢收（"利落但不生硬"）；退场：慢起快收（"收走"） */
  const EASE_IN = 'cubic-bezier(.2, .85, .25, 1)';
  const EASE_OUT = 'cubic-bezier(.45, .05, .6, .95)';

  /* 系统开了"减少动态效果"就不演 —— 动画是装饰，不该和可访问性偏好对着干 */
  function reduce() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function rectOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return (r && r.width > 1 && r.height > 1)
      ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }

  /* 从点击事件反查"缩略图"来源矩形：优先面板/卡片级祖先（sel），
     匹配不到就退化为按钮自身。拿不到事件（深链、程序调用）返回 null，
     调用方退化成"居中轻缩放"的进场。 */
  function source(ev, sel) {
    if (!ev || !ev.currentTarget) return null;
    const el = (sel && ev.currentTarget.closest && ev.currentTarget.closest(sel)) || ev.currentTarget;
    return rectOf(el);
  }

  /* FLIP 几何：中心对齐 + 等比。k 夹在 [.18, 1]，避免从很小的按钮打开时
     起点小得夸张（那样看起来更像"凭空出现"而不是"长出来"）。 */
  function geom(src, to) {
    const tx = (src.x + src.w / 2) - (to.x + to.w / 2);
    const ty = (src.y + src.h / 2) - (to.y + to.h / 2);
    const k = Math.min(1, Math.max(.18, Math.max(src.w / to.w, src.h / to.h)));
    return { tx: tx, ty: ty, k: k, km: k + (1 - k) * .62 };
  }

  /* 进场帧。src 为空则退化为居中轻微缩放（深链打开的场景） */
  function inFrames(el, src) {
    const to = rectOf(el);
    if (src && src.w > 1 && to) {
      const g = geom(src, to);
      return [
        { transform: `translate(${g.tx.toFixed(1)}px, ${g.ty.toFixed(1)}px) scale(${g.k.toFixed(4)})`, opacity: 0 },
        { transform: `translate(${(g.tx * .22).toFixed(1)}px, ${(g.ty * .22).toFixed(1)}px) scale(${g.km.toFixed(4)})`, opacity: .92, offset: .45 },
        { transform: 'translate(0px, 0px) scale(1.004)', opacity: 1, offset: .84 },
        { transform: 'translate(0px, 0px) scale(1)', opacity: 1 }
      ];
    }
    return [
      { transform: 'translateY(14px) scale(.965)', opacity: 0 },
      { transform: 'translateY(0px) scale(1.003)', opacity: 1, offset: .8 },
      { transform: 'translateY(0px) scale(1)', opacity: 1 }
    ];
  }

  /* 退场帧：反向缩回来源矩形；无来源时轻微下沉淡出 */
  function outFrames(el, src) {
    const to = rectOf(el);
    if (src && src.w > 1 && to) {
      const g = geom(src, to);
      return [
        { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
        { transform: `translate(${(g.tx * .5).toFixed(1)}px, ${(g.ty * .5).toFixed(1)}px) scale(${(g.k + (1 - g.k) * .45).toFixed(4)})`, opacity: .55, offset: .55 },
        { transform: `translate(${g.tx.toFixed(1)}px, ${g.ty.toFixed(1)}px) scale(${g.k.toFixed(4)})`, opacity: 0 }
      ];
    }
    return [
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
      { transform: 'translate(0px, 8px) scale(.97)', opacity: 0 }
    ];
  }

  function fadeFrames(inOut) {
    return inOut ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
  }

  /* 统一播放入口：返回 Animation（无 WAAPI 的环境返回 null，静默降级） */
  function play(el, frames, dur, easing, fill) {
    if (!el || !el.animate) return null;
    try {
      return el.animate(frames, { duration: dur, easing: easing || EASE_IN, fill: fill || 'none' });
    } catch (e) { return null; }
  }

  /* 一批动画全部结束（含被取消的情况，此时按"结束"处理，保证状态机能收尾） */
  function whenDone(anims, cb) {
    const list = (anims || []).filter(Boolean);
    if (!list.length) { cb(); return; }
    Promise.all(list.map(a => a.finished.catch(() => {}))).then(cb);
  }

  window.Motion = {
    EASE_IN: EASE_IN, EASE_OUT: EASE_OUT,
    IN_DUR: 440, OUT_DUR: 280,      /* 与总览放大层保持一致，两处观感统一 */
    reduce: reduce, rectOf: rectOf, source: source,
    geom: geom, inFrames: inFrames, outFrames: outFrames, fadeFrames: fadeFrames,
    play: play, whenDone: whenDone
  };
})();
