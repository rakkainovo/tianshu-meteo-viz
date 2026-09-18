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
        booted: false, bootError: '', toast: '',
        view: 'overview',
        meta: {},
        views: [
          { key: 'overview', name: '态势总览', icon: ICON.overview },
          { key: 'alarm',    name: '预警地图', icon: ICON.alarm },
          { key: 'station',  name: '站点实况', icon: ICON.station },
          { key: 'typhoon',  name: '台风路径', icon: ICON.typhoon },
          { key: 'playback', name: '时空回放', icon: ICON.playback },
          { key: 'live',     name: '实时引擎', icon: ICON.live },
          { key: 'qa',       name: '智能问答', icon: ICON.qa }
        ],
        ctx: {},                       // 跨页面上下文（如问答跳转到台风页并选中某个台风）
        /* ---------- 实时状态 ---------- */
        liveOn: true,                  // 自动刷新开关
        liveConnected: false,
        liveVersion: 0,
        liveLastAt: '',                // 最近一次数据更新时刻
        liveLastJob: '',               // 最近一次更新的任务
        liveNewest: 0,                 // 最近一次新增条数
        liveJobs: [],                  // 任务状态（顶栏倒计时用）
        clock: ''                      // 每秒刷新，用于"x 秒前"的走字
      };
    },
    computed: {
      sourceTip() {
        const m = this.meta.meta || {};
        return [m.source_alarm, m.source_station, m.source_typhoon].filter(Boolean).join('\n');
      },
      liveText() {
        if (!this.liveLastAt) return '等待首个更新周期';
        return U.ago(this.liveLastAt);
      },
      liveState() {
        if (!this.liveOn) return 'paused';
        return this.liveConnected ? 'on' : 'off';
      }
    },
    async created() {
      try {
        const m = await API.meta();
        const k = m.kpi || {};
        m.timestamp_text = (k.ts_to || '').replace(/^\d{4}-/, '').replace(' ', ' ');
        this.meta = m;
        this.booted = true;
      } catch (e) {
        this.bootError = e.message || String(e);
      }
      this.syncHash();
      window.addEventListener('hashchange', this.syncHash);
      this.startClock();
      this.connectLive();
    },
    beforeUnmount() {
      if (this._es) this._es.close();
      clearInterval(this._clockT);
    },
    methods: {
      syncHash() {
        const k = (location.hash || '#/overview').replace(/^#\/?/, '').split('?')[0];
        this.view = this.views.some(v => v.key === k) ? k : 'overview';
      },
      go(key) {
        if (this.view === key) return;
        this.view = key;
        if (location.hash !== '#/' + key) location.hash = '#/' + key;
        this.$nextTick(() => window.dispatchEvent(new Event('resize')));
      },
      /* 子页面可要求跳转并带上目标参数 */
      onPick(payload) {
        if (payload && payload.view) {
          this.ctx = Object.assign({}, this.ctx, payload);
          this.go(payload.view);
        }
      },
      flash(msg) {
        this.toast = msg;
        clearTimeout(this._tt);
        this._tt = setTimeout(() => { this.toast = ''; }, 2400);
      },

      /* ---------------- 实时推送 ---------------- */
      connectLive() {
        /* 静态模式：url 带 ?static=1 时不建立长连接（截图、答辩演示更稳），
           数据仍是后端实时更新的，只是本页不自动刷新 */
        if (/[?&]static=1/.test(location.search)) {
          this.liveOn = false;
          API.liveStatus(true).then(s => {
            const f = s.freshness || {};
            this.liveVersion = s.version || 0;
            this.liveLastAt = f.obs_updated_at || f.alarm_ingested || '';
            this.liveJobs = s.jobs || [];
          }).catch(() => {});
          return;
        }
        if (!window.EventSource) return;
        const es = new EventSource('/api/live/stream');
        this._es = es;
        es.onopen = () => { this.liveConnected = true; };
        es.onerror = () => { this.liveConnected = false; };
        es.addEventListener('tick', e => {
          const d = JSON.parse(e.data);
          this.liveConnected = true;
          if (d.jobs) this.liveJobs = d.jobs;
          if (d.version > this.liveVersion) this.liveVersion = d.version;
        });
        /* 首帧：把"最近一次数据入库时刻"对齐到后端真实值，避免顶栏显示成刚更新 */
        API.liveStatus(true).then(s => {
          const f = s.freshness || {};
          this.liveVersion = s.version || 0;
          this.liveLastAt = f.obs_updated_at || f.alarm_ingested || '';
          this.liveJobs = s.jobs || [];
        }).catch(() => { /* 引擎未启用时忽略 */ });
        es.addEventListener('update', e => this.onLiveData(JSON.parse(e.data)));
      },
      /* 引擎写入新数据：失效缓存 -> 刷新顶栏 -> 通知当前页面增量刷新 */
      async onLiveData(msg) {
        this.liveConnected = true;
        if (msg.version) this.liveVersion = msg.version;
        this.liveLastAt = msg.at || this.liveLastAt;
        this.liveLastJob = msg.job || '';
        this.liveNewest = msg.new || 0;
        if (!this.liveOn) return;
        API.invalidate(BUST[msg.job] || ['/api/meta']);
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
        else if (msg.job === 'weather' && msg.new) this.flash(`⚡ 实时更新：${msg.new} 个站点实况已刷新`);
        else if (msg.job === 'typhoon' && msg.new) this.flash('⚡ 实时更新：台风路径已刷新');
      },
      /* 手动刷新：清缓存 + 重新拉取当前页数据 */
      async manualRefresh() {
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

  /* 把工具库暴露给所有模板 */
  app.mixin({ computed: { U: () => window.U } });

  app.component('v-overview', window.ViewOverview);
  app.component('v-alarm', window.ViewAlarm);
  app.component('v-station', window.ViewStation);
  app.component('v-typhoon', window.ViewTyphoon);
  app.component('v-playback', window.ViewPlayback);
  app.component('v-live', window.ViewLive);
  app.component('v-qa', window.ViewQA);

  app.mount('#app');
})();
