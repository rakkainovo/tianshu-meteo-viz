/* ============================================================
   api.js —— 后端接口封装
   统一处理：JSON 解析、错误提示、结果缓存、并发去重
   ============================================================ */
(function (global) {
  'use strict';

  const cache = new Map();          // 相同 URL 的 GET 结果复用（地图 GeoJSON 体积大，收益明显）
  const inflight = new Map();
  /* 缓存上限（LRU）：GeoJSON 单条几百 KB，全量驻留会把内存吃满。
     命中即刷新到队尾，超出上限时淘汰最久未用的一条。
     注意：这里淘汰的只是 fetch 的 JSON 副本；已 registerMap 的地图不受影响
     （MapHub 注册后直接返回名字，不会再发请求）。 */
  const CACHE_MAX = 300;
  /* 【软过期】业务数据 30 秒后视为过期，下次请求自动重取。
     为什么必须有：这里原本是**永不失效**的内存缓存，只有 SSE 的 update 事件
     或手动点"刷新"才会清。可后端的写入不一定每次都发 update（例如预警那轮
     "没有新增只有续期"时只发心跳），于是一旦漏掉一次信号，页面就会一直渲染
     首次打开时那份快照 —— 2026-10-08 那个"新鲜度 100% 但预警不动"的现象里，
     这是把后端问题放大成"看着像前端坏了"的关键一环。
     TTL 只兜底，不替代 invalidate：真正变了的接口仍由推送即时清掉。 */
  const CACHE_TTL = 30000;
  function ttlOf(url) {
    /* 行政区边界是静态资源，给它长 TTL，别跟着业务数据一起 30 秒重拉 */
    return url.indexOf('/api/geo/') === 0 ? 3600000 : CACHE_TTL;
  }
  function cacheGet(url) {
    if (!cache.has(url)) return undefined;
    const e = cache.get(url);
    if (Date.now() - e.t > ttlOf(url)) { cache.delete(url); return undefined; }
    cache.delete(url); cache.set(url, e);       // 命中 -> 移到队尾（最近使用）
    return e.v;
  }
  function cacheSet(url, v) {
    if (cache.has(url)) cache.delete(url);
    cache.set(url, { v, t: Date.now() });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function qs(params) {
    if (!params) return '';
    const p = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v));
    return p.length ? '?' + p.join('&') : '';
  }

  async function get(path, params, opts) {
    const url = path + qs(params);
    const useCache = !(opts && opts.fresh);
    if (useCache) {
      const cached = cacheGet(url);
      if (cached !== undefined) return cached;
    }
    if (inflight.has(url)) return inflight.get(url);

    const task = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + path);
        return r.json();
      })
      .then(j => {
        if (j && j.ok === false) throw new Error(j.msg || '接口返回失败');
        if (useCache) cacheSet(url, j);
        inflight.delete(url);
        return j;
      })
      .catch(e => { inflight.delete(url); throw e; });

    inflight.set(url, task);
    return task;
  }

  async function post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + path);
    const j = await r.json();
    if (j && j.ok === false) throw new Error(j.msg || '接口返回失败');
    return j;
  }

  global.API = {
    meta:           () => get('/api/meta'),
    alarms:         (p) => get('/api/alarms', p),
    /* 已失效落区：只给"当前 0 条生效"的省级单位当背景（见 server/app.py 注释） */
    alarmExpired:   (p) => get('/api/alarms/expired', p),
    alarmAgg:       (p) => get('/api/alarms/agg', p),
    alarmSeries:    (p) => get('/api/alarms/series', p),
    alarmPlayback:  (p) => get('/api/alarms/playback', p),
    stations:       (p) => get('/api/stations', p),
    stationRank:    (p) => get('/api/stations/rank', p),
    stationDetail:  (code) => get('/api/station/' + code),
    /* 打开站点详情时按需补采该站（后端对新鲜数据会自动跳过，force=1 强制刷新） */
    stationRefresh: (code, force) => post('/api/station/' + code + '/refresh' + (force ? '?force=1' : ''), {}),
    weatherTypes:   (p) => get('/api/stations/weather-types', p),
    typhoons:       () => get('/api/typhoons'),
    typhoon:        (code) => get('/api/typhoon/' + code),
    typhoonTracks:  () => get('/api/typhoons/tracks'),
    typhoonOverview:() => get('/api/typhoons/overview'),
    regions:        (p) => get('/api/regions', p),
    /* 按名称或 adcode 查区划；adcode 形式会一并返回 省->市->县 祖先链 */
    regionLookup:   (nameOrAdcode) => get('/api/regions/lookup',
      /^\d{6}$/.test(String(nameOrAdcode)) ? { adcode: nameOrAdcode } : { name: nameOrAdcode }),
    geo:            (adcode) => get('/api/geo/' + adcode),
    /* 全局搜索：跨行政区/站点/预警/台风，返回带跳转目标的分组结果 */
    search:         (q, limit) => get('/api/search', { q, limit }, { fresh: true }),
    /* 单条预警的落地上下文：最近气象站实况 + 该站未来几日预报 */
    alarmContext:   (id) => get('/api/alarms/' + encodeURIComponent(id) + '/context', null, { fresh: true }),
    qa:             (q, options) => post('/api/qa', Object.assign({ q }, options || {})),
    /* 问答引擎能力：规则通道是否可用、大模型通道是否已配置 */
    qaCapability:   () => get('/api/qa/capability'),
    /* ---------- 实时引擎 ---------- */
    liveStatus:     (fresh) => get('/api/live/status', null, { fresh: fresh !== false }),
    liveEvents:     (limit) => get('/api/live/events', { limit }, { fresh: true }),
    liveObsSeries:  (limit) => get('/api/live/obs-series', { limit }, { fresh: true }),
    liveRun:        (job) => post('/api/live/run', { job }),
    /* 让指定前缀的缓存失效（实时刷新时只清掉真正变了的部分，地图 GeoJSON 依旧命中缓存） */
    invalidate(prefixes) {
      const list = [].concat(prefixes || []);
      for (const k of Array.from(cache.keys())) {
        /* 行政区边界是静态资源，任何刷新都不失效（否则每次手动刷新都要重拉 600KB+） */
        if (k.indexOf('/api/geo/') === 0) continue;
        if (list.some(p => k.indexOf(p) === 0)) cache.delete(k);
      }
    },
    _cache: cache
  };

  /* ---------- 通用工具 ---------- */
  global.U = {
    /* 千分位 */
    num(n, d) {
      if (n === null || n === undefined || n === '') return '—';
      const v = Number(n);
      if (Number.isNaN(v)) return String(n);
      return d === undefined ? v.toLocaleString('zh-CN')
        : v.toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },
    /* 预警等级 -> CSS 类 */
    lvClass(lv) { return 'lv-' + (lv || '未知'); },
    /* 等级 -> 颜色 */
    lvColor(lv) {
      return ({ '红色': '#ff3b47', '橙色': '#ff8a00', '黄色': '#ffd233',
                '蓝色': '#3d7eff', '未知': '#7a8aa0' })[lv] || '#7a8aa0';
    },
    /* 灾种 -> 颜色（与后端保持一致） */
    typeColor(t) {
      return ({
        '暴雨': '#2f9bff', '大风': '#41d6c3', '雷电': '#b48bff', '大雾': '#9aa7b8',
        '寒潮': '#4dd0ff', '高温': '#ff6b35', '地质灾害': '#c08b5c', '雷雨大风': '#5bc8ff',
        '暴雪': '#8fd6ff', '道路结冰': '#a8e0ff', '雷暴大风': '#7f9cff', '沙尘暴': '#d9b26b',
        '冰雹': '#8ee6a8', '霜冻': '#9ad0e6', '台风': '#ff4d6d', '霾': '#b0a58c',
        '干旱': '#e0a44a', '其他': '#6f7c90'
      })[t] || '#6f7c90';
    },
    /* 时间压缩："2026-09-18 10:24" -> "09-18 10:24" */
    shortTime(ts) { return (ts || '').slice(5); },
    /* 相对时间："2026-09-18 14:41:03" -> "12 秒前 / 3 分钟前" */
    ago(ts) {
      if (!ts) return '—';
      const t = new Date(String(ts).replace(/-/g, '/')).getTime();
      if (Number.isNaN(t)) return String(ts).slice(5);
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 5) return '刚刚';
      if (s < 60) return s + ' 秒前';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      return Math.floor(s / 86400) + ' 天前';
    },
    /* 秒数 -> 倒计时文本 */
    countdown(s) {
      if (s === null || s === undefined) return '—';
      s = Math.max(0, Math.round(s));
      if (s < 60) return s + 's';
      return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
    },
    /* 实时更新是否属于"新鲜"（用于 NEW 徽标） */
    isNew(ts, minutes) {
      if (!ts) return false;
      const t = new Date(String(ts).replace(/-/g, '/')).getTime();
      return !Number.isNaN(t) && (Date.now() - t) < (minutes || 10) * 60000;
    },
    /* 去掉行政区后缀，用于紧凑展示 */
    shortName(n) {
      return (n || '').replace(/(维吾尔自治区|回族自治区|壮族自治区|特别行政区|自治区|自治州|地区|省|市)$/, '') || n;
    },
    /* 防抖 */
    debounce(fn, ms) {
      let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
    },
    /* 数组按 key 分组 */
    groupBy(arr, key) {
      return (arr || []).reduce((m, x) => ((m[key(x)] = m[key(x)] || []).push(x), m), {});
    }
  };

  /* ---------- 预警收藏（关注） ----------
     存 localStorage：跨页面 / 刷新都保留。每个用到它的视图在 created 时
     读一份进自己的响应式数组，切换时 toggle 返回新数组整体替换。 */
  global.Fav = {
    key: 'tianshu.fav.v1',
    all() {
      try { const v = JSON.parse(localStorage.getItem(this.key) || '[]'); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    },
    save(list) { try { localStorage.setItem(this.key, JSON.stringify(list)); } catch (e) { /* ignore */ } },
    has(id) { return this.all().indexOf(id) >= 0; },
    toggle(id) {
      const l = this.all();
      const i = l.indexOf(id);
      if (i >= 0) l.splice(i, 1); else l.push(id);
      this.save(l);
      return l;
    }
  };
})(window);
