/* ============================================================
   views/station.js —— 全国气象站点实况
   2528 个台站的要素空间分布 + 极值排行 + 单站 7 日预报

   交互：
   - 省份下拉：切到省级地图（地市级边界）+ 数据/排行/构成全部联动
   - 天气下拉：按天气现象筛选，全链路联动
   - 极值排行：最高/最低切换，点击条形打开站点详情
   - 右侧图表：标题栏 ⛶ 按钮全屏放大
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
    props: { meta: Object, ctx: Object, route: Object },
    mixins: [ChartHost],
    data() {
      return {
        metric: 'temp',
        provinceCode: '',             // 选中省 adcode，'' = 全国
        filters: { province: '', info: '' },
        stations: [], rank: [], types: [], allInfo: [],
        detail: null, detailFc: [],
        detailFetchedAt: null,        // 预报数据最后一次抓取时刻（fetched_at）
        detailObsAge: null,           // 实况距上次采集的秒数
        detailRefreshing: false,      // 正在按需补采该站
        detailPeer: null,             // 同省站点数
        loading: false, tab: 'rank', mapName: '',
        rankOrder: 'desc',            // desc=最高榜 / asc=最低榜
        zoomTab: '',                  // 全屏放大的当前图表，''=未打开
        zoomPieSlice: null,           // 饼图弹窗点击扇区后：当前选中的天气现象名，null=显示饼图
        vmRange: null,                // visualMap 当前滑块范围 [min,max]，null=全范围
        focus: null                   // 地图上的定位焦点 {code,lng,lat,zoom,label,approx}
      };
    },
    computed: {
      M() { return METRICS[this.metric]; },
      provinces() { return (this.meta && this.meta.provinces) || []; },
      isProvince() { return !!this.provinceCode; },
      /* 实况新鲜度分级：≤2 分钟（绿）/ ≤10 分钟（黄）/ 更久（红） */
      freshLevel() {
        const a = this.detailObsAge;
        if (a === null || a === undefined) return 'stale';
        if (a <= 120) return 'ok';
        if (a <= 600) return 'mid';
        return 'stale';
      },
      range() {
        const v = this.stations.map(s => s.value).filter(x => x !== null && x !== undefined);
        return v.length ? [Math.min(...v), Math.max(...v)] : [0, 1];
      },
      /* 气温 - 湿度 关系散点（stations 已随筛选联动） */
      relation() {
        return this.stations
          .filter(s => s.temp !== null && s.temp !== undefined && s.humidity !== null && s.humidity !== undefined)
          .map(s => ({
            value: [s.temp, s.humidity],
            name: s.city, province: s.province, info: s.info
          }));
      },
      scopeText() {
        return (this.filters.province ? U.shortName(this.filters.province) : '全国') +
               (this.filters.info ? ' · ' + this.filters.info : '');
      },
      zoomTitle() {
        if (this.zoomTab === 'rank')
          return this.M.name + (this.rankOrder === 'desc' ? '最高' : '最低') + ' TOP10 · ' + this.scopeText;
        if (this.zoomTab === 'relation') return '气温—湿度关系散点 · ' + this.scopeText;
        if (this.zoomTab === 'types') return '天气现象构成 · ' + this.scopeText;
        return '';
      },
      focusMark() {
        const f = this.focus;
        return (f && f.lng !== null && f.lng !== undefined)
          ? [T.focusItem(f.lng, f.lat, f.label)] : [];
      }
    },
    async created() {
      await this.load();
      await this.applyRoute(this.route || {});
    },
    mounted() {
      /* Esc：先关放大弹窗，再退掉地图焦点 */
      this._onKey = e => {
        if (e.key !== 'Escape') return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
        if (this.zoomTab) { this.closeZoom(); return; }
        if (this.focus) this.clearFocus();
      };
      window.addEventListener('keydown', this._onKey);
    },
    watch: {
      /* 外部（搜索 / 预警地图）深链进来时路由会变，但组件不会重挂 */
      route(nv) { if (nv && nv._seq) this.applyRoute(nv); }
    },
    beforeUnmount() {
      window.removeEventListener('keydown', this._onKey);
      /* 弹窗开着时切路由会直接销毁组件：滚动锁与退出动画句柄都要清掉 */
      this._zmAnims(null);
      this._zmClosing = false;
      document.body.style.overflow = '';
    },
    methods: {
      filterParams() {
        return {
          province: this.filters.province || undefined,
          info: this.filters.info || undefined
        };
      },
      async load() {
        this.loading = true;
        this.vmRange = null;    /* 筛选/换要素后滑块范围回到全范围 */
        try {
          const fp = this.filterParams();
          const [st, rk, ty] = await Promise.all([
            API.stations(Object.assign({ metric: this.metric, valid_only: 1 }, fp)),
            API.stationRank(Object.assign({ metric: this.metric, order: this.rankOrder, limit: 12 }, fp)),
            API.weatherTypes(this.filters.province ? { province: this.filters.province } : {})
          ]);
          this.stations = st.stations || [];
          this.rank = rk.data || [];
          this.allInfo = ty.data || [];
          this.types = this.allInfo.filter(t => t.count > 2).slice(0, 10);
          await this.loadMap();
          this.render();
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      /* 按当前选中省加载地图：省 adcode -> 省级地市级边界；'' -> 全国。
         ECharts 5.5.1 同一实例换 geo.map 后 visualMap 着色永久失效，必须重建实例 */
      async loadMap() {
        const code = this.provinceCode || '100000';
        let name;
        try {
          name = await MapHub.use(code);
        } catch (e) {
          name = await MapHub.use('100000');
        }
        if (this.mapName && this.mapName !== name) this.recreateChart('map');
        this.mapName = name;
      },
      /* 实时推送：重取数据，保留当前要素、省份/现象筛选、层级与已打开的站点详情 */
      async onLive() {
        const code = this.detail ? this.detail.code : null;
        const fp = this.filterParams();
        const [st, rk, ty] = await Promise.all([
          API.stations(Object.assign({ metric: this.metric, valid_only: 1 }, fp)),
          API.stationRank(Object.assign({ metric: this.metric, order: this.rankOrder, limit: 12 }, fp)),
          API.weatherTypes(this.filters.province ? { province: this.filters.province } : {})
        ]);
        this.stations = st.stations || [];
        this.rank = rk.data || [];
        this.allInfo = ty.data || [];
        this.types = this.allInfo.filter(t => t.count > 2).slice(0, 10);
        if (code) {
          try {
            const r = await API.stationDetail(code);
            this.applyDetail(r);
          } catch (e) { /* 站点被移除时忽略 */ }
        }
        this.render();
        if (this.zoomTab) this.renderZoom();
      },
      render() { this.renderMap(); this.renderRank(); this.renderTypes(); this.renderRelation(); },
      renderMap() {
        if (!this.mapName) return;
        /* 重建（实时刷新）要保住用户自己滚/缩出来的视野，不然推送一来就弹回 */
        const keepView = this.geoNow('map');
        const m = this.M;
        /* 先按 vmRange 过滤散点——ECharts geo scatter 的 outOfRange 不生效，
           只能手动过滤。vmRange 为 null 表示全范围 */
        const filtered = this.vmRange
          ? this.stations.filter(s => s.value !== null && s.value !== undefined
              && s.value >= this.vmRange[0] && s.value <= this.vmRange[1])
          : this.stations;
        const data = filtered.filter(s => s.lng && s.value !== null && s.value !== undefined)
          .map(s => ({
            name: s.city, value: [s.lng, s.lat, s.value],
            province: s.province, info: s.info, temp: s.temp, humidity: s.humidity, code: s.code
          }));
        this.setChart('map', T.mapOption(this.mapName, {
          geo: this.isProvince
            ? { zoom: 1.05, layoutCenter: ['50%', '50%'], layoutSize: '98%' }
            : { zoom: 1.18, layoutCenter: ['50%', '54%'], layoutSize: '94%' },
          focus: this.focusMark,
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
                /* 描边是"点"的轮廓辅助，不改任何数值语义色。
                   降水这类指标的色带深端（0mm ≈ 近黑蓝）压在深蓝面上
                   本来几乎看不见，靠这圈浅描边才认得出点的存在 */
                borderColor: 'rgba(255,255,255,.6)', borderWidth: .7
              },
              emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1.4 } }
            }
          ],
          visualMap: T.valueVisualMap(this.range[0], this.range[1], m.colors,
            { text: [`${U.num(this.range[1], 0)}${m.unit}`, `${U.num(this.range[0], 0)}${m.unit}`] })
        }));

        /* 圆点缩放档位基准 = 当前层级的初始 zoom（renderMap 后归位） */
        this._baseZoom = this.isProvince ? 1.05 : 1.18;
        this._dotK = undefined;

        /* 重建后把视野拉回原处（每次实时刷新都会 notMerge 重建 option，不补一刀就飞了），
           并同步一次圆点尺寸档位 —— 恢复后的 zoom 可能不是初始值 */
        if (keepView && keepView.center) {
          this.geoApply('map', keepView.center, keepView.zoom);
          this.syncDotScale();
        } else if (this.focus) {
          this.geoSet('map', this.focus.lng, this.focus.lat, this.focus.zoom);
        }

        this.onChart('map', 'click', async p => {
          if (!p.data || !p.data.code) return;
          await this.openStation(p.data.code);
        });

        /* visualMap 滑块拖动 -> 手动过滤散点（geo scatter 的 outOfRange ECharts 忽略） */
        this.onChart('map', 'dataRange', params => {
          const sel = params && params.visualMap && params.visualMap.selected;
          if (!sel || !sel[0]) return;
          const r = sel[0];
          this.vmRange = [r.start, r.end];
          /* 只 setOption 更新 series.data，不重建实例——setChart 默认 notMerge=true，
             ECharts 会自动增量更新 */
          const filtered = this.vmRange
            ? this.stations.filter(s => s.value !== null && s.value !== undefined
                && s.value >= this.vmRange[0] && s.value <= this.vmRange[1])
            : this.stations;
          const newData = filtered.filter(s => s.lng && s.value !== null && s.value !== undefined)
            .map(s => ({
              name: s.city, value: [s.lng, s.lat, s.value],
              province: s.province, info: s.info, temp: s.temp, humidity: s.humidity, code: s.code
            }));
          const c = this.chart('map');
          if (c) c.setOption({ series: [{ data: newData }] });
        });

        /* 缩放地图时圆点尺寸温和放大（防抖 190ms）。
           绝不能走 setOption 改 symbolSize —— 会重建 2500 个图元（50~880ms）；
           直接改图元 scale，实测约 1ms。
           注意用 afterGeoRoam 钩子而不是自己 onChart('georoam')：
           那个事件已被 charts.js 的 setChart 占用（负责重投影地图面），
           重复绑定会把提交顶掉。飞行结束走 afterGeoFly。 */
      },
      afterGeoRoam() { this._dotScaleSoon(); },
      afterGeoFly() { this._dotScaleSoon(); },
      _dotScaleSoon() {
        if (!this._dotScaleT) this._dotScaleT = U.debounce(() => this.syncDotScale(), 190);
        this._dotScaleT();
      },
      /* 依据当前 geo 缩放算圆点档位；k 相对当前层级初始 zoom，幂次 .55 放缓，封顶 3.2 */
      syncDotScale() {
        const c = this.chart('map');
        if (!c || c.isDisposed()) return;
        /* 从坐标系读真实 zoom：option 在漫游当下还是旧值 */
        const v = this.geoNow('map');
        const zoom = (v && v.zoom) || 1;
        const base = this._baseZoom || 1.18;
        const k = Math.max(.7, Math.min(3.2, Math.pow(zoom / base, .55)));
        if (this._dotK !== undefined && Math.abs(k - this._dotK) < .06) return;
        this._dotK = k;
        this.scaleDots();
      },
      /* 把散点图元的 scale 直接设为 symbolSize/2 * k（图元本体是半径 1 的圆） */
      scaleDots() {
        const c = this.chart('map');
        if (!c || c.isDisposed()) return;
        const k = this._dotK === undefined ? 1 : this._dotK;
        try {
          const view = c.getViewOfSeriesModel(c.getModel().getSeriesByIndex(0));
          const target = 6.5 * k / 2;
          const walk = el => {
            if (!el) return;
            if (typeof el.children === 'function') { el.children().forEach(walk); return; }
            if (el.shape && el.shape.symbolType) { el.scaleX = target; el.scaleY = target; el.dirty(); }
          };
          if (view && view.group) walk(view.group);
        } catch (e) { /* ignore */ }
      },
      /* ---------------- 右侧三图（option 构造抽出，供全屏弹窗复用） ---------------- */
      rankOption(big) {
        const d = this.rank.slice(0, 10).reverse();
        return T.bar(
          d.map(x => U.shortName(x.city) || x.city),
          /* 带 code：条形点击直接打开站点详情 */
          d.map(x => ({ value: x.value, code: x.code })),
          {
            horizontal: true, unit: this.M.unit, barWidth: big ? 18 : 13,
            color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                     colorStops: [{ offset: 0, color: '#1d6f9f' }, { offset: 1, color: '#ff8a00' }] },
            grid: big ? { left: 10, right: 76, top: 14, bottom: 10, containLabel: true }
                     : { left: 6, right: 58, top: 6, bottom: 6, containLabel: true }
          });
      },
      renderRank() {
        this.setChart('rank', this.rankOption(false));
        this.onChart('rank', 'click', p => {
          if (p.data && p.data.code) this.openStation(p.data.code);
        });
      },
      typesOption() {
        return T.pie(
          this.types.map(t => ({ name: t.name, value: t.count })),
          { legend: true, center: ['50%', '44%'], radius: ['40%', '64%'], unit: '站', label: false });
      },
      renderTypes() { this.setChart('types', this.typesOption()); },
      relationOption(big) {
        return T.scatter(this.relation, {
          xName: '气温 ℃', yName: '相对湿度 %',
          symbolSize: big ? 7 : 4.5,
          /* 2500 点 overplotting：低透明度让密度可见，放大弹窗里再放大尺寸 */
          color: big ? 'rgba(63,198,255,.55)' : 'rgba(63,198,255,.38)',
          grid: big ? { left: 70, right: 36, top: 46, bottom: 56, containLabel: true }
                   : { left: 52, right: 20, top: 40, bottom: 40, containLabel: true },
          formatter: p => `<b>${p.data.name}</b><br/>气温 ${U.num(p.data.value[0], 1)}℃` +
                          `<br/>湿度 ${U.num(p.data.value[1], 0)}%`
        });
      },
      renderRelation() { this.setChart('relation', this.relationOption(false)); },
      /* ---------------- 全屏放大弹窗 ---------------- */
      /* 与总览放大层用同一套动效原语（motion.js）：从 ⛶ 所在面板长出来、
         关回去时缩回那个面板 —— 两处交互观感一致 */
      openZoom(tab, ev) {
        this._zmClosing = false;
        this._zmAnims(null);                        // 掐掉还没收尾的退出动画
        this._zmFrom = Motion.source(ev, '.panel');
        document.body.style.overflow = 'hidden';    // 弹窗期间锁背景滚动
        this.zoomTab = tab;
        this.zoomPieSlice = null;    /* 新开弹窗总是从原始图表开始 */
        this.$nextTick(() => {
          this.renderZoom();
          const box = this.$el && this.$el.querySelector('.chart-modal-box');
          if (box && !Motion.reduce()) {
            this._zmAnims([Motion.play(box, Motion.inFrames(box, this._zmFrom),
                                       Motion.IN_DUR, Motion.EASE_IN)]);
          }
        });
      },
      closeZoom() {
        if (!this.zoomTab || this._zmClosing) return;
        const t = this.zoomTab;
        this._zmClosing = true;
        const mask = this.$el && this.$el.querySelector('.chart-modal');
        const box = mask && mask.querySelector('.chart-modal-box');
        const finish = () => {
          if (!this._zmClosing) return;             // 已被 openZoom 接管
          this._zmClosing = false;
          this._zmAnims(null, true);                // 只丢引用，别 cancel（防闪回一帧）
          document.body.style.overflow = '';
          this.zoomTab = '';
          this.zoomPieSlice = null;    /* 关闭时清掉饼图切片状态 */
          if (t) this.recreateChart('zoomChart');
        };
        if (!box || Motion.reduce()) { finish(); return; }
        const anims = [
          Motion.play(mask, Motion.fadeFrames(false), Motion.OUT_DUR, 'linear', 'forwards'),
          Motion.play(box, Motion.outFrames(box, this._zmFrom), Motion.OUT_DUR, Motion.EASE_OUT, 'forwards')
        ];
        this._zmAnims(anims);
        Motion.whenDone(anims, finish);
        this._zmT = setTimeout(finish, 900);        // 后台节流兜底
      },
      /* 动画句柄管理：dropDone=true 时保留已结束的 fill:forwards 动画（等 DOM 卸载） */
      _zmAnims(list, dropDone) {
        if (this._zmList) this._zmList.forEach(a => {
          if (!a) return;
          try {
            if (dropDone && a.playState === 'finished') return;
            a.cancel();
          } catch (e) {}
        });
        this._zmList = (list || []).filter(Boolean);
        if (!list || !this._zmList.length) clearTimeout(this._zmT);
      },
      renderZoom() {
        if (!this.zoomTab) return;
        if (this.zoomTab === 'rank') {
          this.setChart('zoomChart', this.rankOption(true));
          this.onChart('zoomChart', 'click', p => {
            if (p.data && p.data.code) { this.closeZoom(); this.openStation(p.data.code); }
          });
        } else if (this.zoomTab === 'relation') {
          this.setChart('zoomChart', this.relationOption(true));
        } else {
          /* 天气现象饼图弹窗：默认显示饼图；点击扇区切条形图；条形图项可点打开站点。
             跨 chart-type（pie↔bar）重建实例防止残留 */
          if (this.zoomPieSlice) {
            const sl = this.stations
              .filter(s => s.info === this.zoomPieSlice && s.value !== null && s.value !== undefined)
              .sort((a, b) => (b.value || 0) - (a.value || 0))
              .slice(0, 25);
            this.recreateChart('zoomChart');
            this.setChart('zoomChart', T.bar(
              sl.map(x => U.shortName(x.city) || x.city),
              sl.map(x => ({ value: x.value, code: x.code })),
              {
                horizontal: true, unit: this.M.unit, barWidth: 16,
                color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                         colorStops: [{ offset: 0, color: '#1c6a9e' }, { offset: 1, color: '#7cf6d8' }] },
                grid: { left: 10, right: 76, top: 18, bottom: 10, containLabel: true }
              }));
            this.onChart('zoomChart', 'click', p => {
              if (p.data && p.data.code) { this.closeZoom(); this.openStation(p.data.code); }
            });
          } else {
            this.recreateChart('zoomChart');
            this.setChart('zoomChart', this.typesOption());
            this.onChart('zoomChart', 'click', p => {
              if (p.name) {
                this.zoomPieSlice = p.name;
                this.$nextTick(() => this.renderZoom());
              }
            });
          }
        }
        this.$nextResize(['zoomChart']);
      },
      zoomBackToPie() { this.zoomPieSlice = null; this.$nextTick(() => this.renderZoom()); },

      /* ---------------- 地图定位 / URL 状态 ---------------- */
      /* 站点级定位：把地图飞到该站，打上扩散光圈 + 站名标签。
         注意 289 个站（11.4%）的坐标是"省中心兜底"（geo_source='province_fallback'），
         飞过去实际落在省会 —— 必须显式标注，否则用户会以为站点标错了 */
      focusStation(s) {
        if (!s || s.lng === null || s.lng === undefined) return;
        const approx = (s.geo_source === 'province_fallback');
        this.focus = {
          code: s.code, lng: s.lng, lat: s.lat, approx,
          zoom: approx ? 4.6 : T.focusZoom('district'),
          label: (U.shortName(s.city) || s.city) + (approx ? ' · 坐标近似' : '')
        };
        this.mapOverlay('map', { focus: this.focusMark });
        this.geoFly('map', this.focus.lng, this.focus.lat, this.focus.zoom);
      },
      clearFocus() {
        this.focus = null;
        this.mapOverlay('map', { focus: [] });
        this.geoFly('map', null, null, null);
      },
      /* 关掉站点详情：收起详情页与地图焦点，并把 code 从 URL 里去掉 */
      closeDetail() {
        this.detail = null;
        this.detailFc = [];
        this.clearFocus();
        this.setTab('rank');
        this.syncUrl();
      },
      /* 把要素 / 省份 / 当前站点写回地址栏（replaceState 不触发 hashchange，不会回环） */
      syncUrl() {
        const p = {};
        if (this.metric !== 'temp') p.metric = this.metric;
        if (this.provinceCode) p.prov = String(this.provinceCode);
        if (this.detail) p.code = this.detail.code;
        const qs = Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&');
        const hash = '#/station' + (qs ? '?' + qs : '');
        if (location.hash !== hash) {
          try { history.replaceState(null, '', hash); } catch (e) { location.hash = hash; }
        }
      },
      /* 外部（搜索 / 预警地图 / 问答）带 ?metric=&prov=&code= 深链进来 */
      async applyRoute(rt) {
        rt = rt || {};
        const wantMetric = (rt.metric && METRICS[rt.metric]) ? rt.metric : this.metric;
        const wantProv = (rt.prov === undefined || rt.prov === null) ? '' : String(rt.prov);
        const changed = (wantMetric !== this.metric) ||
                        (wantProv !== String(this.provinceCode));
        if (changed) {
          this.metric = wantMetric;
          this.provinceCode = wantProv;
          const p = this.provinces.find(x => String(x.adcode) === wantProv);
          this.filters.province = p ? p.name : '';
          await this.load();
        }
        if (rt.code) {
          await this.openStation(rt.code);
        } else {
          if (this.detail) { this.detail = null; this.detailFc = []; this.tab = 'rank'; }
          this.clearFocus();
          this.syncUrl();
        }
      },
      /* 跨页联动：当前站点 -> 该省（或该市）的预警地图，直接下钻过去 */
      gotoAlarmMap() {
        const d = this.detail;
        if (!d) return;
        const p = this.provinces.find(x => x.name === d.province);
        this.$emit('pick', {
          view: 'alarm',
          params: p ? { adcode: String(p.adcode), name: p.name } : { q: d.city }
        });
      },
      /* 统一承接详情响应：实况 + 预报窗口 + 新鲜度元信息 */
      applyDetail(r) {
        this.detail = Object.assign({}, r.station, { peer_count: r.peer_count });
        this.$emit('context', { station_code: r.station.code, station_name: r.station.city,
          station_province: r.station.province });
        this.detailFc = r.forecast || [];
        this.detailFetchedAt = r.forecast_fetched_at || null;
        this.detailObsAge = (typeof r.obs_age === 'number') ? r.obs_age : null;
        this.detailPeer = r.peer_count;
      },
      async openStation(code) {
        const r = await API.stationDetail(code);
        this.applyDetail(r);
        this.setTab('detail');
        /* 在地图上把这一站标出来（"点了一个东西要看得见"） */
        this.focusStation(r.station);
        if (r.station && r.station.geo_source === 'province_fallback') {
          this.flash('该站在源数据里没有经纬度，已定位到所在省的中心', 'info');
        }
        this.syncUrl();
        /* 先渲染缓存（秒开），再后台按需补采这一站 —— 轮转约 7 分钟才覆盖全国
           一遍，点开的站很可能刚好是最旧的一批，这一步让"当前时间的天气"不用等 */
        this.refreshDetail(code);
      },
      /* 按需补采单站：后端对 max_age(默认 300s) 内的数据会直接跳过，不重复打接口 */
      async refreshDetail(code) {
        if (this.detailRefreshing) return;
        this.detailRefreshing = true;
        try {
          const res = await API.stationRefresh(code);
          if (res && res.refreshed) {
            const d = await API.stationDetail(code);
            if (this.detail && this.detail.code === code) {
              this.applyDetail(d);
              this.flash('⚡ 已实时补采该站最新实况', 'info');
              this.$nextTick(() => setTimeout(() => this.resizeCharts(), 30));
            }
          } else if (res && typeof res.age === 'number') {
            this.detailObsAge = res.age;
          }
        } catch (e) {
          /* 引擎未启用或断网：静默降级，继续用已有数据 */
        } finally {
          this.detailRefreshing = false;
        }
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
        this.syncUrl();
      },
      /* 省份下拉：adcode -> 省名，切省级地图；外省详情自动关闭 */
      async applyProvince(adcode) {
        adcode = adcode || '';
        if (String(this.provinceCode) === String(adcode)) return;
        this.provinceCode = adcode;
        const p = this.provinces.find(x => String(x.adcode) === String(adcode));
        this.filters.province = p ? p.name : '';
        if (this.detail && this.filters.province && this.detail.province !== this.filters.province) {
          this.detail = null;
          this.detailFc = [];
          this.clearFocus();
          if (this.tab === 'detail') this.tab = 'rank';
        }
        await this.load();
        this.syncUrl();
      },
      async applyInfo(info) {
        info = info || '';
        if (this.filters.info === info) return;
        this.filters.info = info;
        await this.load();
      },
      /* 最高/最低榜切换：只刷排行，不重载地图 */
      async setOrder(o) {
        if (this.rankOrder === o) return;
        this.rankOrder = o;
        const rk = await API.stationRank(
          Object.assign({ metric: this.metric, order: this.rankOrder, limit: 12 }, this.filterParams()));
        this.rank = rk.data || [];
        this.renderRank();
        if (this.zoomTab === 'rank') this.renderZoom();
      },
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
          <select :value="provinceCode" @change="applyProvince($event.target.value)">
            <option value="">全国</option>
            <option v-for="p in provinces" :key="p.adcode" :value="p.adcode">{{ shortName(p.name) }}</option>
          </select>
        </div>
        <div class="field"><label>天气</label>
          <select :value="filters.info" @change="applyInfo($event.target.value)">
            <option value="">全部现象</option>
            <option v-for="t in allInfo" :key="t.name" :value="t.name">{{ t.name }}（{{ t.count }}）</option>
          </select>
        </div>
        <span style="margin-left:auto;font-size:12px;color:#6f89a6">
          {{ scopeText }} · 显示 <b style="color:#3fc6ff">{{ stations.length }}</b> 个站点 ·
          {{ M.name }}区间 {{ U.num(range[0],1) }} ~ {{ U.num(range[1],1) }} {{ M.unit }}
        </span>
      </div>

      <div class="grid" style="grid-template-columns:minmax(0,1fr) 400px;flex:1;min-height:0">
        <div class="panel">
          <div class="panel-head"><h3>站点 {{ M.name }}空间分布</h3>
            <span class="sub">{{ isProvince ? '省级视图 · 点击站点查看详情' : '圆点颜色 = ' + M.name + '（' + M.unit + '）　点击站点查看详情' }}</span>
          </div>
          <div class="panel-body map-wrap" style="padding:0">
            <div class="map-tools" v-if="focus">
              <span class="view-tag">⊙ 已定位：{{ focus.label }}</span>
              <button class="btn ghost reset-view" @click="clearFocus"
                      title="回到默认视野（Esc）">复位视野</button>
            </div>
            <div class="chart" ref="map" data-chart="map"></div>
            <div v-if="loading" class="panel-loading"><div class="boot-ring"></div></div>
          </div>
        </div>

        <div class="col-stack">
          <div class="panel" style="flex:1.15;min-height:0">
            <div class="panel-head">
              <h3>{{ tab==='rank' ? M.name+(rankOrder==='desc'?'最高':'最低')+' TOP10' : tab==='relation' ? '气温—湿度关系' : tab==='types' ? '天气现象构成' : '站点详情' }}</h3>
              <template v-if="tab!=='detail'">
                <span class="chip mini" v-if="tab==='rank'" :class="{on: rankOrder==='desc'}" @click="setOrder('desc')">最高</span>
                <span class="chip mini" v-if="tab==='rank'" :class="{on: rankOrder==='asc'}" @click="setOrder('asc')">最低</span>
                <span class="zoom-btn" @click="openZoom(tab, $event)" title="全屏放大">⛶</span>
              </template>
              <span class="sub" v-else style="cursor:pointer" @click="closeDetail">返回排行 ›</span>
            </div>
            <div class="panel-body" style="padding:6px">
              <div class="chart" ref="rank"  data-chart="rank" v-show="tab==='rank'"></div>
              <div class="chart" ref="relation" data-chart="relation" v-show="tab==='relation'"></div>
              <div class="chart" ref="types" data-chart="types" v-show="tab==='types'"></div>
              <div v-if="!rank.length && tab==='rank'" class="empty">该筛选条件下暂无站点数据</div>
              <div v-if="loading" class="panel-loading"><div class="boot-ring"></div></div>

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
                <!-- 实况新鲜度：把"这份数据是什么时候的"直接写在脸上 -->
                <div class="sd-fresh">
                  <span class="dot" :class="freshLevel"></span>
                  <span v-if="detailObsAge === null">实况时间未知</span>
                  <span v-else>实况 {{ U.ago(detail.updated_at) }}更新</span>
                  <span v-if="detailRefreshing" class="sd-pill busy">正在补采…</span>
                  <span v-else-if="detailObsAge !== null && detailObsAge > 600" class="sd-pill warn"
                        @click="refreshDetail(detail.code)">点此补采</span>
                  <span v-else-if="detailObsAge !== null && detailObsAge <= 120" class="sd-pill ok">实时</span>
                </div>
                <div style="font-size:11.5px;color:#6f89a6;margin-top:6px">
                  观测发布时间 {{ detail.publish_time || '—' }} · 同省站点 {{ detailPeer || '—' }} 个
                  <template v-if="detail.updates">
                    · 累计刷新 <b style="color:#7cf6d8">{{ detail.updates }}</b> 次
                  </template>
                </div>
                <!-- 预报：只渲染今天及以后（后端已按日期窗口过滤），并标明这批预报的抓取时刻 -->
                <div class="fc-head">
                  <span>未来 {{ detailFc.length }} 日预报</span>
                  <span class="fc-src" v-if="detailFetchedAt">
                    数据更新于 {{ U.ago(detailFetchedAt) }}
                  </span>
                  <span class="fc-src" v-else-if="detailFc.length">数据抓取时刻待下一次采集</span>
                </div>
                <div class="fc-row" v-if="detailFc.length">
                  <div class="fc-day" v-for="(f, i) in detailFc" :key="f.date" :class="{ today: i === 0 }">
                    <div class="d">{{ i === 0 ? '今天' : f.date.slice(5) }}</div>
                    <div class="i">{{ wIcon(f.day_info) }} {{ f.day_info }}</div>
                    <div class="t">{{ f.day_temp }}°<i> / {{ f.night_temp }}°</i></div>
                    <div class="d" style="margin-top:3px">{{ f.day_power }}</div>
                  </div>
                </div>
                <div v-else class="fc-empty">该站暂无有效预报，等待下一次实时采集</div>
                <!-- 跨页联动：把"这一站的实况"跟"这一省的预警"接起来看 -->
                <div class="linkrow" style="margin-top:11px">
                  <button class="btn ghost" @click="gotoAlarmMap()"
                          title="带着该省编码跳到预警地图，自动下钻">该省预警地图 ›</button>
                  <button class="btn ghost" @click="clearFocus()" v-if="focus">复位视野</button>
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

      <!-- 全屏放大弹窗：Esc 或点击遮罩关闭 -->
      <transition name="modal-fade">
        <div v-if="zoomTab" class="chart-modal" @click.self="closeZoom">
          <div class="chart-modal-box">
            <div class="chart-modal-head">
              <h3>{{ zoomPieSlice ? (zoomPieSlice + ' · ' + M.name + '分布 TOP25') : zoomTitle }}</h3>
              <span v-if="zoomTab==='types' && zoomPieSlice" class="zoom-back" @click="zoomBackToPie" title="返回天气构成饼图">‹ 返回占比图</span>
              <span class="zoom-close" @click="closeZoom" title="关闭（Esc）">✕</span>
            </div>
            <div class="chart-modal-body">
              <div class="chart" ref="zoomChart"></div>
            </div>
          </div>
        </div>
      </transition>
    </div>`
  };
})();
