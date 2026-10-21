/* ============================================================
   views/playback.js —— 预警时空回放
   把 24 小时里 208 条预警按时间顺序"重放"一遍，
   让静止的数据变成一段可以看的事件流。
   ============================================================ */
(function () {
  'use strict';

  window.ViewPlayback = {
    name: 'v-playback',
    props: { meta: Object, ctx: Object },
    mixins: [ChartHost],
    data() {
      return {
        points: [], frames: [], cum: [],
        idx: 0, playing: false, speed: 2, timer: null,
        mapName: '', filterType: '', filterMinRank: 0,
        /* 用户主动定位的那条预警 {id,lng,lat,zoom,label}；回放推进不动它 */
        focus: null, hotId: null
      };
    },
    computed: {
      revealed() { return this.points.slice(0, this.idx + 1); },
      curPoint() { return this.points[this.idx] || null; },
      curTime() { return this.curPoint ? this.curPoint.ts : '—'; },
      focusMark() {
        const f = this.focus;
        return (f && f.lng !== null && f.lng !== undefined)
          ? [T.focusItem(f.lng, f.lat, f.label)] : [];
      },
      hotMark() {
        const r = this.frameNew.find(x => x.id === this.hotId);
        return (r && r.lng) ? [{ name: r.title || '', value: [r.lng, r.lat] }] : [];
      },
      /* 已揭示的部分中，每个省的累计条数与最高等级 —— 驱动地图色块随时间变化 */
      provStat() {
        const m = {};
        this.revealed.forEach(r => {
          if (!r.province) return;
          const o = m[r.province] || (m[r.province] = { name: r.province, count: 0, rank: 0 });
          o.count++;
          o.rank = Math.max(o.rank, r.level_rank || 0);
        });
        return Object.values(m);
      },
      /* 当前帧（最近 10 分钟窗口）新增的预警 */
      frameNew() {
        if (!this.curPoint) return [];
        const t = this.curPoint.ts;
        const key = t.slice(0, 15) + '0';
        return this.revealed.filter(r => (r.ts.slice(0, 15) + '0') === key).reverse();
      },
      typeOptions() { return (this.meta && this.meta.types) || []; }
    },
    async created() {
      await this.load();
    },
    mounted() {
      /* 键盘：空格播放/暂停、←→ 单步、Esc 清焦点 */
      this._onKey = e => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
        if (this.$root && this.$root.searchOpen) return;
        if (e.key === ' ') { e.preventDefault(); this.toggle(); return; }
        if (e.key === 'Escape') { if (this.focus) this.clearFocus(); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          this.step(e.key === 'ArrowRight' ? 1 : -1);
        }
      };
      window.addEventListener('keydown', this._onKey);
    },
    beforeUnmount() {
      window.removeEventListener('keydown', this._onKey);
      this.stop();
    },
    methods: {
      async load() {
        const r = await API.alarmPlayback({});
        this.points = (r.points || []).filter(p => p.lng && p.lat);
        this.frames = r.frames || [];
        /* 累计曲线 */
        let s = 0;
        this.cum = this.frames.map(f => {
          s += f.new.length;
          return { t: f.t, total: s, level: Object.entries(f.by_level)
            .sort((a, b) => (b[1] - a[1]))[0][0] };
        });
        this.idx = this.points.length - 1;
        this.mapName = await MapHub.use('100000');
        this.renderMap();
        this.renderCum();
      },
      /* 实时推送：回放窗口会随时间往后延伸，重新载入但保留当前位置 */
      async onLive() {
        const keep = this.idx;
        const wasAtEnd = keep >= this.points.length - 1;
        await this.load();
        this.idx = wasAtEnd ? this.points.length - 1 : Math.min(keep, this.points.length - 1);
        this.renderMap();
        this.renderCum();
      },
      renderMap() {
        if (!this.mapName) return;
        /* 视野保住：回放每推进一帧都会 notMerge 重建 option，
           不补这一刀的话用户自己滚出来的视野会被反复弹回 */
        const keepView = this.geoNow('map');
        const pts = this.revealed
          .filter(r => (this.filterMinRank === 0 || r.level_rank >= this.filterMinRank))
          .slice(-260)
          .map((r, i) => ({
            name: r.city || r.province,
            value: [r.lng, r.lat],
            type: r.type, level: r.level, rank: r.level_rank,
            time: r.ts, issuer: r.issuer, title: r.title,
            /* 越新出现的事件画得越大，形成"正在发生"的视觉焦点 */
            fresh: i >= 260 - 18
          }));
        const prov = this.provStat.map(p => ({ name: p.name, value: p.rank, count: p.count }));
        /* 面的暗色走 geo 原生逐区样式：visualMap 要留给图例显示等级原色，
           面若接回 visualMap 就会把同色的标点埋掉（详见 theme.js lvFace 注释） */
        const faceRegions = this.provStat.filter(p => p.name)
          .map(p => ({ name: p.name, itemStyle: { areaColor: T.faceColor(p.rank) } }));

        this.setChart('map', T.mapOption(this.mapName, {
          geo: { zoom: 1.18, layoutCenter: ['50%', '54%'], layoutSize: '94%',
                 regions: faceRegions },
          focus: this.focusMark, hover: [],
          tooltipOpt: {
            formatter: p => {
              if (p.seriesType !== 'scatter' && p.seriesType !== 'effectScatter') {
                return `<b>${p.name}</b><br/>已发布 <b style="color:#3fc6ff">${p.value || 0}</b> 级预警`;
              }
              const d = p.data;
              return `<b>${d.type}${d.level}预警</b><br/>${U.shortName(d.issuer)}<br/>${d.time.slice(5)}`;
            }
          },
          series: [
            /* 底图：随时间累积的省份最高等级 */
            {
              type: 'map', map: this.mapName, geoIndex: 0, name: '累积态势',
              data: prov, silent: true,
              emphasis: { label: { show: false } }
            },
            /* 早期事件：小圆点，弱化 */
            {
              type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 3,
              data: pts.filter(p => !p.fresh), silent: true,
              symbolSize: 5.5,
              /* 不用 large/progressive：增量渲染层不响应 geo 漫游，缩放后点钉死 */
              itemStyle: {
                color: p => U.lvColor(p.data.level), opacity: .55,
                borderColor: 'rgba(255,255,255,.4)', borderWidth: .5
              }
            },
            /* 最新事件：呼吸光圈，形成"正在冒出来"的观感 */
            {
              type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 4,
              data: pts.filter(p => p.fresh), silent: true,
              symbolSize: 9,
              rippleEffect: { brushType: 'stroke', scale: 3, period: 2.4 },
              /* 性能：涟漪层每帧重绘，不做逐点 shadowBlur */
              itemStyle: {
                color: p => U.lvColor(p.data.level),
                borderColor: '#fff', borderWidth: .9
              }
            }
          ],
          visualMap: T.levelVisualMap({ seriesIndex: [] })
        }));

        /* 重建后把视野拉回原处（回放每帧都重建 option，不补一刀就每帧弹回全国） */
        if (keepView && keepView.center) this.geoApply('map', keepView.center, keepView.zoom);
        else if (this.focus) this.geoSet('map', this.focus.lng, this.focus.lat, this.focus.zoom);

        /* 漫游/缩放后的收尾（含悬停圈归位）统一在 charts.js 的 setChart 里挂 */
      },
      /* 悬停圆环的像素位置（DOM 覆盖层定位用） */
      hoverPx() {
        const r = this.frameNew.find(x => x.id === this.hotId);
        if (!r || r.lng === null || r.lng === undefined) return null;
        return this.geoPointToPx('map', r.lng, r.lat);
      },
      renderCum() {
        const b = this.cum.map(c => c.t.slice(5));
        const curKey = this.curPoint ? this.curPoint.ts.slice(0, 15) + '0' : '';
        const pos = this.cum.findIndex(c => c.t.slice(0, 15) + '0' === curKey);
        const markLine = pos >= 0 ? {
          silent: true, symbol: 'none',
          label: { color: '#7cf6d8', fontSize: 11, formatter: '当前时刻' },
          lineStyle: { color: '#7cf6d8', type: 'dashed', width: 1.4 },
          data: [{ xAxis: pos }]
        } : undefined;
        this.setChart('cum', {
          backgroundColor: 'transparent',
          tooltip: T.tooltip({
            trigger: 'axis',
            formatter: p => {
              const i = p[0].dataIndex, c = this.cum[i];
              return `<b>${c.t.slice(5)}</b><br/>累计 <b style="color:#3fc6ff">${c.total}</b> 条`;
            }
          }),
          grid: { left: 40, right: 16, top: 14, bottom: 22, containLabel: true },
          xAxis: T.axisX({
            data: b, boundaryGap: false,
            axisLabel: { color: '#a9bdd6', fontSize: 9, interval: Math.ceil(b.length / 10) }
          }),
          yAxis: T.axisY({ name: '累计条数' }),
          series: [{
            type: 'line', data: this.cum.map(c => c.total), smooth: true,
            showSymbol: false, lineStyle: { width: 2, color: '#3fc6ff' },
            /* 整条线都可点：点哪儿回放就跳到哪个时间窗 */
            triggerLineEvent: true,
            areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#3fc6ff55' }, { offset: 1, color: '#3fc6ff00' }] } },
            markLine
          }]
        });
        /* 曲线 -> 回放：点曲线跳到该时间窗（"点一个东西要有反应"） */
        this.onChart('cum', 'click', p => {
          if (p && p.dataIndex !== undefined && this.cum[p.dataIndex]) {
            this.jumpToBucket(this.cum[p.dataIndex].t);
          }
        });
      },
      /* ---------- 控制 ---------- */
      toggle() { this.playing ? this.stop() : this.play(); },
      play() {
        if (this.idx >= this.points.length - 1) this.idx = 0;
        /* 播放是"看全局"的动作，先把用户手动定位的画面放开 */
        if (this.focus) this.clearFocus();
        this.playing = true;
        this.timer = setInterval(() => {
          if (this.idx >= this.points.length - 1) { this.stop(); return; }
          this.idx++;
          this.renderMap();
          this.renderCum();
        }, Math.max(40, 380 / this.speed));
      },
      stop() {
        this.playing = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      },
      setSpeed(s) { this.speed = s; if (this.playing) { this.stop(); this.play(); } },
      /* 滑杆拖动防抖（同台风页）：拖动中地图按 80ms 间隙成帧，不逐像素重建 */
      onSeek() {
        this.stop();
        if (!this._seekR) this._seekR = U.debounce(() => { this.renderMap(); this.renderCum(); }, 80);
        this._seekR();
      },
      async jumpTo(i) { this.idx = i; this.stop(); this.renderMap(); this.renderCum(); },
      step(d) {
        this.stop();
        const n = this.points.length;
        if (!n) return;
        this.idx = Math.max(0, Math.min(n - 1, this.idx + d));
        this.renderMap();
        this.renderCum();
      },
      setMinRank(r) {
        this.filterMinRank = r;
        this.renderMap();
      },

      /* ---------- 点一条就看得见 ---------- */
      /* 点右侧「当前时间窗新增」某条 -> 暂停回放、把回放头挪到那一刻、
         地图飞过去并打上光圈 + 名称标签 */
      pickNew(r) {
        if (!r || r.lng === null || r.lng === undefined) return;
        this.stop();
        const i = this.points.findIndex(p => p.id === r.id);
        if (i >= 0 && i !== this.idx) {
          this.idx = i;
          this.renderCum();
        }
        const lv = r.county ? 'county' : (r.city ? 'city' : 'province');
        const place = U.shortName(r.county) || U.shortName(r.city) || U.shortName(r.province) || '';
        this.focus = {
          id: r.id, lng: r.lng, lat: r.lat, zoom: T.focusZoom(lv),
          label: r.type + r.level + (place ? ' · ' + place : '')
        };
        this.hotId = null;
        this.renderMap();
        this.geoFly('map', r.lng, r.lat, this.focus.zoom);
      },
      clearFocus() {
        this.focus = null;
        this.hotId = null;
        this.mapOverlay('map', { focus: [] });
        this.geoFly('map', null, null, null);
      },
      /* 悬浮联动走 pushMapHot：滚动/扫过清单时不连发全量重绘（见 charts.js） */
      hoverNew(r) { this.hotId = r.id; this.pushMapHot(); },
      leaveNew() { this.hotId = null; this.pushMapHot(); },
      /* 带着这条预警跳预警地图（那里有完整的现场对照与下钻） */
      openInAlarm() {
        if (!this.focus) return;
        this.$emit('pick', { view: 'alarm', params: { focus: this.focus.id } });
      },
      /* 点累计曲线 -> 跳到该时间窗的最后一帧（比按索引估算准，窗口内条数不等） */
      jumpToBucket(t) {
        const key = String(t).slice(0, 15) + '0';
        let last = -1;
        for (let i = 0; i < this.points.length; i++) {
          if (this.points[i].ts.slice(0, 15) + '0' === key) last = i;
        }
        if (last >= 0) this.jumpTo(last);
      },
      shortName: U.shortName
    },
    template: `
    <div style="display:flex;flex-direction:column;height:100%;gap:12px">
      <div class="filterbar" style="margin:0">
        <div class="field"><label>只看</label>
          <span class="chip" :class="{on: filterMinRank===0}" @click="setMinRank(0)">全部等级</span>
          <span class="chip" :class="{on: filterMinRank===3}" @click="setMinRank(3)">橙色及以上</span>
          <span class="chip" :class="{on: filterMinRank===4}" @click="setMinRank(4)">红色</span>
        </div>
        <span style="margin-left:auto;font-size:12px;color:#6f89a6">
          回放窗口 {{ (points[0]||{}).ts }} → {{ (points[points.length-1]||{}).ts }}
          （共 {{ points.length }} 条预警，{{ cum.length }} 个时间窗）
        </span>
      </div>

      <div class="panel" style="flex:1;min-height:0">
        <div class="panel-head">
          <h3>预警时空回放</h3>
          <span class="sub">色块随回放推进而变化　光圈为当前时刻新发布的预警　
            <span class="kbd-tip"><kbd>空格</kbd>播放<kbd>←</kbd><kbd>→</kbd>单步</span></span>
        </div>
        <div class="panel-body map-wrap" style="padding:0">
          <div class="map-tools" v-if="focus">
            <span class="view-tag">⊙ 已定位：{{ focus.label }}</span>
            <button class="btn ghost reset-view" @click="clearFocus"
                    title="回到全国视野（Esc）">复位视野</button>
          </div>
          <div class="chart" ref="map"></div>
        </div>
      </div>

      <div class="playbar" style="margin:0">
        <button class="play-btn" @click="toggle" :title="playing ? '暂停' : '播放'">
          <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
        </button>
        <div class="track">
          <input type="range" min="0" :max="Math.max(points.length-1,0)" v-model.number="idx" @input="onSeek">
        </div>
        <div class="play-time">{{ curTime }}</div>
        <div class="speed">
          <span class="chip" v-for="s in [1,2,4,8]" :key="s" :class="{on: speed===s && playing}"
                @click="setSpeed(s)" style="padding:3px 9px;font-size:11px">{{ s }}×</span>
        </div>
        <span style="font-size:11.5px;color:#6f89a6;min-width:120px;text-align:right">
          已发布 {{ idx + 1 }} / {{ points.length }} 条
        </span>
      </div>

      <div style="display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:12px;height:186px;flex:0 0 auto">
        <div class="panel">
          <div class="panel-head"><h3>累计发布曲线</h3>
            <span class="sub">斜率越陡 = 该时段天气越活跃</span></div>
          <div class="panel-body" style="padding:4px"><div class="chart" ref="cum"></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>当前时间窗新增</h3>
            <button class="btn ghost" v-if="focus" @click="openInAlarm"
                    style="font-size:11px;padding:2px 9px;margin-left:auto"
                    title="跳到预警地图看完整现场对照">预警地图中打开 ›</button>
            <span class="sub" v-else>{{ frameNew.length }} 条 · 点击定位</span></div>
          <div class="panel-body scroll" style="padding:8px" @mouseleave="leaveNew"
               @scroll.passive="noteListScroll">
            <div class="alist">
              <div class="alist-item" v-for="r in frameNew.slice(0,20)" :key="r.id"
                   :class="{ sel: focus && focus.id === r.id, hot: hotId === r.id }"
                   :style="{'--mc': U.lvColor(r.level)}"
                   @click="pickNew(r)" @mouseenter="hoverNew(r)">
                <div class="ai-top">
                  <span class="badge" :class="'lv-'+r.level">{{ r.type }}{{ r.level }}</span>
                  <span class="ai-time">{{ r.ts.slice(11) }}</span>
                </div>
                <div class="ai-sub">{{ shortName(r.province) }}{{ shortName(r.city) }} ·
                  {{ shortName(r.issuer) }}</div>
              </div>
              <div v-if="!frameNew.length" class="empty" style="padding:20px 0">该时间窗无新增预警</div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})();
