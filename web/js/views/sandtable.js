(function () {
  'use strict';
  const D = window.SandData;
  const icon = name => window.lucide.createElement(window.lucide.icons[name], { width: 16, height: 16, 'aria-hidden': 'true' }).outerHTML;
  async function read(url, signal) {
    const response = await fetch(url, { signal, cache: url.startsWith('/api/geo/') ? 'default' : 'no-store' });
    if (!response.ok) throw new Error('数据请求失败 · HTTP ' + response.status);
    const body = await response.json();
    if (body.ok === false) throw new Error(body.msg || '数据请求失败');
    return body;
  }
  window.ViewSandtable = {
    name: 'v-sandtable',
    props: { meta: Object, ctx: Object, route: Object },
    mixins: [ChartHost],
    data() {
      return { loading: true, error: '', sceneError: '', geo: null, trail: [], active: [], history: [], activeInfo: {},
        activeTotal: 0, mode: 'active', viewMode: '3d', historyRange: '24', customDays: 7,
        historyAsOf: Date.now(), frame: 0, speed: 2, playing: false,
        type: '', minRank: 0, columns: true, points: true, labels: true, tab: 'regions', selected: null,
        hover: null, hoverX: 0, hoverY: 0, maxCount: 1, drilling: false, terrainEnabled: false, terrainLoading: false };
    },
    computed: {
      allRows() { return this.mode === 'active' ? this.active : this.history; },
      typeOptions() { return Array.from(new Set(this.active.concat(this.history).map(r => r.type))).sort(); },
      field() { return this.trail.length === 0 ? 'province' : this.trail.length === 1 ? 'city' : 'county'; },
      regionName() { return this.trail.length ? this.trail[this.trail.length - 1].name : '全国'; },
      hours() {
        if (this.historyRange === 'all') return 0;
        return this.historyRange === 'custom'
          ? Math.min(365, Math.max(1, Math.round(Number(this.customDays) || 7))) * 24 : Number(this.historyRange);
      },
      rangeLabel() {
        if (this.historyRange === 'all') return '全部历史';
        return this.hours < 24 ? '最近 ' + this.hours + ' 小时' : '最近 ' + (this.hours / 24) + ' 天';
      },
      end() { return this.historyAsOf; },
      start() {
        if (this.historyRange === 'all') return Math.min(this.end, this.history.length ? this.history[0]._time : this.end);
        return this.end - this.hours * 3600000;
      },
      steps() { return Math.max(0, Math.ceil((this.end - this.start) / 600000)); },
      cursor() { return Math.min(this.end, this.start + this.frame * 600000); },
      filtered() {
        return D.filter(this.allRows, { type: this.type, rank: Number(this.minRank), trail: this.trail,
          historical: this.mode === 'history', start: this.start, cursor: this.cursor });
      },
      stats() { return this.geo ? D.aggregate(this.filtered, this.geo, this.field) : []; },
      ranked() { return this.stats.slice().sort((a, b) => b.count - a.count || b.rank - a.rank); },
      referenceMax() {
        if (this.mode === 'active') return Math.max(1, ...this.stats.map(s => s.count));
        const rows = D.filter(this.history, { type: this.type, rank: Number(this.minRank), trail: this.trail,
          historical: true, start: this.start, cursor: this.end });
        return Math.max(1, ...D.aggregate(rows, this.geo || { features: [] }, this.field).map(s => s.count));
      },
      regionCount() { return this.stats.filter(r => r.count > 0).length; },
      severe() { return this.filtered.filter(r => r.level_rank >= 3).length; },
      unmatched() { return this.filtered.length - this.stats.reduce((n, s) => n + s.count, 0); },
      located() { return this.filtered.filter(r => Number.isFinite(r.lng) && Number.isFinite(r.lat) && r.lng > 0 && r.lat > 0).length; },
      alerts() { return this.filtered.slice().sort((a, b) => b._time - a._time).slice(0, 80); },
      clockText() { return this.mode === 'history' ? this.format(this.cursor) : (this.activeInfo.scan_at || '采集时间未知'); },
      hoverTitle() { return !this.hover ? '' : this.hover.kind === 'alarm' ? this.hover.record.title : this.hover.name; },
      hoverSub() {
        if (!this.hover) return '';
        if (this.hover.kind === 'alarm') return this.hover.record.ts + ' · ' + this.hover.record.level;
        const s = this.hover.stat;
        return s ? s.count + ' 条 · ' + (s.count ? '最高' + s.level : '无匹配预警') : '';
      }
    },
    watch: {
      filtered() {
        if (this.selected) this.selected = this.filtered.find(r => r.id === this.selected.id) || null;
        this.hover = null;
        this.redraw();
      },
      columns() { this.redraw(); }, points() { this.redraw(); }, labels() { this.redraw(); }, selected() { this.redraw(); }
    },
    async mounted() {
      this._alive = true;
      this._onEscape = event => {
        if (event.key !== 'Escape' || event.repeat || event.isComposing || event.defaultPrevented) return;
        if (this.$root.searchOpen || !this.trail.length || this.drilling || this.loading) return;
        const target = event.target;
        if (target && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]'))) return;
        event.preventDefault();
        this.backRegion();
      };
      // Capture before the global search handler closes its panel.
      window.addEventListener('keydown', this._onEscape, true);
      await this.load(true);
    },
    beforeUnmount() {
      this._alive = false;
      window.removeEventListener('keydown', this._onEscape, true);
      this.pause();
      if (this._abort) this._abort.abort();
      if (this._geoAbort) this._geoAbort.abort();
      if (this._scene) this._scene.dispose();
    },
    methods: {
      icon,
      validUrl(url) { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch (e) { return false; } },
      format(t) { return t ? new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16) : '—'; },
      async load(initial = false) {
        if (this._abort) this._abort.abort();
        this._abort = new AbortController();
        const signal = this._abort.signal;
        this.loading = initial;
        this.error = '';
        const oldCursor = this.cursor, atEnd = this.frame >= this.steps;
        try {
          const [active, history, geo] = await Promise.all([
            read('/api/alarms?active=1&period=today&limit=3000', signal),
            read('/api/alarms/playback', signal),
            initial ? read('/api/geo/100000', signal) : Promise.resolve(this.geo)
          ]);
          if (!this._alive || signal.aborted) return;
          this.active = (active.records || []).map(r => Object.assign({}, r, { _time: D.time(r.ts) }));
          this.history = (history.points || []).map(r => Object.assign({}, r, { _time: D.time(r.ts) }))
            .filter(r => Number.isFinite(r._time)).sort((a, b) => a._time - b._time);
          // 最近 N 天以本次读取时刻为终点，避免断采时把旧记录当成最近几天。
          this.historyAsOf = Date.now();
          this.activeTotal = active.total;
          this.activeInfo = active.active || {};
          this.frame = atEnd || initial ? this.steps : Math.max(0, Math.min(this.steps, Math.round((oldCursor - this.start) / 600000)));
          if (initial) this.geo = geo;
          this.loading = false;
          await this.$nextTick();
          if (initial) await this.initScene();
          this.redraw();
        } catch (e) {
          if (e.name !== 'AbortError' && this._alive) { this.error = e.message; this.loading = false; }
        }
      },
      async onLive(msg) {
        if (!msg || ['alarm', 'poll', 'manual', 'resume'].includes(msg.job)) await this.load(!this.geo);
      },
      async initScene() {
        if (!this.geo || this._scene) return;
        try {
          const { SandScene } = await import('/js/sand-scene.js');
          if (!this._alive) return;
          this._scene = new SandScene(this.$refs.scene, {
            pick: item => this.pick(item), scale: max => { this.maxCount = max; },
            error: message => { this.sceneError = message; this.setView('2d'); },
            hover: (item, x, y) => {
              this.hover = item;
              if (!item) return;
              const rect = this.$refs.stage.getBoundingClientRect();
              this.hoverX = Math.max(8, Math.min(rect.width - 248, x - rect.left + 14));
              this.hoverY = Math.max(8, Math.min(rect.height - 86, y - rect.top + 14));
            }
          });
          this._scene.setMap(this.geo);
        } catch (e) {
          this.sceneError = '此设备无法打开三维地图，已切换二维视图。';
          this.viewMode = '2d';
          await this.$nextTick();
          this.render2d();
        }
      },
      redraw() {
        if (!this._alive || !this.geo || this.loading) return;
        this.maxCount = this.referenceMax;
        if (this._scene) this._scene.setData(this.stats, this.filtered,
          { columns: this.columns, points: this.points, labels: this.labels, selected: this.selected, referenceMax: this.referenceMax });
        if (this.viewMode === '2d') this.$nextTick(() => this.render2d());
      },
      async setView(mode) {
        this.viewMode = mode;
        this.hover = null;
        await this.$nextTick();
        if (mode === '2d') this.render2d();
        else if (this._scene) this._scene.resize();
      },
      async render2d() {
        if (!this.geo || !this._alive || this.viewMode !== '2d') return;
        const name = 'sand-' + (this.trail.length ? this.trail[this.trail.length - 1].adcode : '100000');
        if (!echarts.getMap(name)) echarts.registerMap(name, this.geo);
        const series = [{ type: 'map', geoIndex: 0, data: this.stats.map(s => ({ name: s.name, value: s.count,
          itemStyle: { areaColor: s.count ? (T.C.lvFace[s.level] || T.C.faceEmpty) : T.C.faceEmpty }, stat: s })) }];
        if (this.points) series.push({ type: 'scatter', coordinateSystem: 'geo', symbolSize: 7,
          data: this.filtered.filter(r => Number.isFinite(r.lng) && Number.isFinite(r.lat) && r.lng > 0 && r.lat > 0)
            .map(r => ({ value: [r.lng, r.lat], record: r, itemStyle: { color: U.lvColor(r.level) } })) });
        if (this.selected && Number.isFinite(this.selected.lng) && Number.isFinite(this.selected.lat)) {
          series.push({ type: 'effectScatter', coordinateSystem: 'geo', symbolSize: 15, silent: true,
            data: [[this.selected.lng, this.selected.lat]], itemStyle: { color: T.C.cyan } });
        }
        this.setChart('flat', { backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--panel-solid').trim(),
          geo: { map: name, roam: true, layoutCenter: ['50%', '50%'], layoutSize: '88%',
            itemStyle: { areaColor: T.C.faceEmpty, borderColor: T.C.axis, borderWidth: 0.7 },
            label: { show: this.labels, color: T.C.fg2, fontSize: 10 },
            emphasis: { label: { color: T.C.fg }, itemStyle: { areaColor: '#214d73' } } },
          tooltip: { trigger: 'item', renderMode: 'richText', formatter: p => p.data && p.data.record
            ? p.data.record.title + '\n' + p.data.record.ts : p.name + ' · ' + (p.value || 0) + ' 条' }, series });
        this.onChart('flat', 'click', p => {
          if (p.data && p.data.record) this.selectAlert(p.data.record);
          else if (p.data && p.data.stat) this.drill(p.data.stat.feature);
        });
        this.chart('flat').resize();
      },
      pick(item) {
        if (!item) return;
        this.hover = null;
        if (item.kind === 'alarm') this.selectAlert(item.record);
        else if (item.feature) this.drill(item.feature);
      },
      selectAlert(record) { this.selected = record; this.tab = 'alerts'; },
      async drill(feature) {
        if (this.drilling || !feature.properties.name) return;
        if (this.trail.length >= 2 || !feature.properties.childrenNum) {
          this.openRegionMap(feature);
          return;
        }
        const next = { name: feature.properties.name, adcode: String(feature.properties.adcode), level: this.field };
        await this.changeRegion(this.trail.concat(next));
      },
      backRegion() {
        if (this.trail.length && !this.drilling) return this.changeRegion(this.trail.slice(0, -1));
      },
      async changeRegion(trail) {
        if (this.drilling) return;
        this.drilling = true;
        this._geoAbort = new AbortController();
        try {
          const geo = await read('/api/geo/' + (trail.length ? trail[trail.length - 1].adcode : '100000'), this._geoAbort.signal);
          if (!this._alive) return;
          this.trail = trail;
          this.geo = geo;
          this.selected = null;
          this.hover = null;
          if (this._scene) this._scene.setMap(geo);
          this.recreateChart('flat');
          this.redraw();
        } catch (e) { if (e.name !== 'AbortError') this.flash(e.message, 'warn'); }
        finally { if (this._alive) this.drilling = false; }
      },
      setMode(mode) { this.pause(); this.mode = mode; this.selected = null; this.frame = this.steps; },
      setHistoryRange(range) {
        if (range === 'today') { this.setMode('active'); return; }
        this.historyRange = range;
        this.setMode('history');
      },
      setWindow() {
        const days = Number(this.customDays);
        this.customDays = Number.isFinite(days) ? Math.min(365, Math.max(1, Math.round(days))) : 7;
        this.pause(); this.frame = this.steps; this.selected = null;
      },
      seek(event) { this.pause(); this.frame = Number(event.target.value); },
      step(delta) { this.pause(); this.frame = Math.max(0, Math.min(this.steps, this.frame + delta)); },
      pause() { clearInterval(this._timer); this._timer = null; this.playing = false; },
      togglePlay() {
        if (this.playing) { this.pause(); return; }
        if (!this.steps) return;
        if (this.frame >= this.steps) this.frame = 0;
        this.playing = true;
        this._timer = setInterval(() => {
          this.frame = Math.min(this.steps, this.frame + Number(this.speed));
          if (this.frame >= this.steps) this.pause();
        }, 350);
      },
      home(top) { if (this.viewMode === '3d' && this._scene) this._scene.home(top); else this.geoReset('flat'); },
      zoom(factor) { if (this.viewMode === '3d' && this._scene) this._scene.zoom(factor); else this.zoomAt('flat', factor > 1 ? 1 : -1); },
      openRegionMap(feature) {
        const props = feature && feature.properties;
        const historical = this.mode === 'history';
        const timestamp = t => new Date(t).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
        // The destination must fetch the latest scan and keep the sandtable's scope.
        API.invalidate(['/api/alarms', '/api/meta']);
        this.$root.go('alarm', {
          adcode: props ? props.adcode : this.trail.length ? this.trail[this.trail.length - 1].adcode : '',
          county: props && this.field === 'county' ? props.name : '',
          hist: historical ? 1 : '', type: this.type, min_rank: this.minRank || '',
          since: historical && this.start ? timestamp(this.start) : '',
          until: historical && this.cursor ? timestamp(this.cursor) : ''
        });
      },
      async toggleTerrain() {
        if (!this._scene) return;

        if (!this.terrainEnabled) {
          // 启用地形
          this.terrainLoading = true;
          try {
            const adcode = this.trail.length ? this.trail[this.trail.length - 1].adcode : '100000';
            const loaded = await this._scene.loadTerrain(adcode);
            if (loaded) {
              this.terrainEnabled = true;
              this._scene.toggleTerrain(true);
              this._scene.applyTerrain();
            } else {
              // 静默失败，不显示警告
              this.terrainEnabled = false;
            }
          } catch (e) {
            // 静默失败，不显示警告
            this.terrainEnabled = false;
          } finally {
            this.terrainLoading = false;
          }
        } else {
          // 禁用地形
          this.terrainEnabled = false;
          this._scene.toggleTerrain(false);
          // 重新加载地图以恢复平面效果
          if (this.geo) {
            this._scene.setMap(this.geo);
            this.redraw();
          }
        }
      }
    },
    template: `
      <section class="sand-wrap">
        <header class="sand-header">
          <div class="sand-heading"><h2>三维气象沙盘</h2><span class="sand-live" :class="{ historical: mode === 'history', stale: activeInfo.stale && mode === 'active' }">{{ mode === 'history' ? rangeLabel + ' · 累计发布' : activeInfo.stale ? '上次采集快照' : '今日生效' }}</span></div>
          <div class="sand-filters">
            <div class="sand-segment" aria-label="数据口径"><button :class="{ active: mode === 'active' }" @click="setMode('active')">今日生效</button><button :class="{ active: mode === 'history' }" @click="setMode('history')">历史回放</button></div>
            <label class="sand-range">时间范围
              <select :value="mode === 'active' ? 'today' : historyRange" @change="setHistoryRange($event.target.value)" aria-label="沙盘时间范围">
                <option value="today">今日生效</option><option value="6">最近 6 小时</option>
                <option value="24">最近 1 天</option><option value="72">最近 3 天</option>
                <option value="168">最近 7 天</option><option value="360">最近 15 天</option>
                <option value="720">最近 30 天</option><option value="custom">自定义天数</option><option value="all">全部历史</option>
              </select>
            </label>
            <label class="sand-range" v-if="mode === 'history' && historyRange === 'custom'">最近
              <input type="number" v-model="customDays" @change="setWindow" min="1" max="365" step="1" aria-label="自定义历史天数">天
            </label>
            <select v-model="type" aria-label="灾种筛选"><option value="">全部灾种</option><option v-for="t in typeOptions" :key="t">{{ t }}</option></select>
            <select v-model.number="minRank" aria-label="预警等级筛选"><option :value="0">全部等级</option><option :value="3">橙色及以上</option><option :value="4">仅红色</option></select>
          </div>
        </header>
        <div class="sand-status" v-if="error || sceneError || (activeInfo.stale && mode === 'active') || (mode === 'active' && (active.length < activeTotal || !$root.liveOn))">
          <span>{{ error || sceneError || (activeInfo.stale ? '预警采集已过期 · 数据截至 ' + (activeInfo.scan_at || '未知') : !$root.liveOn ? '自动更新已暂停 · 数据截至 ' + (activeInfo.scan_at || '未知') : '已加载 ' + active.length + ' / ' + activeTotal + ' 条预警') }}</span>
          <button v-if="error" @click="load(!geo)">重试</button>
        </div>
        <div class="sand-workspace">
          <div class="sand-main">
            <div class="sand-infobar">
              <div class="sand-location">
                <button class="sand-icon sand-back" aria-label="返回上一级" :title="trail.length ? '返回' + (trail.length > 1 ? trail[trail.length - 2].name : '全国') : '已在全国视图'" :disabled="drilling || !trail.length" @click="backRegion" v-html="icon('ArrowLeft')"></button>
                <nav class="sand-breadcrumb" aria-label="行政区划"><button @click="changeRegion([])" :disabled="drilling || !trail.length" :aria-current="!trail.length ? 'page' : null" title="返回全国">全国</button><template v-for="(r, i) in trail" :key="r.adcode"><span> / </span><button @click="changeRegion(trail.slice(0,i+1))" :disabled="drilling || i === trail.length - 1" :aria-current="i === trail.length - 1 ? 'page' : null" :title="'返回' + r.name">{{ U.shortName(r.name) }}</button></template></nav>
              </div>
              <span class="sand-asof">{{ mode === 'history' ? '回放时刻' : '采集于' }} {{ clockText }}</span>
            </div>
            <div class="sand-kpis">
              <div><span>{{ mode === 'history' ? '累计发布' : '今日生效预警' }}</span><strong>{{ U.num(filtered.length) }}<small>条</small></strong></div>
              <div><span>{{ field === 'province' ? '覆盖省级区域' : field === 'city' ? '覆盖地市' : '覆盖区县' }}</span><strong>{{ regionCount }}<small>个</small></strong></div>
              <div><span>橙色及以上</span><strong class="sand-severe">{{ severe }}<small>条</small></strong></div>
              <div><span>已定位预警</span><strong>{{ U.num(located) }}<small>条</small></strong></div>
            </div>
            <div class="sand-stage" ref="stage" :aria-busy="loading || drilling">
              <div ref="scene" class="sand-canvas-host" v-show="viewMode === '3d'"></div>
              <div ref="flat" class="sand-flat" v-show="viewMode === '2d'"></div>
              <div class="sand-tools">
                <div class="sand-segment" aria-label="地图视图"><button @click="setView('3d')" :class="{active:viewMode==='3d'}" :disabled="!!sceneError">3D</button><button @click="setView('2d')" :class="{active:viewMode==='2d'}">2D</button></div>
                <button class="sand-icon" :class="{active:terrainEnabled}" title="地形高程" aria-label="地形高程" @click="toggleTerrain" :disabled="viewMode !== '3d' || terrainLoading" v-html="icon('Mountain')"></button>
                <button class="sand-icon" title="放大" aria-label="放大" @click="zoom(1.25)" v-html="icon('Plus')"></button>
                <button class="sand-icon" title="缩小" aria-label="缩小" @click="zoom(0.8)" v-html="icon('Minus')"></button>
                <button class="sand-icon" title="俯视" aria-label="俯视" @click="home(true)" v-html="icon('Scan')"></button>
                <button class="sand-icon" title="复位" aria-label="复位" @click="home(false)" v-html="icon('RotateCcw')"></button>
              </div>
              <div class="sand-stage-loading" v-if="loading || drilling"><span class="boot-ring"></span><span>{{ drilling ? '载入区域边界' : '载入气象数据' }}</span></div>
              <div class="sand-empty" v-if="!loading && !error && !filtered.length">{{ mode === 'history' ? '此时间窗无匹配预警' : '今天无匹配的生效预警' }}</div>
              <div v-if="hover && viewMode === '3d'" class="sand-tooltip" :style="{left:hoverX+'px',top:hoverY+'px'}"><strong>{{ hoverTitle }}</strong><span>{{ hoverSub }}</span></div>
              <div class="sand-map-legend"><span v-for="rank in [1,2,3,4]" :key="rank"><i :style="{background:U.lvColor(SandLevels[rank])}"></i>{{ SandLevels[rank] }}</span><span v-if="columns && viewMode==='3d'" class="sand-height-key">柱高 · 条数 0—{{ maxCount }}</span></div>
            </div>
            <div class="sand-layers"><label><input type="checkbox" v-model="columns" :disabled="viewMode === '2d'">数量柱</label><label><input type="checkbox" v-model="points">预警点</label><label><input type="checkbox" v-model="labels">地名</label><span v-if="unmatched > 0">{{ unmatched }} 条未匹配当前区划</span><button @click="openRegionMap">预警地图 <span v-html="icon('ArrowUpRight')"></span></button></div>
          </div>
          <aside class="sand-sidebar">
            <div class="sand-side-tabs"><button :class="{active:tab==='regions'}" @click="tab='regions'">区域排序</button><button :class="{active:tab==='alerts'}" @click="tab='alerts'">预警清单 <small>{{ filtered.length }}</small></button></div>
            <div class="sand-detail" v-if="selected">
              <button class="sand-icon sand-close" title="关闭详情" aria-label="关闭详情" @click="selected=null" v-html="icon('X')"></button>
              <span class="sand-level" :style="{color:U.lvColor(selected.level)}">{{ selected.type }} · {{ selected.level }}</span>
              <h3>{{ selected.title }}</h3><p>{{ selected.issuer }}</p><time>{{ selected.ts }}</time>
              <a v-if="selected.url && validUrl(selected.url)" :href="selected.url" target="_blank" rel="noopener noreferrer">发布原文 <span v-html="icon('ExternalLink')"></span></a>
            </div>
            <div class="sand-side-scroll">
              <template v-if="tab==='regions'"><p class="sand-side-caption">{{ regionName }} · {{ mode==='history' ? '累计发布条数' : '今日生效预警条数' }}</p>
                <button class="sand-rank" v-for="(s,i) in ranked" :key="s.adcode" @click="drill(s.feature)" :disabled="drilling"><span class="sand-rank-index">{{ String(i+1).padStart(2,'0') }}</span><div><span>{{ U.shortName(s.name) }}</span><div class="sand-bar-track"><i :style="{width:(s.count/maxCount*100)+'%',background:s.count ? U.lvColor(s.level) : 'var(--fg-3)'}"></i></div></div><strong>{{ s.count }}</strong><span class="sand-rank-arrow" v-html="icon('ChevronRight')"></span></button>
              </template>
              <template v-else><p class="sand-side-caption">{{ alerts.length }} / {{ filtered.length }} 条 · 最新发布在前</p><button v-for="r in alerts" :key="r.id" class="sand-alert" :class="{selected:selected && selected.id===r.id}" @click="selectAlert(r)"><div><span :style="{color:U.lvColor(r.level)}">{{ r.type }} · {{ r.level }}</span><time>{{ r.ts.slice(5) }}</time></div><strong>{{ r.title }}</strong><small>{{ r.city || r.county || r.province }}</small></button></template>
              <p class="sand-side-caption" v-if="!loading && !filtered.length">无匹配预警</p>
            </div>
          </aside>
        </div>
        <footer class="sand-timeline" v-if="mode === 'history'">
          <div class="sand-transport"><button class="sand-icon" title="上一帧" aria-label="上一帧" @click="step(-1)" :disabled="!steps" v-html="icon('SkipBack')"></button><button class="sand-icon sand-play" :title="playing?'暂停':'播放'" :aria-label="playing?'暂停':'播放'" @click="togglePlay" :disabled="!steps" v-html="icon(playing?'Pause':'Play')"></button><button class="sand-icon" title="下一帧" aria-label="下一帧" @click="step(1)" :disabled="!steps" v-html="icon('SkipForward')"></button><select v-model.number="speed" aria-label="回放速度"><option v-for="v in [1,2,4,8]" :value="v">{{ v }}×</option></select></div>
          <div class="sand-scrubber"><div><span>{{ format(start) }}</span><strong>{{ format(cursor) }}</strong><span>{{ format(end) }}</span></div><input type="range" aria-label="回放时间轴" :min="0" :max="steps || 1" :value="frame" :disabled="!steps" @input="seek"></div>
          <span class="sand-timeline-note">{{ rangeLabel }} · 累计发布（含已失效）<br>已采集记录始于 {{ history.length ? format(history[0]._time) : '暂无记录' }}</span>
        </footer>
        <footer class="sand-footnote" v-else><span>仅展示今天（北京时间）发布且仍生效的预警 · 中国气象局 / 中国天气网</span><span>最高预警等级 · {{ regionName }}</span></footer>
      </section>`
  };
  window.ViewSandtable.computed.SandLevels = () => D.levels;
})();
