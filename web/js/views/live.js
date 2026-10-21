/* ============================================================
   views/live.js —— 实时引擎（数据是怎么"动起来"的）
   一屏回答三件事：
     1. 后台在跑什么任务、下一个批次还有多久
     2. 全国实时观测曲线与数据新鲜度
     3. 最近发生了哪些入库事件（可追溯到每一条新增预警）
   ============================================================ */
(function () {
  'use strict';

  const KIND = {
    alarm:   { label: '预警', color: '#ff8a00' },
    weather: { label: '实况', color: '#3fc6ff' },
    typhoon: { label: '台风', color: '#b48bff' },
    system:  { label: '系统', color: '#7cf6d8' }
  };

  window.ViewLive = {
    name: 'v-live',
    props: { meta: Object, ctx: Object },
    mixins: [ChartHost],
    data() {
      return {
        st: null,              // /api/live/status 原始返回
        loading: true, err: '',
        countdown: {},         // 本地倒计时（每秒递减，不必每秒请求后端）
        ranAt: ''
      };
    },
    computed: {
      enabled() { return !!(this.st && this.st.enabled); },
      jobs() { return (this.st && this.st.jobs) || []; },
      fresh() { return (this.st && this.st.freshness) || {}; },
      events() { return this.fresh.events || []; },
      series() { return this.fresh.series || []; },
      provinces() { return (this.fresh.provinces || []).slice().sort((a, b) => (b.total - a.total)).slice(0, 18); },
      requests() { return (this.st && this.st.requests) || { ok: 0, fail: 0 }; },
      /* 自适应限速状态：引擎是"跑在稳态"还是"被对方限流后主动降速" */
      throttle() {
        return (this.st && this.st.throttle) ||
          { rate: '—', base_rate: '—', min_rate: '—', interval_scale: 1,
            blocked_total: 0, block_streak: 0, limited: false };
      },
      uptime() {
        if (!this.st || !this.st.started_at) return '—';
        const t = new Date(this.st.started_at.replace(/-/g, '/')).getTime();
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return (h ? h + ' 小时 ' : '') + m + ' 分 ' + (s % 60) + ' 秒';
      },
      coveragePct() { return Math.round((this.fresh.coverage || 0) * 1000) / 10; },
      curObs() { return this.series.length ? this.series[this.series.length - 1] : null; },
      /* 与上一次快照相比的气温变化，用来展示"数据在动" */
      drift() {
        const s = this.series;
        if (s.length < 2) return null;
        const a = s[s.length - 1].temp_avg, b = s[Math.max(0, s.length - 2)].temp_avg;
        if (a === null || b === null || a === undefined || b === undefined) return null;
        return Math.round((a - b) * 100) / 100;
      },
      recentUpdateAt() {
        if (!this.fresh.obs_updated_at) return '—';
        return U.ago(this.fresh.obs_updated_at);
      },
      /* ---- 预警口径（与实况是两条独立支路，必须分开显示）----
         2026-10-08 的教训：本页「最近一次数据入库」显示的是实况时间（一直在动），
         而「预警最新发布」是预警的**发布时间**，两者混在一张卡里，
         结果实况的"刚刚"把预警的"5 天前"遮住了，问题被瞒了 5 天。 */
      alarmStale() { return !!this.fresh.alarm_stale; },
      /* 预警最近一次成功采集距今（这是"采集链路是否活着"的判据） */
      alarmAge() { return this.fresh.alarm_ingested ? U.ago(this.fresh.alarm_ingested) : '—'; },
      /* 预警清单里最新一条的**发布时间**（上游发的时刻，不是我们采的时刻） */
      alarmLatest() { return (this.fresh.alarm_latest || '—').slice(5); }
    },
    async created() { await this.load(); this.startCountdown(); },
    beforeUnmount() { clearInterval(this._cd); },
    methods: {
      async load(quiet) {
        if (!quiet) this.loading = true;
        try {
          this.st = await API.liveStatus(true);
          this.err = '';
          const cd = {};
          (this.st.jobs || []).forEach(j => { cd[j.name] = j.next_in; });
          this.countdown = cd;
          this.$nextTick(() => { this.renderSeries(); this.renderProvince(); });
        } catch (e) {
          this.err = e.message || String(e);
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      /* 每秒本地递减倒计时；归零则下一轮 load 会拿到后端真实值 */
      startCountdown() {
        this._cd = setInterval(() => {
          const cd = Object.assign({}, this.countdown);
          Object.keys(cd).forEach(k => {
            if (typeof cd[k] === 'number' && cd[k] > 0) cd[k] -= 1;
          });
          this.countdown = cd;
        }, 1000);
      },
      jobPct(j) {
        const left = this.countdown[j.name];
        if (typeof left !== 'number' || !j.interval) return 0;
        return Math.max(0, Math.min(100, 100 - (left / j.interval) * 100));
      },
      async runJob(name) {
        try {
          const r = await API.liveRun(name);
          this.ranAt = U.ago(new Date().toISOString());
          this.flash(r.started ? `已触发「${this.labelOf(name)}」任务，完成后本页会自动刷新` : (r.msg || '任务正在运行'));
        } catch (e) {
          this.flash('触发失败：' + (e.message || e));
        }
      },
      labelOf(n) { const j = this.jobs.find(x => x.name === n); return j ? j.label : n; },
      /* 事件类型 -> 标签/颜色（模板里拿不到闭包变量，必须走方法） */
      kLabel(k) { return (KIND[k] || KIND.system).label; },
      kColor(k) { return (KIND[k] || KIND.system).color; },
      flash(m) {
        const root = this.$root;
        if (root && typeof root.flash === 'function') root.flash(m);
      },

      /* ---------- 图表 ---------- */
      renderSeries() {
        const s = this.series;
        if (!s.length) return;
        const x = s.map(r => (r.ts || '').slice(11, 16));
        const avg = s.map(r => r.temp_avg === null ? null : Math.round(r.temp_avg * 10) / 10);
        const hi = s.map(r => r.temp_max);
        const lo = s.map(r => r.temp_min);
        const rain = s.map(r => r.rain_stations || 0);
        this.setChart('series', {
          backgroundColor: 'transparent',
          tooltip: T.tooltip({
            trigger: 'axis',
            formatter: p => {
              const i = p[0].dataIndex, r = s[i];
              return `<b>${r.ts}</b><br/>` +
                `平均气温 <b style="color:#3fc6ff">${U.num(r.temp_avg, 1)} ℃</b><br/>` +
                `最高 ${U.num(r.temp_max, 1)} ℃（${r.temp_max_station || '—'}）<br/>` +
                `最低 ${U.num(r.temp_min, 1)} ℃（${r.temp_min_station || '—'}）<br/>` +
                `平均湿度 ${U.num(r.hum_avg, 0)} %　有降水站点 <b style="color:#41d6c3">${r.rain_stations || 0}</b> 个`;
            }
          }),
          legend: { top: 0, right: 6, itemWidth: 10, itemHeight: 8 },
          grid: { left: 44, right: 46, top: 30, bottom: 22, containLabel: true },
          xAxis: T.axisX({ data: x, boundaryGap: false,
            axisLabel: { color: '#a9bdd6', fontSize: 9, interval: Math.ceil(x.length / 10) } }),
          yAxis: [
            T.axisY({ name: '℃', nameTextStyle: { color: '#6f89a6', fontSize: 10 } }),
            T.axisY({ name: '站', nameTextStyle: { color: '#6f89a6', fontSize: 10 }, splitLine: { show: false } })
          ],
          series: [
            { name: '站点最高气温', type: 'line', data: hi, smooth: true, showSymbol: false,
              lineStyle: { width: 1.4, color: '#ff8a00', opacity: .85 } },
            { name: '全国平均气温', type: 'line', data: avg, smooth: true, showSymbol: false,
              lineStyle: { width: 2.4, color: '#3fc6ff', shadowBlur: 12, shadowColor: '#3fc6ff66' },
              areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [{ offset: 0, color: '#3fc6ff44' }, { offset: 1, color: '#3fc6ff00' }] } } },
            { name: '站点最低气温', type: 'line', data: lo, smooth: true, showSymbol: false,
              lineStyle: { width: 1.4, color: '#41d6c3', opacity: .85 } },
            { name: '有降水站点数', type: 'bar', yAxisIndex: 1, data: rain,
              barWidth: '38%', itemStyle: { color: 'rgba(180,139,255,.34)' } }
          ]
        });
      },
      renderProvince() {
        const d = this.provinces.slice().reverse();
        if (!d.length) return;
        this.setChart('prov', T.bar(
          d.map(p => U.shortName(p.name)),
          d.map(p => Math.round((p.fresh || 0) / Math.max(p.total, 1) * 100)),
          {
            horizontal: true, unit: '%', barWidth: 10, max: 100,
            color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                     colorStops: [{ offset: 0, color: '#1d6f9f' }, { offset: 1, color: '#7cf6d8' }] },
            grid: { left: 6, right: 44, top: 4, bottom: 4, containLabel: true },
            formatter: p => (d[p.dataIndex] || {}).name +
              `<br/>近 15 分钟已刷新 <b>${(d[p.dataIndex] || {}).fresh}</b> / ${(d[p.dataIndex] || {}).total} 站`
          }));
      },

      /* 由外壳在收到实时推送后调用，保持本页与全局同步 */
      async onLive(msg) {
        await this.load(true);
        if (msg && msg.job === 'alarm' && msg.new) this.flash(`本页已更新：新增 ${msg.new} 条预警`);
      },
      ago: U.ago, countdownText: U.countdown, shortName: U.shortName
    },
    template: `
    <div class="grid g-live">
      <!-- ============ 引擎总览 ============ -->
      <div class="sp-12 kpi-row" style="grid-template-columns:repeat(6,1fr)">
        <div class="kpi" style="--accent:#7cf6d8">
          <div class="k-label">实时引擎</div>
          <div class="k-value" style="font-size:20px">
            {{ enabled ? '运行中' : '未启用' }}
            <small v-if="enabled">v{{ st.version }}</small>
          </div>
          <div class="k-foot">已运行 {{ uptime }}</div>
        </div>
        <div class="kpi" style="--accent:#3fc6ff">
          <div class="k-label">最近一次实况入库</div>
          <div class="k-value" style="font-size:20px">
            {{ fresh.obs_updated_at ? ago(fresh.obs_updated_at) : '—' }}
          </div>
          <div class="k-foot">实况口径 · 预警采集 {{ alarmAge }}</div>
        </div>
        <div class="kpi" :style="{ '--accent': alarmStale ? '#ff5a66' : '#ff8a00' }">
          <div class="k-label">实时预警信号</div>
          <div class="k-value"><span v-countup="fresh.alarm_total"></span><small>条</small></div>
          <div class="k-foot" :style="alarmStale ? 'color:#ff5a66' : ''">
            <template v-if="alarmStale">采集已停摆 · 最新发布 {{ alarmLatest }}</template>
            <template v-else>
              最新发布 {{ alarmLatest }} · 近 1 小时新增
              <b style="color:#ff8a00">{{ fresh.alarm_new_1h || 0 }}</b> 条
            </template>
          </div>
        </div>
        <div class="kpi" style="--accent:#41d6c3">
          <div class="k-label">站点数据新鲜度</div>
          <div class="k-value"><span v-countup="coveragePct"></span><small>%</small></div>
          <div class="k-foot">近 15 分钟已刷新 {{ fresh.obs_fresh || 0 }} / {{ fresh.station_total || 0 }} 站</div>
        </div>
        <div class="kpi" style="--accent:#b48bff">
          <div class="k-label">累计观测刷新</div>
          <div class="k-value"><span v-countup="fresh.updates_total"></span><small>次</small></div>
          <div class="k-foot">单站最高 {{ fresh.obs_max_updates || 0 }} 次</div>
        </div>
        <div class="kpi" :style="{ '--accent': throttle.limited ? '#ffd233' : '#3ddc97' }">
          <div class="k-label">采集限速 · 自适应</div>
          <div class="k-value" style="font-size:20px">
            {{ throttle.rate }}<small>req/s</small>
            <span v-if="throttle.limited" style="font-size:11px;color:#ffd233">降速中</span>
          </div>
          <div class="k-foot">
            成功 {{ requests.ok }} / 失败 {{ requests.fail }} ·
            {{ throttle.limited
              ? '被限流，间隔 ×' + throttle.interval_scale
              : '稳态（上限 ' + throttle.base_rate + ' req/s）' }}
          </div>
        </div>
      </div>

      <!-- ============ 三个后台任务 ============ -->
      <div class="sp-4 panel" v-for="j in jobs" :key="j.name">
        <div class="panel-head">
          <h3>{{ j.label }}</h3>
          <span class="sub">
            <span class="dot" :class="j.busy ? 'live' : (j.last_ok === false ? 'warn' : 'on')"></span>
            {{ j.busy ? '执行中…' : (j.last_run ? '空闲 · ' + ago(j.last_run) : '等待首次执行') }}
          </span>
        </div>
        <div class="panel-body job-card">
          <div class="job-desc">{{ j.desc }}</div>
          <div class="job-stats">
            <div><span>节奏</span><b>{{ j.effective_interval || j.interval }}s</b></div>
            <div><span>上轮扫描</span><b>{{ j.scanned }}</b></div>
            <div><span>上轮新增</span><b :style="{color: j.new ? j.accent : ''}">{{ j.new }}</b></div>
            <div><span>耗时</span><b>{{ j.duration === null ? '—' : j.duration + 's' }}</b></div>
            <div><span>累计轮次</span><b>{{ j.runs }}</b></div>
            <div><span>失败</span><b :style="{color: j.errors ? '#ff6b6b' : ''}">{{ j.errors }}</b></div>
          </div>
          <div class="job-progress">
            <div class="jp-bar"><i :style="{width: jobPct(j) + '%', background: j.accent}"></i></div>
            <span>下一轮 {{ countdownText(countdown[j.name]) }}</span>
          </div>
          <div class="job-foot">
            <button class="btn ghost tiny" @click="runJob(j.name)" :disabled="j.busy">立即执行</button>
            <span class="err" v-if="j.error" :title="j.error">⚠ {{ j.error.slice(0, 42) }}</span>
          </div>
        </div>
      </div>

      <!-- ============ 实时曲线 ============ -->
      <div class="sp-7 panel">
        <div class="panel-head">
          <h3>全国观测实时曲线</h3>
          <span class="sub">
            每轮刷新后写入一个快照 · 已有 {{ series.length }} 个点
            <template v-if="curObs"> · 当前均温 {{ U.num(curObs.temp_avg,1) }}℃</template>
            <template v-if="drift !== null">
              <b :style="{color: drift >= 0 ? '#ff8a00' : '#41d6c3'}">
                （较上一快照 {{ drift > 0 ? '+' : '' }}{{ drift }}℃）</b>
            </template>
          </span>
        </div>
        <div class="panel-body" style="padding:4px">
          <div class="chart" ref="series"></div>
        </div>
      </div>

      <!-- ============ 事件流 ============ -->
      <div class="sp-5 panel">
        <div class="panel-head">
          <h3>实时入库事件流</h3>
          <span class="sub">共 {{ fresh.event_total || 0 }} 条记录</span>
        </div>
        <div class="panel-body scroll" style="padding:8px 10px">
          <div class="evlist">
            <div class="ev-item" v-for="(e,i) in events" :key="e.ts + i"
                 :style="{'--ec': kColor(e.kind)}">
              <span class="ev-time">{{ (e.ts || '').slice(11) }}</span>
              <span class="ev-kind">{{ kLabel(e.kind) }}</span>
              <span class="ev-text">{{ e.text }}</span>
            </div>
            <div v-if="!events.length" class="empty">还没有事件，等待第一个更新周期（约 60 秒）</div>
          </div>
        </div>
      </div>

      <!-- ============ 分省新鲜度 ============ -->
      <div class="sp-12 panel">
        <div class="panel-head">
          <h3>分省数据新鲜度</h3>
          <span class="sub">条形 = 近 15 分钟内已刷新的站点占比（轮转更新，约 13 分钟覆盖全国一遍）</span>
        </div>
        <div class="panel-body" style="padding:4px 8px 6px">
          <div class="chart" ref="prov" style="height:100%"></div>
        </div>
      </div>
    </div>`
  };
})();
