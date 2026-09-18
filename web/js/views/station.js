/* ============================================================
   views/station.js —— 全国气象站点实况
   2528 个台站的要素空间分布 + 极值排行 + 单站 7 日预报
   ============================================================ */
(function () {
  'use strict';

  const METRICS = {
    temp:    { name: '气温',     unit: '℃',  colors: ['#2b6cb0', '#3fc6ff', '#7cf6d8', '#ffd233', '#ff8a00', '#ff3b47'] },
    feelst:  { name: '体感温度', unit: '℃',  colors: ['#2b6cb0', '#3fc6ff', '#7cf6d8', '#ffd233', '#ff8a00', '#ff3b47'] },
    humidity:{ name: '相对湿度', unit: '%',   colors: ['#c08b5c', '#e0c07a', '#8fd6a8', '#41d6c3', '#2f9bff', '#3d4eff'] },
    rain:    { name: '降水量',   unit: 'mm',  colors: ['#12283d', '#1c6a9e', '#2f9bff', '#41d6c3', '#ffd233', '#ff3b47'] }
  };

  window.ViewStation = {
    name: 'v-station',
    props: { meta: Object, ctx: Object },
    mixins: [ChartHost],
    data() {
      return {
        metric: 'temp',
        filters: { province: '', info: '' },
        stations: [], rank: [], types: [], detail: null, detailFc: [],
        loading: false, tab: 'rank', mapName: ''
      };
    },
    computed: {
      M() { return METRICS[this.metric]; },
      provinces() { return (this.meta && this.meta.provinces) || []; },
      range() {
        const v = this.stations.map(s => s.value).filter(x => x !== null && x !== undefined);
        return v.length ? [Math.min(...v), Math.max(...v)] : [0, 1];
      },
      /* 气温 - 湿度 关系散点 */
      relation() {
        return this.stations
          .filter(s => s.temp !== null && s.temp !== undefined && s.humidity !== null && s.humidity !== undefined)
          .map(s => ({
            value: [s.temp, s.humidity],
            name: s.city, province: s.province, info: s.info
          }));
      }
    },
    async created() { await this.load(); },
    methods: {
      async load() {
        this.loading = true;
        try {
          const [st, rk, ty] = await Promise.all([
            API.stations({ metric: this.metric, province: this.filters.province || undefined, info: this.filters.info || undefined, valid_only: 1 }),
            API.stationRank({ metric: this.metric, order: 'desc', limit: 12 }),
            API.weatherTypes()
          ]);
          this.stations = st.stations || [];
          this.rank = rk.data || [];
          this.types = (ty.data || []).filter(t => t.count > 2).slice(0, 10);
          this.mapName = await MapHub.use('100000');
          this.render();
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      /* 实时推送：重取站点数据，保留当前要素、省份筛选与已打开的站点详情 */
      async onLive() {
        const code = this.detail ? this.detail.code : null;
        const [st, rk, ty] = await Promise.all([
          API.stations({ metric: this.metric, province: this.filters.province || undefined,
                         info: this.filters.info || undefined, valid_only: 1 }),
          API.stationRank({ metric: this.metric, order: 'desc', limit: 12 }),
          API.weatherTypes()
        ]);
        this.stations = st.stations || [];
        this.rank = rk.data || [];
        this.types = (ty.data || []).filter(t => t.count > 2).slice(0, 10);
        if (code) {
          try {
            const r = await API.stationDetail(code);
            this.detail = r.station;
            this.detailFc = r.forecast || [];
          } catch (e) { /* 站点被移除时忽略 */ }
        }
        this.render();
      },
      render() { this.renderMap(); this.renderRank(); this.renderTypes(); this.renderRelation(); },
      renderMap() {
        if (!this.mapName) return;
        const m = this.M;
        const data = this.stations.filter(s => s.lng && s.value !== null && s.value !== undefined)
          .map(s => ({
            name: s.city, value: [s.lng, s.lat, s.value],
            province: s.province, info: s.info, temp: s.temp, humidity: s.humidity, code: s.code
          }));
        this.setChart('map', T.mapOption(this.mapName, {
          geo: { zoom: 1.18, layoutCenter: ['50%', '54%'], layoutSize: '94%' },
          tooltipOpt: {
            formatter: p => {
              const d = p.data || {};
              if (!d.value) return `<b>${p.name}</b>`;
              return `<b>${d.name}</b> <span style="color:#6f89a6">${U.shortName(d.province)}</span>` +
                `<br/>${m.name}：<b style="color:${T.C.cyan}">${U.num(d.value[2], 1)} ${m.unit}</b>` +
                `<br/>天气现象：${d.info}` +
                (d.humidity !== null && d.humidity !== undefined ? `<br/>湿度：${U.num(d.humidity, 0)}%` : '');
            }
          },
          series: [
            {
              type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, data,
              symbolSize: 6.5, zlevel: 2,
              itemStyle: {
                borderColor: 'rgba(255,255,255,.35)', borderWidth: .5,
                shadowBlur: 8, shadowColor: 'rgba(0,0,0,.5)'
              },
              emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1.4 } }
            }
          ],
          visualMap: T.valueVisualMap(this.range[0], this.range[1], m.colors,
            { text: [`${U.num(this.range[1], 0)}${m.unit}`, `${U.num(this.range[0], 0)}${m.unit}`] })
        }));

        this.onChart('map', 'click', async p => {
          if (!p.data || !p.data.code) return;
          await this.openStation(p.data.code);
        });
      },
      renderRank() {
        const d = this.rank.slice(0, 10).reverse();
        this.setChart('rank', T.bar(
          d.map(x => U.shortName(x.city) || x.city),
          d.map(x => x.value), {
            horizontal: true, unit: this.M.unit, barWidth: 13,
            color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                     colorStops: [{ offset: 0, color: '#1d6f9f' }, { offset: 1, color: '#ff8a00' }] },
            grid: { left: 6, right: 58, top: 6, bottom: 6, containLabel: true }
          }));
      },
      renderTypes() {
        this.setChart('types', T.pie(
          this.types.map(t => ({ name: t.name, value: t.count })),
          { legend: true, center: ['50%', '44%'], radius: ['40%', '64%'], unit: '站', label: false }));
      },
      renderRelation() {
        this.setChart('relation', T.scatter(this.relation, {
          xName: '气温 ℃', yName: '相对湿度 %', symbolSize: 6,
          color: 'rgba(63,198,255,.6)',
          grid: { left: 52, right: 20, top: 40, bottom: 40, containLabel: true },
          formatter: p => `<b>${p.data.name}</b><br/>气温 ${U.num(p.data.value[0], 1)}℃` +
                          `<br/>湿度 ${U.num(p.data.value[1], 0)}%`
        }));
      },
      async openStation(code) {
        const r = await API.stationDetail(code);
        this.detail = r.station;
        this.detailFc = r.forecast || [];
        this.setTab('detail');
      },
      /* 切换面板时图表从 display:none 恢复，必须重算尺寸 */
      setTab(t) {
        this.tab = t;
        this.$nextTick(() => setTimeout(() => this.resizeCharts(), 30));
      },
      async setMetric(m) {
        if (this.metric === m) return;
        this.metric = m;
        await this.load();
      },
      async applyProvince() { await this.load(); },
      wIcon(info) {
        const m = { '晴': '☀', '多云': '⛅', '阴': '☁', '小雨': '🌦', '中雨': '🌧', '大雨': '🌧',
                    '暴雨': '⛈', '雷阵雨': '⛈', '小雪': '🌨', '中雪': '❄', '大雪': '❄', '雾': '🌫', '未知': '—' };
        return m[info] || '·';
      },
      shortName: U.shortName
    },
    template: `
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="filterbar">
        <div class="field"><label>要素</label>
          <span class="chip" v-for="(v,k) in {temp:'气温',feelst:'体感',humidity:'湿度',rain:'降水'}"
                :key="k" :class="{on: metric===k}" @click="setMetric(k)">{{ v }}</span>
        </div>
        <div class="field"><label>省份</label>
          <select v-model="filters.province" @change="applyProvince">
            <option value="">全国</option>
            <option v-for="p in provinces" :key="p.adcode" :value="p.name">{{ shortName(p.name) }}</option>
          </select>
        </div>
        <span style="margin-left:auto;font-size:12px;color:#6f89a6">
          显示 <b style="color:#3fc6ff">{{ stations.length }}</b> 个站点 ·
          {{ M.name }}区间 {{ U.num(range[0],1) }} ~ {{ U.num(range[1],1) }} {{ M.unit }}
        </span>
      </div>

      <div class="grid" style="grid-template-columns:minmax(0,1fr) 400px;flex:1;min-height:0">
        <div class="panel">
          <div class="panel-head"><h3>站点 {{ M.name }}空间分布</h3>
            <span class="sub">圆点颜色 = {{ M.name }}（{{ M.unit }}）　点击站点查看详情</span></div>
          <div class="panel-body map-wrap" style="padding:0">
            <div class="chart" ref="map"></div>
          </div>
        </div>

        <div class="col-stack">
          <div class="panel" style="flex:1.15;min-height:0">
            <div class="panel-head">
              <h3>{{ tab==='rank' ? M.name+'极值 TOP10' : tab==='relation' ? '气温—湿度关系' : tab==='types' ? '天气现象构成' : '站点详情' }}</h3>
              <span class="sub" v-if="tab==='detail'" style="cursor:pointer" @click="setTab('rank')">返回排行 ›</span>
            </div>
            <div class="panel-body" style="padding:6px">
              <div class="chart" ref="rank"  v-show="tab==='rank'"></div>
              <div class="chart" ref="relation" v-show="tab==='relation'"></div>
              <div class="chart" ref="types" v-show="tab==='types'"></div>

              <!-- 站点详情 -->
              <div v-if="tab==='detail' && detail" style="height:100%;overflow-y:auto">
                <div class="sd-head">
                  <span class="n">{{ detail.city }}</span>
                  <span class="p">{{ detail.province }} · 站号 {{ detail.code }}</span>
                </div>
                <div class="sd-grid">
                  <div class="sd-cell"><div class="l">气温</div>
                    <div class="v">{{ U.num(detail.temp,1) }}<small>℃</small></div></div>
                  <div class="sd-cell"><div class="l">体感温度</div>
                    <div class="v">{{ U.num(detail.feelst,1) }}<small>℃</small></div></div>
                  <div class="sd-cell"><div class="l">相对湿度</div>
                    <div class="v">{{ U.num(detail.humidity,0) }}<small>%</small></div></div>
                  <div class="sd-cell"><div class="l">降水量</div>
                    <div class="v">{{ U.num(detail.rain,1) }}<small>mm</small></div></div>
                  <div class="sd-cell"><div class="l">天气现象</div>
                    <div class="v" style="font-size:15px">{{ detail.info }}</div></div>
                  <div class="sd-cell"><div class="l">舒适度</div>
                    <div class="v" style="font-size:15px">{{ U.num(detail.rcomfort,0) }}</div></div>
                </div>
                <div style="font-size:11.5px;color:#6f89a6;margin-top:9px">
                  观测发布时间 {{ detail.publish_time }} · 同省站点 {{ detail.peer_count }} 个
                  <template v-if="detail.updates">
                    · 实时刷新 <b style="color:#7cf6d8">{{ detail.updates }}</b> 次
                    （{{ U.ago(detail.updated_at) }}）
                  </template>
                </div>
                <div style="font-size:12px;color:#a9bdd6;margin-top:14px;margin-bottom:2px">未来 7 日预报</div>
                <div class="fc-row">
                  <div class="fc-day" v-for="f in detailFc" :key="f.date">
                    <div class="d">{{ f.date.slice(5) }}</div>
                    <div class="i">{{ wIcon(f.day_info) }} {{ f.day_info }}</div>
                    <div class="t">{{ f.day_temp }}°<i> / {{ f.night_temp }}°</i></div>
                    <div class="d" style="margin-top:3px">{{ f.day_power }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="panel" style="flex:0 0 auto">
            <div class="panel-head"><h3>视图切换</h3></div>
            <div class="panel-body" style="display:flex;gap:7px;flex-wrap:wrap">
              <span class="chip" :class="{on: tab==='rank'}" @click="setTab('rank')">极值排行</span>
              <span class="chip" :class="{on: tab==='relation'}" @click="setTab('relation')">气温—湿度关系</span>
              <span class="chip" :class="{on: tab==='types'}" @click="setTab('types')">天气现象构成</span>
              <span class="chip" v-if="detail" :class="{on: tab==='detail'}" @click="setTab('detail')">
                {{ shortName(detail.city) }} 详情</span>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})();
