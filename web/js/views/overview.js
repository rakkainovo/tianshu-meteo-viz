/* ============================================================
   views/overview.js —— 态势总览
   一屏回答："此时此刻，全国正在发生什么？"
   ============================================================ */
(function () {
  'use strict';

  const LEVEL_NAME = { 4: '红色', 3: '橙色', 2: '黄色', 1: '蓝色', 0: '无' };

  Vue.createApp({}).unmount && null;   // no-op，保持文件可独立解析

  window.ViewOverview = {
    name: 'v-overview',
    props: { meta: Object, ctx: Object },
    mixins: [ChartHost],
    data() {
      return {
        loading: true,
        provAgg: [], cityAgg: [], series: null, latest: [], latestAll: [],
        typhoons: null, activeType: '', mapName: ''
      };
    },
    computed: {
      kpi() { return (this.meta && this.meta.kpi) || {}; },
      types() { return (this.meta && this.meta.types) || []; },
      levels() { return (this.meta && this.meta.levels) || []; },
      typeTop() { return this.types.slice(0, 6); },
      mapPoints() {
        const recs = this.latestAll || [];
        return recs.filter(r => r.lng && r.lat)
          .map(r => ({
            name: r.city || r.county || r.province,
            value: [r.lng, r.lat],
            title: r.type + r.level + '预警',
            type: r.type, level: r.level, rank: r.level_rank,
            time: r.ts, issuer: r.issuer
          }));
      }
    },
    async created() { await this.load(); },
    methods: {
      async load() {
        this.loading = true;
        try {
          const [provAgg, cityAgg, series, latest, ty, alarmAll] = await Promise.all([
            API.alarmAgg({ dim: 'province', top: 40 }),
            API.alarmAgg({ dim: 'city', top: 8 }),
            API.alarmSeries({ bucket: 'hour' }),
            API.alarms({ limit: 14 }),
            API.typhoonOverview(),
            API.alarms({ limit: 300 })
          ]);
          this.provAgg = provAgg.data || [];
          this.cityAgg = cityAgg.data || [];
          this.series = series;
          this.latest = (latest.records || []).slice(0, 10);
          this.latestAll = alarmAll.records || [];
          this.typhoons = ty;
          this.mapName = await MapHub.use('100000');
          this.render();
        } catch (e) {
          this.$emit('goto', 'overview');
          console.error(e);
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      async setType(t) {
        this.activeType = (this.activeType === t ? '' : t);
        if (this.activeType) {
          const r = await API.alarms({ type: this.activeType, limit: 300 });
          this.latestAll = r.records || [];
        } else {
          const r = await API.alarms({ limit: 300 });
          this.latestAll = r.records || [];
        }
        this.renderMap();
      },
      /* 实时推送到达：「静默」重取数据（不显示加载遮罩，保留已选灾种） */
      async onLive() {
        const [provAgg, cityAgg, series, latest, ty, alarmAll] = await Promise.all([
          API.alarmAgg({ dim: 'province', top: 40 }),
          API.alarmAgg({ dim: 'city', top: 8 }),
          API.alarmSeries({ bucket: 'hour' }),
          API.alarms({ limit: 14 }),
          API.typhoonOverview(),
          API.alarms(this.activeType ? { type: this.activeType, limit: 300 } : { limit: 300 })
        ]);
        this.provAgg = provAgg.data || [];
        this.cityAgg = cityAgg.data || [];
        this.series = series;
        this.latest = (latest.records || []).slice(0, 10);
        this.latestAll = alarmAll.records || [];
        this.typhoons = ty;
        this.render();
      },
      render() { this.renderMap(); this.renderLevel(); this.renderType(); this.renderTrend(); },
      renderMap() {
        if (!this.mapName) return;
        const d = this.provAgg.filter(p => p.name);
        this.setChart('map', T.mapOption(this.mapName, {
          geo: { zoom: 1.18, layoutCenter: ['50%', '54%'], layoutSize: '94%' },
          tooltipOpt: {
            formatter: p => {
              if (p.seriesType === 'effectScatter') {
                const x = p.data;
                return `<b>${x.title}</b><br/>${U.shortName(x.issuer)}` +
                       `<br/>发布时间 ${x.time.slice(5)}`;
              }
              const r = LEVEL_NAME[p.data && p.data.rank] || '无';
              return `<b>${p.name}</b><br/>预警数量：<b style="color:#3fc6ff">${p.value || 0}</b> 条` +
                     (p.value ? `<br/>最高等级：<span style="color:${U.lvColor(r)}">${r}</span>` : '');
            }
          },
          series: [
            {
              type: 'map', map: this.mapName, geoIndex: 0, name: '最高预警等级',
              data: d.map(p => ({ name: p.name, value: p.max_rank || 0, count: p.count })),
              emphasis: { label: { show: false } }
            },
            {
              type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0,
              name: '预警点位', zlevel: 3, data: this.mapPoints,
              symbolSize: v => 5 + (v[2] || 0) * 1.1,
              showEffectOn: 'render',
              rippleEffect: { brushType: 'stroke', scale: 2.6, period: 3.2 },
              itemStyle: {
                color: p => U.lvColor(p.data.level),
                shadowBlur: 10, shadowColor: 'rgba(0,0,0,.6)',
                borderColor: 'rgba(255,255,255,.75)', borderWidth: .6
              },
              label: { show: false }
            }
          ],
          visualMap: T.levelVisualMap({ seriesIndex: 0 })
        }));
      },
      renderLevel() {
        const data = this.levels.filter(l => l.count > 0).map(l => ({
          name: l.name, value: l.count,
          itemStyle: { color: U.lvColor(l.name) }
        }));
        this.setChart('level', T.pie(data, {
          legend: true, center: ['50%', '46%'], radius: ['44%', '68%'],
          labelFmt: '{b}\n{c} 条'
        }));
      },
      renderType() {
        const d = this.typeTop.slice().reverse();
        this.setChart('typeTop', T.bar(d.map(x => x.name), d.map(x => x.count), {
          horizontal: true, colors: d.map(x => U.typeColor(x.name)),
          barWidth: 15, unit: '条',
          grid: { left: 6, right: 46, top: 6, bottom: 6, containLabel: true }
        }));
      },
      renderTrend() {
        if (!this.series) return;
        const b = this.series.buckets || [];
        const s = (this.series.series || []).map(x => ({
          name: x.name, color: U.lvColor(x.name), data: x.data
        }));
        this.setChart('trend', T.line(b, s, { rotate: 0, smooth: false, showSymbol: false, yName: '条 / 小时' }));
      },
      lvClass: U.lvClass,
      shortName: U.shortName,
      /* 刚入库（10 分钟内）的预警打上 NEW 徽标 —— 让"实时"看得见 */
      isNewOne(r) { return U.isNew(r.ingested_at, 10); }
    },
    template: `
    <div class="grid g-ov">
      <!-- KPI -->
      <div class="sp-12 kpi-row" style="grid-template-columns:repeat(6,1fr)">
        <div class="kpi" style="--accent:#3fc6ff">
          <div class="k-label">实时预警信号</div>
          <div class="k-value">{{ U.num(kpi.alarm_total) }}<small>条</small></div>
          <div class="k-foot">近 24 小时滚动累积</div>
        </div>
        <div class="kpi" style="--accent:#7cf6d8">
          <div class="k-label">覆盖省级行政区</div>
          <div class="k-value">{{ kpi.province_count }}<small>个</small></div>
          <div class="k-foot">涉及 {{ kpi.city_count }} 个地市</div>
        </div>
        <div class="kpi" style="--accent:#ff8a00">
          <div class="k-label">橙色及以上</div>
          <div class="k-value">{{ kpi.red_orange }}<small>条</small></div>
          <div class="k-foot">需重点关注的致灾性天气</div>
        </div>
        <div class="kpi" style="--accent:#b48bff">
          <div class="k-label">预警发布单位</div>
          <div class="k-value">{{ U.num(kpi.issuer_count) }}<small>家</small></div>
          <div class="k-foot">省 / 市 / 县三级气象台</div>
        </div>
        <div class="kpi" style="--accent:#41d6c3">
          <div class="k-label">气象观测站点</div>
          <div class="k-value">{{ U.num(kpi.station_total) }}<small>个</small></div>
          <div class="k-foot">有效观测 {{ U.num(kpi.obs_valid) }} 条</div>
        </div>
        <div class="kpi" style="--accent:#ffb648">
          <div class="k-label">台风路径</div>
          <div class="k-value">{{ kpi.typhoon_total }}<small>个</small></div>
          <div class="k-foot">{{ U.num(kpi.typhoon_points) }} 个路径点</div>
        </div>
      </div>

      <!-- 地图 -->
      <div class="sp-8 panel">
        <div class="panel-head">
          <h3>全国预警态势图</h3>
          <span class="sub">色块 = 该省最高预警等级　圆点 = 预警落区（可滚轮缩放 / 拖拽）</span>
        </div>
        <div class="panel-body map-wrap" style="padding:0">
          <div class="chart" ref="map"></div>
          <div class="legend-box">
            <div class="legend-row" v-for="l in meta.levels" :key="l.name" v-show="l.count>0">
              <span class="legend-swatch" :style="{background:U.lvColor(l.name)}"></span>
              <span>{{ l.name }}预警 · {{ l.count }} 条</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：等级 + 灾种 -->
      <div class="sp-4 col-stack">
        <div class="panel" style="flex:1">
          <div class="panel-head"><h3>预警等级构成</h3><span class="sub">四色即是等级语义</span></div>
          <div class="panel-body" style="padding:4px"><div class="chart" ref="level"></div></div>
        </div>
        <div class="panel" style="flex:1.1">
          <div class="panel-head"><h3>灾种分布</h3><span class="sub">点击可在地图上过滤</span></div>
          <div class="panel-body" style="padding:4px 8px 6px">
            <div class="chart" ref="typeTop" style="height:calc(100% - 34px)"></div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
              <span v-for="t in types.slice(0,8)" :key="t.name" class="chip"
                    :class="{on: activeType===t.name}" @click="setType(t.name)"
                    style="font-size:11px;padding:3px 8px">{{ t.name }} {{ t.count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 趋势 -->
      <div class="sp-5 panel">
        <div class="panel-head"><h3>预警数量时间演化</h3><span class="sub">按小时分级堆叠</span></div>
        <div class="panel-body" style="padding:4px"><div class="chart" ref="trend"></div></div>
      </div>

      <!-- 城市排行 -->
      <div class="sp-4 panel">
        <div class="panel-head"><h3>城市预警热度</h3><span class="sub">TOP 8</span></div>
        <div class="panel-body scroll">
          <div class="ranklist">
            <div class="rank-item" v-for="(c,i) in cityAgg" :key="c.name">
              <span class="rank-no">{{ i+1 }}</span>
              <span class="rank-name">{{ shortName(c.name) }}</span>
              <span class="rank-bar"><i :style="{width: (c.count / cityAgg[0].count * 100) + '%'}"></i></span>
              <span class="rank-val">{{ c.count }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 最新预警 -->
      <div class="sp-3 panel">
        <div class="panel-head"><h3>最新预警</h3><span class="sub">滚动更新</span></div>
        <div class="panel-body scroll" style="padding:8px">
          <div class="alist">
            <div class="alist-item" v-for="r in latest" :key="r.id"
                 :style="{'--mc': U.lvColor(r.level)}">
              <div class="ai-top">
                <span class="badge" :class="lvClass(r.level)">{{ r.type }}{{ r.level }}</span>
                <span v-if="isNewOne(r)" class="new-tag">NEW</span>
                <span class="ai-time">{{ r.ts.slice(5) }}</span>
              </div>
              <div class="ai-sub">{{ shortName(r.issuer) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})();
