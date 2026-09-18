/* ============================================================
   views/alarm.js —— 预警地图（省 / 市 / 区县 三级下钻）
   交互主线：地图取色看全局 -> 点击下钻看局部 -> 列表与地图双向联动
   ============================================================ */
(function () {
  'use strict';

  const LEVEL_NAME = { 4: '红色', 3: '橙色', 2: '黄色', 1: '蓝色', 0: '无预警' };

  window.ViewAlarm = {
    name: 'v-alarm',
    props: { meta: Object, ctx: Object },
    mixins: [ChartHost],
    data() {
      return {
        /* 下钻栈：每层记录 {adcode, name, level} */
        stack: [{ adcode: '100000', name: '全国', level: 0 }],
        mapName: '', loading: false,
        filters: { type: '', level: '', province: '', q: '' },
        agg: [], records: [], total: 0,
        selected: null,
        tab: 'list'
      };
    },
    computed: {
      cur() { return this.stack[this.stack.length - 1]; },
      types() { return (this.meta && this.meta.types) || []; },
      levels() { return (this.meta && this.meta.levels) || []; },
      provinces() { return (this.meta && this.meta.provinces) || []; },
      dim() { return ['province', 'city', 'county'][this.cur.level] || 'county'; },
      /* 当前层级的查询条件：下层自动继承上层的行政区约束 */
      scope() {
        const s = {};
        if (this.stack[1]) s.province = this.stack[1].name;
        if (this.stack[2]) s.city = this.stack[2].name;
        return s;
      },
      points() {
        return this.records.filter(r => r.lng && r.lat).map(r => ({
          name: r.county || r.city || r.province,
          value: [r.lng, r.lat],
          title: r.title, type: r.type, level: r.level, rank: r.level_rank,
          time: r.ts, issuer: r.issuer, id: r.id
        }));
      },
      stat() {
        const n = this.records.length;
        const maxR = this.records.reduce((m, r) => Math.max(m, r.level_rank || 0), 0);
        const ts = new Set(this.records.map(r => r.type));
        return { n, maxR, types: ts.size };
      }
    },
    async created() { await this.refresh(); },
    methods: {
      query(extra) {
        return Object.assign({}, this.filters, this.scope, extra || {});
      },
      async refresh() {
        this.loading = true;
        try {
          const [agg, recs] = await Promise.all([
            API.alarmAgg(Object.assign({ dim: this.dim, top: 400 }, this.query())),
            API.alarms(Object.assign({ limit: 600 }, this.query()))
          ]);
          this.agg = agg.data || [];
          this.records = recs.records || [];
          this.total = recs.total;
          this.selected = null;
          await this.loadMap();
          this.renderMap();
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      /* 实时推送：只重取数据，保留下钻层级、筛选条件与当前选中项 */
      async onLive() {
        const keep = this.selected ? this.selected.id : null;
        const [agg, recs] = await Promise.all([
          API.alarmAgg(Object.assign({ dim: this.dim, top: 400 }, this.query())),
          API.alarms(Object.assign({ limit: 600 }, this.query()))
        ]);
        this.agg = agg.data || [];
        this.records = recs.records || [];
        this.total = recs.total;
        if (keep) this.selected = this.records.find(r => r.id === keep) || this.selected;
        this.renderMap();
      },
      async loadMap() {
        const c = this.cur;
        const code = c.level === 2 ? 'c' + c.adcode : c.adcode;
        try {
          this.mapName = await MapHub.use(code);
        } catch (e) {
          /* 东莞、中山、儋州等"直筒子市"没有区县级边界，退回省级而不是全国 */
          if (c.level === 2) {
            this.stack = this.stack.slice(0, 2);
            this.flash('该市为直筒子市，无区县级边界，已停留在市级视图');
            this.mapName = await MapHub.use(this.cur.adcode);
          } else {
            this.mapName = await MapHub.use('100000');
          }
        }
      },
      renderMap() {
        if (!this.mapName) return;
        const data = this.agg.filter(a => a.name).map(a => ({
          name: a.name, value: a.max_rank || 0, count: a.count
        }));
        const isBottom = this.cur.level >= 2;
        this.setChart('map', T.mapOption(this.mapName, {
          geo: {
            zoom: this.cur.level === 0 ? 1.18 : 1.02,
            layoutCenter: ['50%', '52%'],
            layoutSize: this.cur.level === 0 ? '94%' : '92%'
          },
          tooltipOpt: {
            formatter: p => {
              if (p.seriesType === 'effectScatter') {
                const x = p.data;
                return `<b>${x.title}</b><br/>${x.issuer}<br/>发布时间 ${x.time.slice(5)}`;
              }
              return `<b>${p.name}</b><br/>预警 <b style="color:#3fc6ff">${p.value || 0}</b> 条` +
                (p.value ? `<br/>最高等级：<span style="color:${U.lvColor(LEVEL_NAME[p.value].replace('预警', ''))}">${LEVEL_NAME[p.value]}</span>` : '') +
                (isBottom ? '' : '<br/><span style="color:#7cf6d8">点击可下钻</span>');
            }
          },
          series: [
            {
              type: 'map', map: this.mapName, geoIndex: 0, name: '最高预警等级',
              data, emphasis: { label: { show: true, color: '#fff' } }
            },
            {
              type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 3,
              name: '预警点位', data: this.points,
              symbolSize: v => 5 + (v[2] || 0) * 1.2,
              rippleEffect: { brushType: 'stroke', scale: 2.8, period: 3 },
              itemStyle: {
                color: p => U.lvColor(p.data.level),
                shadowBlur: 10, shadowColor: 'rgba(0,0,0,.62)',
                borderColor: 'rgba(255,255,255,.8)', borderWidth: .6
              }
            }
          ],
          visualMap: T.levelVisualMap({ seriesIndex: 0 })
        }));

        /* 点击下钻 */
        this.onChart('map', 'click', async p => {
          if (this.cur.level >= 2) { this.pickByPoint(p); return; }
          if (p.seriesType !== 'map' || !p.name) return;
          const item = this.agg.find(a => a.name === p.name);
          if (!item || !item.adcode) { this.flash('该区域暂无更细的下级数据'); return; }
          this.stack.push({ adcode: String(item.adcode), name: p.name, level: this.cur.level + 1 });
          await this.refresh();
        });
      },
      pickByPoint(p) {
        if (p.seriesType !== 'effectScatter' || !p.data) return;
        const rec = this.records.find(r => r.id === p.data.id);
        if (rec) { this.selected = rec; this.tab = 'detail'; }
      },
      async drillTo(i) {
        this.stack = this.stack.slice(0, i + 1);
        await this.refresh();
      },
      async pickRow(r) {
        this.selected = r;
        this.tab = 'detail';
        const c = this.chart('map');
        if (!c || !r.lng) return;
        c.dispatchAction({ type: 'downplay', seriesIndex: 1 });
      },
      async applyFilters() {
        /* 手动改变了省份筛选时，把下钻栈重置到全国，避免条件打架 */
        if (this.filters.province && this.stack[1] && this.stack[1].name !== this.filters.province) {
          this.stack = [this.stack[0]];
        }
        if (this.filters.province && !this.stack[1]) {
          const p = this.provinces.find(x => x.name === this.filters.province);
          if (p) {
            this.stack.push({ adcode: String(p.adcode), name: p.name, level: 1 });
            this.filters.province = '';
          }
        }
        await this.refresh();
      },
      async reset() {
        this.filters = { type: '', level: '', province: '', q: '' };
        this.stack = [{ adcode: '100000', name: '全国', level: 0 }];
        await this.refresh();
      },
      lvClass: U.lvClass, shortName: U.shortName,
      lvName(r) { return LEVEL_NAME[r] || '—'; }
    },
    template: `
    <div style="display:flex;flex-direction:column;height:100%">
      <!-- 筛选栏 -->
      <div class="filterbar">
        <div class="field"><label>灾种</label>
          <select v-model="filters.type" @change="applyFilters">
            <option value="">全部灾种</option>
            <option v-for="t in types" :key="t.name" :value="t.name">{{ t.name }}（{{ t.count }}）</option>
          </select>
        </div>
        <div class="field"><label>等级</label>
          <select v-model="filters.level" @change="applyFilters">
            <option value="">全部等级</option>
            <option v-for="l in levels" :key="l.name" :value="l.name">{{ l.name }}（{{ l.count }}）</option>
          </select>
        </div>
        <div class="field"><label>省份</label>
          <select v-model="filters.province" @change="applyFilters">
            <option value="">全国</option>
            <option v-for="p in provinces" :key="p.adcode" :value="p.name">
              {{ shortName(p.name) }}<template v-if="p.count">（{{ p.count }}）</template>
            </option>
          </select>
        </div>
        <div class="field" style="flex:1;min-width:180px">
          <input type="search" v-model.trim="filters.q" placeholder="搜索预警标题 / 发布单位 / 地区"
                 @keyup.enter="applyFilters" style="width:100%">
        </div>
        <button class="btn ghost" @click="reset">重置</button>
        <span style="margin-left:auto;font-size:12px;color:#6f89a6">
          当前筛选命中 <b style="color:#3fc6ff">{{ total }}</b> 条
        </span>
      </div>

      <!-- 地图 + 侧栏 -->
      <div class="grid" style="grid-template-columns:minmax(0,1fr) 372px;flex:1;min-height:0">
        <div class="panel">
          <div class="panel-head">
            <h3>预警落区地图</h3>
            <span class="sub">{{ dim === 'province' ? '点击省份下钻' : dim === 'city' ? '点击城市下钻至区县' : '已到区县级，点击圆点查看详情' }}</span>
          </div>
          <div class="panel-body map-wrap" style="padding:0">
            <div class="map-tools">
              <div class="crumb">
                <template v-for="(s,i) in stack" :key="s.adcode">
                  <i v-if="i">›</i>
                  <span :class="{cur: i === stack.length-1}" @click="drillTo(i)">{{ shortName(s.name) }}</span>
                </template>
              </div>
            </div>
            <div class="chart" ref="map"></div>
            <div class="legend-box">
              <div class="legend-row"><span class="legend-swatch" style="background:#ff3b47"></span>红色（最高）</div>
              <div class="legend-row"><span class="legend-swatch" style="background:#ff8a00"></span>橙色</div>
              <div class="legend-row"><span class="legend-swatch" style="background:#ffd233"></span>黄色</div>
              <div class="legend-row"><span class="legend-swatch" style="background:#3d7eff"></span>蓝色</div>
              <div class="legend-row"><span class="legend-swatch" style="background:rgba(22,48,74,.85)"></span>无预警</div>
            </div>
          </div>
        </div>

        <div class="col-stack">
          <!-- 概要 -->
          <div class="panel" style="flex:0 0 auto">
            <div class="panel-head"><h3>区域概要</h3>
              <span class="sub">{{ shortName(cur.name) }}</span></div>
            <div class="panel-body">
              <div class="sd-grid">
                <div class="sd-cell"><div class="l">预警条数</div><div class="v">{{ stat.n }}</div></div>
                <div class="sd-cell"><div class="l">最高等级</div>
                  <div class="v" :style="{color: U.lvColor(lvName(stat.maxR))}">{{ lvName(stat.maxR) }}</div></div>
                <div class="sd-cell"><div class="l">涉及灾种</div><div class="v">{{ stat.types }}</div></div>
              </div>
            </div>
          </div>

          <!-- 列表 / 详情 -->
          <div class="panel" style="flex:1">
            <div class="panel-head">
              <h3>{{ tab === 'detail' && selected ? '预警详情' : '预警清单' }}</h3>
              <span class="sub" style="cursor:pointer" v-if="tab === 'detail'" @click="tab='list'">返回列表 ›</span>
              <span class="sub" v-else>{{ records.length }} 条</span>
            </div>
            <div class="panel-body scroll">
              <template v-if="tab === 'list'">
                <div class="alist">
                  <div class="alist-item" v-for="r in records.slice(0,120)" :key="r.id"
                       :style="{'--mc': U.lvColor(r.level)}" @click="pickRow(r)">
                    <div class="ai-top">
                      <span class="badge" :class="lvClass(r.level)">{{ r.type }}{{ r.level }}</span>
                      <span v-if="U.isNew(r.ingested_at, 10)" class="new-tag">NEW</span>
                      <span class="ai-time">{{ r.ts.slice(5) }}</span>
                    </div>
                    <div class="ai-title">{{ r.title }}</div>
                    <div class="ai-sub">{{ shortName(r.issuer) }}</div>
                  </div>
                  <div v-if="!records.length" class="empty">当前条件下没有预警记录</div>
                </div>
              </template>

              <template v-else-if="selected">
                <div class="sd-head">
                  <span class="n" style="font-size:15px">{{ selected.type }}</span>
                  <span class="badge" :class="lvClass(selected.level)">{{ selected.level }}预警</span>
                </div>
                <div style="font-size:13px;line-height:1.7;color:#e8f0fb">{{ selected.title }}</div>
                <div class="sd-grid" style="margin-top:12px">
                  <div class="sd-cell" style="grid-column:span 3">
                    <div class="l">发布时间</div><div class="v" style="font-size:15px">{{ selected.ts }}</div></div>
                  <div class="sd-cell" style="grid-column:span 3">
                    <div class="l">发布单位</div>
                    <div class="v" style="font-size:13px;line-height:1.5">{{ selected.issuer }}</div></div>
                  <div class="sd-cell"><div class="l">省</div><div class="v" style="font-size:13px">{{ shortName(selected.province) || '—' }}</div></div>
                  <div class="sd-cell"><div class="l">市</div><div class="v" style="font-size:13px">{{ shortName(selected.city) || '—' }}</div></div>
                  <div class="sd-cell"><div class="l">区县</div><div class="v" style="font-size:13px">{{ shortName(selected.county) || '—' }}</div></div>
                  <div class="sd-cell" style="grid-column:span 3">
                    <div class="l">落区经纬度</div>
                    <div class="v" style="font-size:13px">{{ selected.lng.toFixed(3) }}, {{ selected.lat.toFixed(3) }}
                      <small>· 定位精度 {{ selected.geo_level === 'county' ? '区县级' : selected.geo_level === 'city' ? '市级' : '省级' }}</small>
                    </div>
                  </div>
                </div>
                <a class="btn ghost" :href="selected.url" target="_blank"
                   style="display:inline-block;margin-top:12px;text-decoration:none">查看气象局原文 ↗</a>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})();
