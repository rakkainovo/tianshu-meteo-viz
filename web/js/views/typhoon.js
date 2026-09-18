/* ============================================================
   views/typhoon.js —— 台风路径与强度演变
   左侧：西太平洋路径沙盘（含逐帧回放）
   右侧：台风档案 + 强度演变双轴图 + 台风清单

   技术要点：
   1. 地理坐标系上画折线必须用 lines 系列（polyline: true），
      直角坐标的 line 系列在 geo 上不可用（会报 getBaseAxis 错误）。
   2. 台风路径远及 150°E，超出中国地图包围盒（约 135°E），
      用 geo.boundingCoords 把投影范围动态扩到所有路径的并集。
   ============================================================ */
(function () {
  'use strict';

  /* 中国气象局热带气旋强度分级 */
  const TY = {
    TD:      { cn: '热带低压',   color: '#7cf6d8' },
    TS:      { cn: '热带风暴',   color: '#41d6c3' },
    STS:     { cn: '强热带风暴', color: '#ffd233' },
    TY:      { cn: '台风',       color: '#ff8a00' },
    STY:     { cn: '强台风',     color: '#ff6b6b' },
    SuperTY: { cn: '超强台风',   color: '#ff3b47' }
  };

  window.ViewTyphoon = {
    name: 'v-typhoon',
    props: { meta: Object, ctx: Object },
    mixins: [ChartHost],
    data() {
      return {
        list: [], overview: null, cur: null, path: [], tracks: {},
        idx: 0, playing: false, speed: 1, timer: null,
        mapName: '', filter: 'all'
      };
    },
    computed: {
      shown() {
        return this.filter === 'end' ? this.list.filter(t => t.status !== 'start') : this.list;
      },
      /* 路径包围盒 —— 用于设定地图投影范围，让台风路径完整落在画布内 */
      bounds() {
        const ts = this.shown;
        if (!ts.length) return [[95, 2], [152, 46]];
        const lo = Math.min(...ts.map(t => t.min_lon)) - 4;
        const hi = Math.max(...ts.map(t => t.max_lon)) + 4;
        const la = Math.max(-5, Math.min(...ts.map(t => t.min_lat)) - 3);
        const ha = Math.min(55, Math.max(...ts.map(t => t.max_lat)) + 3);
        return [[lo, la], [hi, ha]];
      },
      livePath() { return this.path.slice(0, this.idx + 1); },
      curPoint() { return this.path[this.idx] || null; },
      timeText() { return this.curPoint ? this.fmt(this.curPoint.time) : '—'; }
    },
    async created() { await this.load(); },
    beforeUnmount() { this.stop(); },
    methods: {
      async load() {
        const [list, ov, tracks] = await Promise.all([
          API.typhoons(), API.typhoonOverview(), API.typhoonTracks()
        ]);
        this.list = list.data || [];
        this.overview = ov;
        this.tracks = {};
        (tracks.data || []).forEach(t => { this.tracks[t.code] = t.coords; });
        this.mapName = await MapHub.use('100000');
        /* 默认选中：活跃台风优先；问答页跳转时按 ctx.code 定位 */
        const target = (this.ctx && this.ctx.code && this.list.find(t => t.code === this.ctx.code))
          || this.list.find(t => t.status === 'start')
          || this.list[0];
        if (target) await this.select(target);
        else this.renderMap();
      },
      /* 实时推送：重取路径（路径只会变长），保留当前选中台风与回放进度 */
      async onLive() {
        const keep = this.cur ? this.ctCode(this.cur) : null;
        const keepIdx = this.idx;
        const [list, ov, tracks] = await Promise.all([
          API.typhoons(), API.typhoonOverview(), API.typhoonTracks()
        ]);
        this.list = list.data || [];
        this.overview = ov;
        this.tracks = {};
        (tracks.data || []).forEach(t => { this.tracks[t.code] = t.coords; });
        const target = (keep && this.list.find(t => this.ctCode(t) === keep)) || this.cur;
        if (target) {
          const r = await API.typhoon(this.ctCode(target));
          this.cur = this.list.find(t => this.ctCode(t) === this.ctCode(target)) || target;
          this.path = r.path || [];
          /* 路径变长时跟随最新位置；否则保持用户当前所在时次 */
          this.idx = this.path.length > keepIdx && keepIdx >= this.path.length - 2
            ? this.path.length - 1 : Math.min(keepIdx, this.path.length - 1);
        }
        this.renderMap();
        this.renderIntensity();
      },
      async select(t) {
        this.stop();
        this.cur = t;
        const r = await API.typhoon(this.ctCode(t));
        this.path = r.path || [];
        this.idx = this.path.length ? this.path.length - 1 : 0;
        this.renderMap();
        this.renderIntensity();
      },
      ctCode(t) { return t.code || String(t.num); },
      pathOf(t) { return (this.tracks && this.tracks[this.ctCode(t)]) || []; },
      /* 台风生命史中的最强等级（后端入库时已算好，避免前端遍历 1536 个路径点） */
      tyOf(t) { return t.max_level || 'TS'; },

      renderMap() {
        if (!this.mapName) return;
        const sel = this.cur ? this.ctCode(this.cur) : null;

        /* ① 背景层：所有台风的完整轨迹（lines 系列 + polyline 模式） */
        const series = [{
          name: '历史路径', type: 'lines', coordinateSystem: 'geo', geoIndex: 0,
          polyline: true, silent: true, zlevel: 1,
          data: this.shown.map(t => {
            const on = sel && this.ctCode(t) === sel;
            return {
              coords: this.pathOf(t),
              lineStyle: {
                color: on ? 'rgba(63,198,255,.40)'
                          : (t.status === 'start' ? 'rgba(63,198,255,.55)' : 'rgba(120,150,190,.30)'),
                width: on ? 1.6 : 1.1,
                type: on ? 'dashed' : 'solid'
              }
            };
          })
        }];

        if (sel) {
          /* ② 已行进段：高亮实线 */
          series.push({
            name: '已行进', type: 'lines', coordinateSystem: 'geo', geoIndex: 0,
            polyline: true, silent: true, zlevel: 4,
            data: [{ coords: this.livePath.map(p => [p.lon, p.lat]) }],
            lineStyle: {
              width: 3, color: '#3fc6ff',
              shadowBlur: 12, shadowColor: 'rgba(63,198,255,.55)'
            }
          });
          /* ③ 路径点按强度着色 */
          series.push({
            name: '路径强度', type: 'scatter', coordinateSystem: 'geo', geoIndex: 0,
            data: this.livePath.map(p => ({
              name: this.fmt(p.time), value: [p.lon, p.lat],
              level: p.level, wind: p.wind_speed, press: p.pressure,
              dir: p.wind_dir, move: p.move_speed
            })),
            symbolSize: 7, zlevel: 5,
            itemStyle: {
              color: p => (TY[p.data.level] || {}).color || '#9aa7b8',
              borderColor: 'rgba(255,255,255,.55)', borderWidth: .8,
              shadowBlur: 8, shadowColor: 'rgba(0,0,0,.6)'
            }
          });
        }

        /* ④ 当前帧位置的光标 */
        const cp = this.curPoint;
        if (cp) {
          series.push({
            name: '当前位置', type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0,
            data: [{ name: this.fmt(cp.time), value: [cp.lon, cp.lat] }],
            symbolSize: 15, zlevel: 6,
            rippleEffect: { brushType: 'stroke', scale: 3.4, period: 2.6 },
            itemStyle: { color: (TY[cp.level] || {}).color || '#fff',
                         borderColor: '#fff', borderWidth: 1.6,
                         shadowBlur: 16, shadowColor: 'rgba(255,255,255,.6)' },
            label: { show: true, formatter: this.name(this.cur),
                     position: 'top', color: '#fff', fontSize: 12, fontWeight: 600,
                     textShadowColor: '#000', textShadowBlur: 8 }
          });
        }

        this.setChart('map', T.mapOption(this.mapName, {
          geo: {
            /* 关键：把投影范围扩到西太平洋，路径才不会跑出画布 */
            boundingCoords: this.bounds,
            zoom: 1, layoutCenter: ['50%', '52%'], layoutSize: '100%',
            itemStyle: { areaColor: 'rgba(16,40,64,.78)', borderColor: 'rgba(96,170,230,.45)', borderWidth: .8 }
          },
          tooltipOpt: {
            formatter: p => {
              const d = p.data || {};
              if (d.wind === undefined) return `<b>${p.name}</b>`;
              const lv = TY[d.level] || { cn: d.level };
              return `<b>${d.name}</b><br/>强度：<b style="color:${lv.color}">${lv.cn}</b>` +
                `<br/>中心风速 ${d.wind} m/s　气压 ${d.press} hPa` +
                `<br/>移向 ${d.dir || '—'}　移速 ${d.move || '—'} km/h`;
            }
          },
          series
        }));

        /* 点击路径点跳转到该时刻 */
        this.onChart('map', 'click', p => {
          if (p.seriesName === '路径强度') {
            this.idx = p.dataIndex;
            this.stop();
            this.renderMap();
          }
        });
      },

      renderIntensity() {
        const pts = this.path;
        if (!pts.length) return;
        const x = pts.map(p => this.fmt(p.time));
        this.setChart('intensity', {
          backgroundColor: 'transparent',
          tooltip: T.tooltip({ trigger: 'axis' }),
          legend: { top: 0, right: 4, itemWidth: 10, itemHeight: 8,
                    textStyle: { color: '#a9bdd6', fontSize: 11 } },
          grid: { left: 46, right: 52, top: 32, bottom: 24, containLabel: true },
          xAxis: T.axisX({ data: x,
            axisLabel: { color: '#a9bdd6', fontSize: 9, interval: Math.max(1, Math.ceil(x.length / 6)) } }),
          yAxis: [
            T.axisY({ name: 'm/s', nameTextStyle: { color: '#6f89a6', fontSize: 10 } }),
            T.axisY({ name: 'hPa', inverse: true,
              min: v => Math.floor((v.min - 4) / 5) * 5,
              max: v => Math.ceil((v.max + 4) / 5) * 5,
              nameTextStyle: { color: '#6f89a6', fontSize: 10 } })
          ],
          series: [
            {
              name: '中心风速', type: 'line', yAxisIndex: 0,
              data: pts.map(p => p.wind_speed), smooth: true, showSymbol: false,
              lineStyle: { width: 2.2, color: '#ff6b6b', shadowBlur: 10, shadowColor: '#ff6b6b66' },
              areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [{ offset: 0, color: '#ff6b6b44' }, { offset: 1, color: '#ff6b6b00' }] } }
            },
            {
              name: '中心气压', type: 'line', yAxisIndex: 1,
              data: pts.map(p => p.pressure), smooth: true, showSymbol: false,
              lineStyle: { width: 2, color: '#3fc6ff', type: 'dashed' }
            }
          ]
        });
      },

      /* ---------- 回放控制 ---------- */
      toggle() { this.playing ? this.stop() : this.play(); },
      play() {
        if (!this.path.length) return;
        if (this.idx >= this.path.length - 1) this.idx = 0;
        this.playing = true;
        this.timer = setInterval(() => {
          if (this.idx >= this.path.length - 1) { this.stop(); return; }
          this.idx++;
          this.renderMap();
        }, Math.max(60, 320 / this.speed));
      },
      stop() {
        this.playing = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      },
      setSpeed(s) { this.speed = s; if (this.playing) { this.stop(); this.play(); } },
      onSeek() { this.stop(); this.renderMap(); },

      /* 台风编号 20260027 -> 2026 年第 27 号；2604 -> 2026 年第 4 号 */
      fmtCode(t) {
        const c = String(t.code || t.num || '');
        if (c.length === 8) return `${c.slice(0, 4)} 年第 ${Number(c.slice(4))} 号`;
        if (c.length === 4) return `20${c.slice(0, 2)} 年第 ${Number(c.slice(2))} 号`;
        return c;
      },
      fmt(s) {
        if (!s) return '—';
        s = String(s);
        return s.length >= 12 ? `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}时` : s;
      },
      name(t) { return (t.name_cn && t.name_cn !== 'nameless') ? t.name_cn : (t.name_en || '未命名'); },
      tyCn(lv) { return (TY[lv] || { cn: lv }).cn; },
      tyColor(lv) { return (TY[lv] || { color: '#9aa7b8' }).color; }
    },
    template: `
    <div style="display:flex;flex-direction:column;height:100%">
      <div class="filterbar">
        <div class="field"><label>范围</label>
          <span class="chip" :class="{on: filter==='all'}" @click="filter='all'; $nextTick(renderMap)">全部 {{ list.length }}</span>
          <span class="chip" :class="{on: filter==='end'}" @click="filter='end'; $nextTick(renderMap)">已停编</span>
        </div>
        <span style="margin-left:auto;font-size:12px;color:#6f89a6">
          数据集记录 <b style="color:#3fc6ff">{{ list.length }}</b> 个台风 ·
          <b style="color:#3fc6ff">{{ U.num(meta.kpi && meta.kpi.typhoon_points) }}</b> 个路径点 ·
          地图范围 {{ bounds[0][0].toFixed(0) }}°E–{{ bounds[1][0].toFixed(0) }}°E
        </span>
      </div>

      <div class="grid" style="grid-template-columns:minmax(0,1fr) 386px;flex:1;min-height:0">
        <div class="col-stack">
          <div class="panel" style="flex:1">
            <div class="panel-head">
              <h3>西太平洋台风路径沙盘</h3>
              <span class="sub">虚线 = 完整路径　实线 = 已行进　点击路径点可定位该时刻</span>
            </div>
            <div class="panel-body map-wrap" style="padding:0">
              <div class="chart" ref="map"></div>
              <div class="legend-box">
                <div class="legend-row" v-for="(v,k) in {SuperTY:'超强台风',STY:'强台风',TY:'台风',STS:'强热带风暴',TS:'热带风暴',TD:'热带低压'}"
                     :key="k">
                  <span class="legend-swatch" :style="{background: tyColor(k)}"></span>{{ v }}
                </div>
              </div>
            </div>
          </div>

          <!-- 回放控制 -->
          <div class="playbar">
            <button class="play-btn" @click="toggle" :title="playing ? '暂停' : '播放'">
              <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
            </button>
            <div class="track">
              <input type="range" min="0" :max="Math.max(path.length-1,0)" v-model.number="idx" @input="onSeek">
            </div>
            <div class="play-time">{{ timeText }}</div>
            <div class="speed">
              <span class="chip" v-for="s in [1,2,4,8]" :key="s" :class="{on: speed===s && playing}"
                    @click="setSpeed(s)" style="padding:3px 9px;font-size:11px">{{ s }}×</span>
            </div>
            <span style="font-size:11.5px;color:#6f89a6;min-width:96px;text-align:right">
              {{ idx + 1 }} / {{ path.length }} 时次
            </span>
          </div>
        </div>

        <div class="col-stack">
          <!-- 台风档案 -->
          <div class="panel" style="flex:0 0 auto">
            <div class="panel-head"><h3>台风档案</h3>
              <span class="sub" v-if="cur && cur.status==='start'" style="color:#ff8a00">● 活跃中</span></div>
            <div class="panel-body" v-if="cur">
              <div class="sd-head">
                <span class="n">{{ name(cur) }}</span>
                <span class="p">{{ cur.name_en }} · {{ fmtCode(cur) }}</span>
              </div>
              <div class="sd-grid">
                <div class="sd-cell"><div class="l">最大风速</div>
                  <div class="v">{{ U.num(cur.max_wind,0) }}<small>m/s</small></div></div>
                <div class="sd-cell"><div class="l">最低气压</div>
                  <div class="v">{{ U.num(cur.min_pressure,0) }}<small>hPa</small></div></div>
                <div class="sd-cell"><div class="l">路径点数</div>
                  <div class="v">{{ cur.points }}</div></div>
                <div class="sd-cell" style="grid-column:span 3"><div class="l">生命史</div>
                  <div class="v" style="font-size:13px">{{ fmt(cur.start_time) }} → {{ fmt(cur.end_time) }}
                    <small>· 累计行程约 {{ U.num(cur.track_km) }} km</small></div></div>
              </div>
            </div>
          </div>

          <!-- 强度演变 -->
          <div class="panel" style="flex:1">
            <div class="panel-head"><h3>强度演变</h3><span class="sub">风速与气压呈镜像关系</span></div>
            <div class="panel-body" style="padding:6px"><div class="chart" ref="intensity"></div></div>
          </div>

          <!-- 台风清单 -->
          <div class="panel" style="flex:1">
            <div class="panel-head"><h3>台风清单</h3><span class="sub">按最强风速排序</span></div>
            <div class="panel-body scroll">
              <div class="alist">
                <div class="alist-item" v-for="t in list.slice().sort((a,b)=>b.max_wind-a.max_wind)"
                     :key="ctCode(t)" :style="{'--mc': t.status==='start' ? '#7cf6d8' : '#40597a'}"
                     @click="select(t)">
                  <div class="ai-top">
                    <span style="font-size:13px;font-weight:600;color:#e8f0fb">{{ name(t) }}</span>
                    <span class="badge" :style="{color: tyColor(tyOf(t))}">{{ tyCn(tyOf(t)) }}</span>
                    <span class="ai-time">{{ (t.start_time||'').slice(4,8) }}</span>
                  </div>
                  <div class="ai-sub">{{ fmtCode(t) }} · 最大风速 {{ U.num(t.max_wind,0) }} m/s ·
                    气压 {{ U.num(t.min_pressure,0) }} hPa</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})();
