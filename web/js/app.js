/* ============================================================
   app.js —— 应用外壳：导航栏 / 路由 / 全局状态 / 实时推送接入
   ============================================================ */
(function () {
  'use strict';

  const ICON = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z"/></svg>',
    alarm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l8 14H4z"/><path d="M12 9v5M12 16.5v.6"/></svg>',
    station: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    typhoon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5c4 0 6 3 6 5M12 19c-4 0-6-3-6-5"/><path d="M19 10c0 5-4 6-7 6M5 14c0-5 4-6 7-6"/><circle cx="12" cy="12" r="1.6"/></svg>',
    playback: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.5V12l3 2"/></svg>',
    live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 12h3.5l2-5 3 10 2.4-6 1.6 3h5.5"/></svg>',
    qa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12a7.6 7.6 0 01-10.8 6.9L4 20l1.1-4.2A7.6 7.6 0 1120 12z"/><path d="M9.4 9.6a2.6 2.6 0 115 1c0 1.7-2.4 1.9-2.4 3.3M12 17v.01"/></svg>'
  };

  /* 数据变更 -> 需要失效的接口前缀（只清真正变了的部分，地图缓存保留） */
  const BUST = {
    alarm: ['/api/alarms', '/api/meta'],
    weather: ['/api/stations', '/api/station/', '/api/meta'],
    typhoon: ['/api/typhoon', '/api/meta']
  };

  const App = {
    data() {
      return {
        booted: false, bootError: '', bootKpi: {}, toast: '', toastType: 'success', refreshing: false, liveFlash: false,
        view: 'overview',
        viewTransition: 'view-forward',
        route: {},                     // 当前 hash 里的查询参数（可分享、可后退）
        _seq: 0,                       // 路由序列号：同页连续跳转也要让页面收到通知
        meta: {},
        /* ---------- 全局搜索面板 ---------- */
        searchOpen: false,
        searchQ: '',
        searchGroups: [],
        searchLoading: false,
        searchCursor: 0,
        views: [
          { key: 'overview', name: '态势总览', icon: ICON.overview },
          { key: 'sandtable', name: '三维沙盘', icon: window.lucide.createElement(window.lucide.icons.Layers, { width: 16, height: 16 }).outerHTML },
          { key: 'alarm',    name: '预警地图', icon: ICON.alarm },
          { key: 'station',  name: '站点实况', icon: ICON.station },
          { key: 'typhoon',  name: '台风路径', icon: ICON.typhoon },
          { key: 'playback', name: '时空回放', icon: ICON.playback },
          { key: 'live',     name: '实时引擎', icon: ICON.live },
          { key: 'qa',       name: '智能问答', icon: ICON.qa }
        ],
        ctx: {},                       // 跨页面上下文（保留兼容；新代码请用 route）
        /* ---------- 实时状态 ---------- */
        liveOn: true,                  // 自动刷新开关
        liveConnected: false,
        liveConnState: 'connecting',   // SSE 连接态：connecting / open / error（驱动顶栏「重连」）
        liveVersion: 0,
        liveLastAt: '',                // 最近一次数据更新时刻
        liveLastJob: '',               // 最近一次更新的任务
        liveNewest: 0,                 // 最近一次新增条数
        liveJobs: [],                  // 任务状态（顶栏倒计时用）
        liveCoverage: null,            // 近 15 分钟已刷新的站点占比（数据有多"新"的诚实指标）
        /* 预警是**另一条独立支路**：观测 100% 不代表预警是新的。
           2026-10-08 就因为把这两者混在一起读，顶栏显示"新鲜度 100%"时
           预警数据其实已经冻了 5 天。两个口径必须分开摆在台面上。 */
        liveAlarmIngested: '',         // 预警最近一次成功采集时刻
        liveAlarmStale: false,         // 预警采集已停摆（后端按 >36h 判定）
        liveEnabled: true,             // 实时引擎是否启用（false = 纯静态数据集）
        sourceOk: true,                // 外部数据源是否可达（断网/被封时 false）
        sourceNote: '',
        liveWarming: false,            // 启动预热中（前几轮连续采集，覆盖率正在爬升）
        liveServerTime: '',            // 后端当前时间（与本地时钟对齐用）
        clock: ''                      // 每秒刷新，用于"x 秒前"的走字
      };
    },
    computed: {
      /* 搜索结果拍平成一维，供 ↑↓ 光标遍历 */
      searchFlat() {
        const out = [];
        (this.searchGroups || []).forEach(g => {
          (g.items || []).forEach(it => out.push(Object.assign({ _kind: g.kind, _label: g.label }, it)));
        });
        return out;
      },
      sourceTip() {
        const m = this.meta.meta || {};
        return [m.source_alarm, m.source_station, m.source_typhoon].filter(Boolean).join('\n');
      },
      /* 顶栏副标题：不用"最近一站更新时间"充数（那会掩盖大多数站点其实很旧的事实），
         而是直接把"数据截至 + 全国覆盖率"写出来。
         同时把**预警口径**一并标出 —— 它与实况是两条独立支路，只报一个会误导。 */
      liveText() {
        if (!this.liveEnabled) return '离线数据集';
        if (!this.sourceOk) return `数据源不可达 · 截至 ${U.shortTime(this.liveLastAt) || '—'}`;
        if (!this.liveLastAt) return '等待首个更新周期';
        const cov = this.liveCoverage;
        /* 措辞写全：光"覆盖 42%"容易被读成"数据只采到 42%"，
           它其实是"近 15 分钟内刷新过的站点占比"，衡量的是数据**有多新** */
        const obs = (cov === null || cov === undefined)
          ? '实况 —' : `实况 ${Math.round(cov * 100)}%`;
        if (!this.liveAlarmIngested) return obs + ' · 预警待采集';
        const a = U.ago(this.liveAlarmIngested);
        return this.liveAlarmStale ? `${obs} · 预警停摆 ${a}` : `${obs} · 预警 ${a}`;
      },
      /* 覆盖率分级，给徽标上色：够新=绿、偏旧=黄、严重滞后/断源=红 */
      liveCovLevel() {
        if (!this.liveEnabled || !this.liveOn) return '';
        if (!this.sourceOk) return 'stale';
        /* 预警停摆时用"偏旧"而不是"红"：实况本身是好的，不该整块标红，
           但也不能继续显示健康的绿色，否则又是一个"看着 100% 其实坏了" */
        if (this.liveAlarmStale) return 'mid';
        const c = this.liveCoverage;
        if (c === null || c === undefined) return '';
        if (this.liveWarming) return 'mid';
        if (c >= 0.8) return 'ok';
        if (c >= 0.4) return 'mid';
        return 'stale';
      },
      /* 悬停说明：把"覆盖率到底是什么意思"讲清楚，避免被误读成数据完整度 */
      liveTitle() {
        const parts = [`数据版本 v${this.liveVersion}`];
        if (this.liveEnabled) {
          const cov = (this.liveCoverage === null || this.liveCoverage === undefined)
            ? '—' : Math.round(this.liveCoverage * 100) + '%';
          parts.push('── 顶栏两个数字分别是什么意思 ──');
          parts.push(`实况 ${cov}：全国站点里，实况在近 15 分钟内刷新过的比例。`);
          parts.push(`预警 ${this.liveAlarmIngested ? U.ago(this.liveAlarmIngested) : '—'}：`
                     + '预警清单最近一次成功采集距今多久。');
          parts.push('两者是**两条独立支路**，互不代表——实况 100% 时预警仍可能停在几天前。');
          if (this.liveAlarmStale) {
            parts.push('注意：预警采集已停摆超过 36 小时，地图上的预警点取自更早那一轮，');
            parts.push('请查看后端日志与实时引擎页的「预警信号」任务卡。');
          }
          parts.push('── 「预热中」是什么意思 ──');
          parts.push('引擎刚启动的一段时间里，采集器按"最久没刷新优先"逐轮补采全国 2528 个站点，');
          parts.push('要跑满若干轮（每轮约 320 站）新鲜度才会顶上来，这期间标成"预热中"。');
          if (this.liveWarming) parts.push('当前：正在预热，新鲜度正在爬升。');
          parts.push('── 「实况新鲜度」是什么意思 ──');
          parts.push(`当前 ${cov}：全国站点里，实况在近 15 分钟内刷新过的比例。`);
          parts.push('它衡量的是"数据有多新"，不是"数据全不全"——库里始终有全部 2528 站的记录，');
          parts.push('但轮转一圈要约 7 分钟，所以任何时刻总有一部分站是几分钟前采的。');
          parts.push('── 其它 ──');
          parts.push(`数据截止 ${this.liveLastAt || '—'}`);
          if (this.sourceNote) parts.push(`注意：${this.sourceNote}`);
          parts.push(`服务端时间 ${this.liveServerTime || '—'}`);
        } else {
          parts.push('实时引擎未启用：以本地静态数据集提供查询，不联网');
        }
        return parts.join('\n');
      },
      liveState() {
        if (!this.liveOn) return 'paused';
        return this.liveConnected ? 'on' : 'off';
      },
      /* 顶栏徽标文案：把「连接中 / 已断开」区分开，断线时给出可点的重连提示 */
      liveConnText() {
        if (!this.liveEnabled) return '离线';
        if (!this.sourceOk) return '数据源异常';
        if (!this.liveOn) return '已暂停';
        if (this.liveConnected) return '实时';
        return this.liveConnState === 'error' ? '已断开' : '连接中';
      },
      toastIcon() {
        const t = this.toastType || 'success';
        if (t === 'warn') return '<svg viewBox="0 0 24 24" fill="none" stroke="#ff8a00" stroke-width="2"><path d="M12 3l9 16H3z"/><path d="M12 9v5M12 16.5v.6"/></svg>';
        if (t === 'info') return '<svg viewBox="0 0 24 24" fill="none" stroke="#3fc6ff" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.6"/></svg>';
        return '<svg viewBox="0 0 24 24" fill="none" stroke="#7cf6d8" stroke-width="2"><path d="M20 7L9 18l-5-5"/></svg>';
      }
    },
    async created() {
      try {
        const m = await API.meta();
        const k = m.kpi || {};
        m.timestamp_text = (k.ts_to || '').replace(/^\d{4}-/, '').replace(' ', ' ');
        this.meta = m;
        /* 把 KPI 填到封面，让数字浮现动画跑完，等待用户点击「进入平台」 */
        this.bootKpi = {
          alarm_total: k.alarm_total || 0,
          station_total: k.station_total || 0,
          typhoon_total: k.typhoon_total || 0
        };
      } catch (e) {
        this.bootError = e.message || String(e);
      }
      this.syncHash();
      window.addEventListener('hashchange', this.syncHash);
      /* ?enter=1 跳过封面直入指定页面：答辩深链 / 自动化截图用
         （例：http://127.0.0.1:5000/?enter=1#/alarm） */
      if (/[?&]enter=1/.test(location.search)) this.booted = true;
      /* Ctrl/⌘ + K 呼出全局搜索；输入中用 Esc 关闭（其余按键照常输入） */
      this._onHotkey = e => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
          e.preventDefault();
          this.toggleSearch();
          return;
        }
        if (e.key === 'Escape' && this.searchOpen) { this.searchOpen = false; }
      };
      window.addEventListener('keydown', this._onHotkey);
      this.startClock();
      this.connectLive();
      /* 页面切到后台时暂停重活：SSE 数据照常到达（缓存照旧失效），
         但不刷新图表、不弹 toast；回到前台再一次性补齐，省 CPU/GPU */
      this._onVis = () => {
        if (document.hidden) return;
        this.syncLiveStatus();
        this.onLiveData({ job: 'resume', new: 0 });
      };
      document.addEventListener('visibilitychange', this._onVis);
    },
    watch: {
      searchQ() {
        if (!this._searchD) {
          this._searchD = U.debounce(() => this.runSearch(), 180);
        }
        this._searchD();
      }
    },
    beforeUnmount() {
      if (this._es) this._es.close();
      clearInterval(this._clockT);
      clearInterval(this._statT);
      window.removeEventListener('keydown', this._onHotkey);
      document.removeEventListener('visibilitychange', this._onVis);
    },
    methods: {
      /* 解析 hash：#/alarm?prov=广东省&focus=xxx -> {key:'alarm', params:{...}} */
      parseHash() {
        const raw = (location.hash || '#/overview').replace(/^#\/?/, '');
        const qi = raw.indexOf('?');
        const path = (qi < 0 ? raw : raw.slice(0, qi)).replace(/\/$/, '');
        const params = {};
        if (qi >= 0) {
          raw.slice(qi + 1).split('&').forEach(kv => {
            const i = kv.indexOf('=');
            if (i <= 0) return;
            try {
              params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
            } catch (e) { /* 非法转义直接跳过 */ }
          });
        }
        return { key: this.views.some(v => v.key === path) ? path : 'overview', params };
      },
      /* 参数对象 -> 查询串（空值一律省略，保持 URL 干净） */
      qs(params) {
        return Object.entries(params || {})
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
          .join('&');
      },
      /* hash 是唯一事实来源：view 与 route 都由它推导 */
      syncHash() {
        const { key, params } = this.parseHash();
        const from = this.views.findIndex(v => v.key === this.view);
        const to = this.views.findIndex(v => v.key === key);
        if (key !== this.view && from >= 0 && to >= 0) {
          this.viewTransition = to >= from ? 'view-forward' : 'view-back';
        }
        this.view = key;
        this.route = Object.assign({}, params, { _seq: this.nextSeq() });
      },
      /* 用户点击封面「进入平台」按钮 -> 淡出封面，进入主程序 */
      enterApp() {
        this.booted = true;
      },
      /* 全站唯一的跳转入口：写 hash -> hashchange -> syncHash。
         params 会进 URL，所以任何视图状态都能被复制/分享/前进后退。 */
      go(key, params) {
        const hash = '#/' + key + (this.qs(params) ? '?' + this.qs(params) : '');
        if (location.hash === hash) {
          /* 同一个 URL 再点一次（例如搜索结果点了两次同一站）也要让页面重新响应 */
          this.route = Object.assign({}, params, { _seq: this.nextSeq() });
          return;
        }
        location.hash = hash;
      },
      /* 递增的路由序号。故意写成 (x || 0) + 1 而非 ++this._seq ——
         私有字段第一次读是 undefined，自增会得到 NaN，而 NaN !== NaN
         会让所有 `token === this._seq` 的竞态守卫永久失效（踩过）。 */
      nextSeq() { this._seq = (this._seq || 0) + 1; return this._seq; },
      /* 子页面要求跳转并带上目标参数 */
      onPick(payload) {
        if (payload && payload.view) {
          this.ctx = Object.assign({}, this.ctx, payload);
          this.go(payload.view, payload.params);
        }
      },
      onContext(payload) {
        this.ctx = Object.assign({}, this.ctx, payload || {});
      },
      flash(msg, type) {
        this.toast = msg;
        this.toastType = type || 'success';
        clearTimeout(this._tt);
        this._tt = setTimeout(() => { this.toast = ''; }, 2400);
      },

      /* ---------------- 全局搜索（Ctrl+K） ---------------- */
      toggleSearch(force) {
        const want = (force === undefined) ? !this.searchOpen : !!force;
        this.searchOpen = want;
        if (want) {
          this.$nextTick(() => { const i = this.$refs.searchInput; if (i) i.focus(); });
          if (!this.searchQ) { this.searchGroups = []; this.searchCursor = 0; }
        }
      },
      closeSearch() { this.searchOpen = false; },
      async runSearch() {
        const q = (this.searchQ || '').trim();
        this.searchCursor = 0;
        if (!q) { this.searchGroups = []; this.searchLoading = false; return; }
        this.searchLoading = true;
        const token = (this._searchSeq || 0) + 1;
        this._searchSeq = token;
        try {
          const r = await API.search(q, 6);
          if (token !== this._searchSeq) return;      // 已被更新的输入取代
          this.searchGroups = r.groups || [];
        } catch (e) {
          if (token === this._searchSeq) this.searchGroups = [];
        } finally {
          if (token === this._searchSeq) this.searchLoading = false;
        }
      },
      searchMove(d) {
        const n = this.searchFlat.length;
        if (!n) return;
        this.searchCursor = (this.searchCursor + d + n) % n;
      },
      searchPick() {
        const it = this.searchFlat[this.searchCursor];
        if (it) this.searchGo(it);
      },
      /* 打开某个搜索结果：目标（页面 + 参数）由后端给好，前端照着跳 */
      searchGo(it) {
        if (!it || !it.target) return;
        this.closeSearch();
        this.go(it.target.view, it.target.params);
        this.flash('已定位到：' + it.title);
      },

      /* ---------------- 实时推送 ---------------- */
      /* 拉一次引擎状态：版本号、数据截止时刻、全国覆盖率、后端时钟 */
      async syncLiveStatus() {
        try {
          const s = await API.liveStatus(true);
          const f = s.freshness || {};
          const src = s.source || {};
          this.liveEnabled = s.enabled !== false;
          this.sourceOk = src.ok !== false;
          this.sourceNote = src.note || '';
          this.liveWarming = !!s.warming;
          this.liveVersion = s.version || 0;
          this.liveLastAt = f.obs_updated_at || f.alarm_ingested || '';
          this.liveAlarmIngested = f.alarm_ingested || '';
          this.liveAlarmStale = !!f.alarm_stale;
          this.liveCoverage = (typeof f.coverage === 'number') ? f.coverage : null;
          this.liveServerTime = s.server_time || '';
          this.liveJobs = s.jobs || [];

          /* 【兜底刷新】后端写入了新数据、却没发 update 事件时（例如预警那一轮
             只有"续期"没有"新增"，按设计只发心跳），靠这个指纹变化也能把页面叫醒。
             光有缓存 TTL 不够：TTL 只是让请求"可以"重取，没人发起请求照样白搭。
             指纹取版本号 + 两条支路各自的最近写入时刻，任一变化即说明数据变了。 */
          const alarmJob = (s.jobs || []).find(job => job.name === 'alarm');
          // Successful scans can remove/renew alerts without inserting any new IDs.
          const alarmScan = alarmJob && alarmJob.last_ok ? alarmJob.last_run : '';
            // 跨北京时间零点也刷新：即使采集没有变化，昨日预警也应退出今日视图。
            const chinaDay = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const fp = [s.version, f.alarm_ingested || '', alarmScan, f.obs_updated_at || '', chinaDay].join('|');
          const changed = this._liveFp !== undefined && this._liveFp !== fp;
          this._liveFp = fp;
          if (changed && this.liveOn && !document.hidden) {
            API.invalidate(['/api/']);
            const stage = this.$refs.stage;
            if (stage && typeof stage.onLive === 'function') {
              try { await stage.onLive({ job: 'poll', new: 0 }); } catch (e) { /* 静默 */ }
            }
          }
        } catch (e) { /* 服务不可达时保留上一次状态，页面上仍能看到旧时间 */ }
      },
      connectLive() {
        /* 静态模式：url 带 ?static=1 时不建立长连接（截图、答辩演示更稳），
           数据仍是后端实时更新的，只是本页不自动刷新 */
        this.syncLiveStatus();
        /* 覆盖率不是每次数据变更都变，30 秒对齐一次后端即可（避免频繁聚合查询） */
        clearInterval(this._statT);
        this._statT = setInterval(() => this.syncLiveStatus(), 30000);
        if (/[?&]static=1/.test(location.search)) {
          this.liveOn = false;
          return;
        }
        this.openLiveStream();
      },
      /* 建立（或重建）SSE 长连接。EventSource 原生会自动重连（约 3s），
         这里把它单独拆出来，供「重连」按钮复用；状态走 liveConnState
         驱动顶栏徽标（连接中 / 实时 / 已断开）。 */
      openLiveStream() {
        if (!window.EventSource) return;
        if (this._es) { try { this._es.close(); } catch (e) { /* ignore */ } this._es = null; }
        this.liveConnState = 'connecting';
        const es = new EventSource('/api/live/stream');
        this._es = es;
        es.onopen = () => { this.liveConnected = true; this.liveConnState = 'open'; };
        es.onerror = () => { this.liveConnected = false; this.liveConnState = 'error'; };
        es.addEventListener('tick', e => {
          const d = JSON.parse(e.data);
          this.liveConnected = true;
          if (d.jobs) this.liveJobs = d.jobs;
          if (d.version > this.liveVersion) this.liveVersion = d.version;
        });
        es.addEventListener('update', e => this.onLiveData(JSON.parse(e.data)));
      },
      /* 手动重连：断线（或长时间连不上）时立即重建连接，不等浏览器的自动重试 */
      reconnectLive() {
        this.flash('正在重连实时通道 …', 'info');
        this.openLiveStream();
      },
      /* 引擎写入新数据：失效缓存 -> 刷新顶栏 -> 通知当前页面增量刷新 */
      async onLiveData(msg) {
        this.liveConnected = true;
        if (msg.version) this.liveVersion = msg.version;
        this.liveLastAt = msg.at || this.liveLastAt;
        this.liveLastJob = msg.job || '';
        this.liveNewest = msg.new || 0;
        if (!this.liveOn) return;
        API.invalidate(msg.job === 'resume' ? ['/api/'] : BUST[msg.job] || ['/api/meta']);
        /* 后台：只失效缓存（保证回到前台能拿到新数据），不刷图、不弹 toast */
        if (document.hidden) return;
        try {
          const m = await API.meta();
          const k = m.kpi || {};
          m.timestamp_text = (k.ts_to || '').replace(/^\d{4}-/, '');
          this.meta = m;
        } catch (e) { /* 静默：下一轮会再试 */ }

        const stage = this.$refs.stage;
        if (stage && typeof stage.onLive === 'function') {
          try { await stage.onLive(msg); } catch (e) { console.error('[live] 页面刷新失败', e); }
        }
        if (msg.job === 'alarm' && msg.new) this.flash(`⚡ 实时更新：新增 ${msg.new} 条预警信号`);
        else if (msg.job === 'weather' && msg.new) this.flash(`⚡ 实时更新：${msg.new} 个站点实况已刷新`, 'info');
        else if (msg.job === 'typhoon' && msg.new) this.flash('⚡ 实时更新：台风路径已刷新', 'info');
        /* 徽标短闪一下，让"收到数据"看得见 */
        this.liveFlash = true;
        clearTimeout(this._lfT);
        this._lfT = setTimeout(() => { this.liveFlash = false; }, 1000);
      },
      /* 视图切换过渡结束后，给图表一次 resize（mode=out-in 下组件刚挂载完） */
      onViewEntered() {
        this.$nextTick(() => window.dispatchEvent(new Event('resize')));
      },
      /* 手动刷新：清缓存 + 重新拉取当前页数据 */
      async manualRefresh() {
        if (this.refreshing) return;
        this.refreshing = true;
        try {
          API.invalidate(['/api/']);
          try {
            const m = await API.meta();
            m.timestamp_text = ((m.kpi || {}).ts_to || '').replace(/^\d{4}-/, '');
            this.meta = m;
          } catch (e) { /* ignore */ }
          const stage = this.$refs.stage;
          if (stage && typeof stage.onLive === 'function') {
            await stage.onLive({ job: 'manual', new: 0 });
          }
          this.flash('已按最新数据刷新当前页面');
        } finally {
          this.refreshing = false;
        }
      },
      toggleLive() {
        this.liveOn = !this.liveOn;
        this.flash(this.liveOn ? '已开启自动刷新' : '已暂停自动刷新（数据仍在后台更新）');
      },
      /* 每秒走字，让"x 秒前 / 倒计时"保持准确 */
      startClock() {
        const tick = () => {
          this.clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        };
        tick();
        this._clockT = setInterval(tick, 1000);
      }
    }
  };

  const app = Vue.createApp(App);

  /* 全局注入：
     · U —— 工具函数
     · flash —— 提示条。子视图直接 this.flash(msg) 即可，
       不必各自 $emit；根组件自己的 flash 优先级更高（mixin 被子组件覆盖） */
  app.mixin({
    computed: { U: () => window.U },
    methods: {
      flash(msg, type) {
        const root = this.$root;
        if (root && root !== this && typeof root.flash === 'function') root.flash(msg, type);
      }
    }
  });

  app.component('v-overview', window.ViewOverview);
  app.component('v-sandtable', window.ViewSandtable);
  app.component('v-alarm', window.ViewAlarm);
  app.component('v-station', window.ViewStation);
  app.component('v-typhoon', window.ViewTyphoon);
  app.component('v-playback', window.ViewPlayback);
  app.component('v-live', window.ViewLive);
  app.component('v-qa', window.ViewQA);

  /* v-countup：KPI 数值变化时从旧值 tween 到新值（~600ms easeOutCubic）。
     首屏直接渲染终值不滚动；只对后续变化（实时推送）滚动；高频更新自动合并。 */
  app.directive('countup', {
    mounted(el, binding) {
      const raw = binding.value;
      const v = Number(raw);
      el._cu = { prev: isNaN(v) ? 0 : v, timer: null, armed: false };
      el.textContent = window.U.num(raw);
    },
    updated(el, binding) {
      const raw = binding.value;
      const v = Number(raw);
      if (isNaN(v)) { el.textContent = window.U.num(raw); return; }
      const st = el._cu || (el._cu = { prev: 0, timer: null, armed: false });
      if (!st.armed) { st.armed = true; st.prev = v; el.textContent = window.U.num(v); return; }
      if (v === st.prev) return;
      if (st.timer) cancelAnimationFrame(st.timer);
      const from = st.prev, start = performance.now(), dur = 600;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - t, 3);
        el.textContent = window.U.num(Math.round(from + (v - from) * e));
        if (t < 1) st.timer = requestAnimationFrame(tick);
        else { st.prev = v; st.timer = null; el.textContent = window.U.num(v); }
      };
      st.timer = requestAnimationFrame(tick);
      st.prev = v;
    },
    unmounted(el) { if (el._cu && el._cu.timer) cancelAnimationFrame(el._cu.timer); }
  });

  app.mount('#app');
})();
