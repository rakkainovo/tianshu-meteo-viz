/* ============================================================
   api.js —— 后端接口封装
   统一处理：JSON 解析、错误提示、结果缓存、并发去重
   ============================================================ */
(function (global) {
  'use strict';

  const cache = new Map();          // 相同 URL 的 GET 结果复用（地图 GeoJSON 体积大，收益明显）
  const inflight = new Map();

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
    if (useCache && cache.has(url)) return cache.get(url);
    if (inflight.has(url)) return inflight.get(url);

    const task = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' · ' + path);
        return r.json();
      })
      .then(j => {
        if (j && j.ok === false) throw new Error(j.msg || '接口返回失败');
        if (useCache) cache.set(url, j);
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
    alarmAgg:       (p) => get('/api/alarms/agg', p),
    alarmSeries:    (p) => get('/api/alarms/series', p),
    alarmPlayback:  (p) => get('/api/alarms/playback', p),
    stations:       (p) => get('/api/stations', p),
    stationRank:    (p) => get('/api/stations/rank', p),
    stationDetail:  (code) => get('/api/station/' + code),
    weatherTypes:   () => get('/api/stations/weather-types'),
    typhoons:       () => get('/api/typhoons'),
    typhoon:        (code) => get('/api/typhoon/' + code),
    typhoonTracks:  () => get('/api/typhoons/tracks'),
    typhoonOverview:() => get('/api/typhoons/overview'),
    regions:        (p) => get('/api/regions', p),
    regionLookup:   (name) => get('/api/regions/lookup', { name }),
    geo:            (adcode) => get('/api/geo/' + adcode),
    qa:             (q) => post('/api/qa', { q }),
    /* ---------- 实时引擎 ---------- */
    liveStatus:     (fresh) => get('/api/live/status', null, { fresh: fresh !== false }),
    liveEvents:     (limit) => get('/api/live/events', { limit }, { fresh: true }),
    liveObsSeries:  (limit) => get('/api/live/obs-series', { limit }, { fresh: true }),
    liveRun:        (job) => post('/api/live/run', { job }),
    /* 让指定前缀的缓存失效（实时刷新时只清掉真正变了的部分，地图 GeoJSON 依旧命中缓存） */
    invalidate(prefixes) {
      const list = [].concat(prefixes || []);
      for (const k of Array.from(cache.keys())) {
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
})(window);
