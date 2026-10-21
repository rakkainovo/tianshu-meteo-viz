/* ============================================================
   views/alarm.js —— 预警地图（省 / 市 / 区县 三级下钻）
   交互主线：地图取色看全局 -> 点击下钻看局部 -> 列表与地图**双向**联动

   2026-09-24 增强（"点了一个东西要看得见"）：
   1. 点清单 / 点地图圆点 -> 地图平滑飞行定位到落区 + 扩散光圈 + 名称标签
   2. 详情里带"现场对照"：离落区最近的气象站实况 + 该站未来几日预报
      （预警说"将会怎样"，实况说"现在如何"，两者并排才能看出提前量）
   3. 列表 hover ↔ 地图圆点 hover 双向联动；键盘 ↑↓ / Enter / Esc 可全程操作
   4. 视图状态写进 URL，可复制成链接分享；也能从外部（搜索、总览）
      带着 ?adcode= 或 ?focus= 直接跳进来定位
   ============================================================ */
(function () {
  'use strict';

  const LEVEL_NAME = { 4: '红色', 3: '橙色', 2: '黄色', 1: '蓝色', 0: '无预警' };
  const LIST_MAX = 200;          // 清单最多渲染多少条（键盘光标与 hover 联动都以此为准）

  window.ViewAlarm = {
    name: 'v-alarm',
    props: { meta: Object, ctx: Object, route: Object },
    mixins: [ChartHost],
    data() {
      return {
        /* 下钻栈：每层记录 {adcode, name, level} */
        stack: [{ adcode: '100000', name: '全国', level: 0 }],
        mapName: '', loading: false,
        /* active='1' = 当前生效口径（只显示最近一轮采集里仍在生效的预警）。
           上游 /rest/findAlarm 本身就是当前生效清单，见 server/app.py build_filters。
           置空 = 含已失效历史（近 15 天全量），仅用于对照与排查。 */
        filters: { type: '', level: '', province: '', q: '', active: '1', county: '', min_rank: '', since: '', until: '' },
        /* 生效口径那一轮采集的元信息 {scan_at, active_total, age_hours, stale}，
           由 /api/alarms（active=1）一并返回。用来在标题旁如实标出
           "本页这批点是哪一轮采的" —— 采集停摆时这里会转红提示。 */
        activeInfo: null,
        agg: [], records: [], total: 0,
        selected: null,
        /* 焦点：{id, lng, lat, zoom, label}；hoverId 只做轻量高亮 */
        focus: null, hotId: null, cursor: -1,
        ctxInfo: null, ctxLoading: false,
        tab: 'list',
        fav: []                                     // 收藏的预警 id（localStorage，跨页保留）
      };
    },
    computed: {
      cur() { return this.stack[this.stack.length - 1]; },
      canBack() { return this.stack.length > 1; },
      backTip() {
        return this.canBack ? `返回${U.shortName(this.stack[this.stack.length - 2].name)}` : '已在顶层';
      },
      types() { return (this.meta && this.meta.types) || []; },
      levels() { return (this.meta && this.meta.levels) || []; },
      /* 口径提示：标题旁如实说明"这批点取自哪一轮采集"。
         停摆时用相对时间（"5 天前"）——绝对时刻要靠心算，容易被忽略。 */
      alarmStale() { return !!(this.activeInfo && this.activeInfo.stale); },
      alarmNote() {
        if (!this.filters.active) return '';
        const a = this.activeInfo || {};
        if (!a.scan_at) return '';
        if (a.stale) return '预警采集已停摆 · 本页为 ' + U.ago(a.scan_at) + ' 的数据';
        return '当前生效 · ' + U.ago(a.scan_at) + '采集 · ' + U.num(a.active_total || 0) + ' 条';
      },
      /* 省级下拉：跟着时效口径走。生效口径要用 provinces_active ——
         它把"当前 0 条生效"的省也留着（且 count 是同口径的），否则会出现
         "下拉里写着北京（32）"而图上一条点都没有的矛盾。 */
      provinces() {
        const m = this.meta || {};
        if (this.filters.active && m.provinces_active && m.provinces_active.length) {
          return m.provinces_active;
        }
        return m.provinces || [];
      },
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
      },
      /* 收藏的预警置顶：一眼就能在 200 条里找到"我关心的" */
      listRows() {
        const fav = this.records.filter(r => this.fav.indexOf(r.id) >= 0);
        const rest = this.records.filter(r => this.fav.indexOf(r.id) < 0);
        return fav.concat(rest).slice(0, LIST_MAX);
      },
      focusMark() {
        const f = this.focus;
        return (f && f.lng !== null && f.lng !== undefined)
          ? [T.focusItem(f.lng, f.lat, f.label)] : [];
      },
      hotMark() {
        const r = this.records.find(x => x.id === this.hotId);
        return (r && r.lng) ? [{ name: r.title || '', value: [r.lng, r.lat] }] : [];
      },
      /* 当前层级的"家"视野 —— 焦点只叠加 center，复位时回到这里 */
      homeGeo() {
        return {
          zoom: this.cur.level === 0 ? 1.18 : 1.02,
          layoutCenter: ['50%', '52%'],
          layoutSize: this.cur.level === 0 ? '94%' : '92%'
        };
      },
      /* 已下钻到该预警所在市？用来决定"下钻到此地"按钮显不显示 */
      canDrillFocus() {
        const r = this.selected;
        if (!r || !r.adm_code) return false;
        const ad = String(r.adm_code).replace(/\D/g, '');
        const city = this.stack[2] && String(this.stack[2].adcode);
        return this.cur.level !== 2 || city !== (ad.slice(0, 4) + '00');
      }
    },
    async created() {
      this.fav = Fav.all();
      await this.applyRoute(this.route || {});
    },
    mounted() {
      /* 键盘：↑↓ 选、Enter 打开、Esc 清焦点 / 逐级回退、Alt+← 回退
         （输入框里不劫持；搜索面板开着时也不抢 Esc） */
      this._onKey = e => {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
        if (typing) return;
        if (this.$root && this.$root.searchOpen) return;

        if (e.key === 'Escape') {
          if (this.tab === 'detail') { this.tab = 'list'; return; }
          if (this.focus) { this.resetView(); return; }
          if (this.canBack) { e.preventDefault(); this.back(); }
          return;
        }
        if (e.altKey && e.key === 'ArrowLeft') {
          if (this.canBack) { e.preventDefault(); this.back(); }
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const n = this.listRows.length;
          if (!n) return;
          e.preventDefault();
          this.tab = 'list';
          const d = e.key === 'ArrowDown' ? 1 : -1;
          const c = this.cursor < 0 ? (d > 0 ? 0 : n - 1)
                                    : Math.max(0, Math.min(n - 1, this.cursor + d));
          this.cursor = c;
          this.setHot(this.listRows[c].id, false);
          this.scrollToActive();
          return;
        }
        if (e.key === 'Enter') {
          const r = this.listRows[this.cursor];
          if (r) { e.preventDefault(); this.pickRow(r); }
        }
      };
      window.addEventListener('keydown', this._onKey);
    },
    watch: {
      /* 外部（搜索 / 总览 / 问答）跳进来时路由会变，但组件不会重挂 */
      route(nv) { if (nv && nv._seq) this.applyRoute(nv); }
    },
    beforeUnmount() { window.removeEventListener('keydown', this._onKey); },
    methods: {
      query(extra) {
        return Object.assign({}, this.filters, this.scope, extra || {});
      },
      /* ---------------- 路由 / URL 状态 ---------------- */
      async applyRoute(rt) {
        rt = rt || {};
        ['type', 'level', 'q'].forEach(k => {
          if (rt[k] !== undefined && rt[k] !== this.filters[k]) this.filters[k] = rt[k];
        });
        ['county', 'min_rank', 'since', 'until'].forEach(k => { this.filters[k] = rt[k] || ''; });
        /* 时效口径：URL 里没有 hist = 当前生效（默认） */
        const wantHist = !!rt.hist;
        const histChanged = (wantHist ? '' : '1') !== this.filters.active;
        if (histChanged) this.filters.active = wantHist ? '' : '1';
        /* 只有 adcode 那条路会在 applyAdcode 内部自己重取；
           其余参数（type/level/q/hist）变了就必须在这里重取 ——
           原来写的是 `if (!touched) refresh()`，于是"touched"反而成了不重取的条件：
           从 URL 深链带 ?level=黄色 进来时，下拉框变了、数据还是全量（实测踩到） */
        let refetched = false;
        if (rt.adcode) {
          const ok = await this.applyAdcode(rt.adcode, { silent: true });
          if (!ok) await this.refresh();
          refetched = true;
        }
        if (!refetched) await this.refresh();
        if (rt.focus) await this.focusById(rt.focus, { adopt: true });
        else this.syncUrl();
      },
      /* 把当前筛选 / 下钻 / 选中项写回地址栏（replaceState 不触发 hashchange，
         所以不会造成"改 URL -> 重新载入 -> 再改 URL"的回环） */
      syncUrl() {
        const p = {};
        if (this.filters.type) p.type = this.filters.type;
        if (this.filters.level) p.level = this.filters.level;
        if (this.filters.q) p.q = this.filters.q;
        ['county', 'min_rank', 'since', 'until'].forEach(k => { if (this.filters[k]) p[k] = this.filters[k]; });
        if (!this.filters.active) p.hist = 1;      // 含已失效历史的口径也能深链分享
        if (this.stack.length > 1) p.adcode = this.cur.adcode;
        if (this.selected) p.focus = this.selected.id;
        const qs = Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&');
        const hash = '#/alarm' + (qs ? '?' + qs : '');
        if (location.hash !== hash) {
          try { history.replaceState(null, '', hash); } catch (e) { location.hash = hash; }
        }
      },
      copyLink() {
        const url = location.origin + location.pathname + location.search + location.hash;
        const done = () => this.flash('链接已复制，打开即是当前视图');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(() => this.legacyCopy(url, done));
        } else this.legacyCopy(url, done);
      },
      legacyCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); }
        catch (e) { this.flash('复制失败，请手动复制地址栏', 'warn'); }
        document.body.removeChild(ta);
      },

      /* ---------------- 取数 ---------------- */
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
          this.activeInfo = recs.active || this.activeInfo;
          /* 选中项只要还在结果里就留着（实时刷新不该把用户正在看的东西抖掉） */
          const keep = this.selected && this.records.find(r => r.id === this.selected.id);
          this.selected = keep || null;
          if (!keep) { this.focus = null; this.ctxInfo = null; }
          this.cursor = keep ? this.records.indexOf(keep) : -1;
          await this.loadMap();
          this.renderMap();
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      /* 实时推送：只重取数据，保留下钻层级、筛选条件与当前选中项 */
      async onLive() {
        const [agg, recs] = await Promise.all([
          API.alarmAgg(Object.assign({ dim: this.dim, top: 400 }, this.query())),
          API.alarms(Object.assign({ limit: 600 }, this.query()))
        ]);
        this.agg = agg.data || [];
        this.records = recs.records || [];
        this.total = recs.total;
        this.activeInfo = recs.active || this.activeInfo;
        if (this.selected) {
          this.selected = this.records.find(r => r.id === this.selected.id) || null;
          if (!this.selected) { this.focus = null; this.ctxInfo = null; this.cursor = -1; this._ctxSeq = (this._ctxSeq || 0) + 1; this.ctxLoading = false; }
        }
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
      /* ---------------- 渲染 ---------------- */
      renderMap() {
        if (!this.mapName) return;
        /* ECharts 5.5.1 缺陷规避：同一实例上更换 geo.map（下钻/回退）后，
           visualMap 对地图面的着色会永久失效（回退也不恢复）。
           地图名变化时必须销毁重建实例，见 charts.js recreateChart 注释 */
        if (this._renderedMap && this._renderedMap !== this.mapName) this.recreateChart('map');
        /* 在销毁之后读视野（顺序很重要）：
           换地图时实例已销毁 -> geoNow 返回 null -> 落到新层级的默认视野；
           同一张地图重建（实时刷新）-> 读回用户自己滚/缩出来的视野，
           不补这一刀的话每次推送都会把视野弹回默认位置 */
        const keepView = this.geoNow('map');
        this._renderedMap = this.mapName;
        const data = this.agg.filter(a => a.name).map(a => ({
          name: a.name, value: a.max_rank || 0, count: a.count
        }));
        /* 面的暗色只能走 geo 原生逐区样式：本页地图底面由 geo 组件绘制，
           map series 仅提供数据（data 里的 itemStyle 不参与面着色，
           实测无效），而 visualMap 又要留给图例用等级原色 ——
           所以用 geo.regions 逐区压暗，标点才不会被同色的面埋掉。
           详见 theme.js 里 lvFace / faceColor 的注释 */
        const faceRegions = this.agg.filter(a => a.name)
          .map(a => ({ name: a.name, itemStyle: { areaColor: T.faceColor(a.max_rank) } }));
        const isBottom = this.cur.level >= 2;
        /* 性能：把 effectScatter 拆成两段 —— 前 50 条最新预警保留 ripple 动画，
           其余走普通 scatter（不能用 large/progressive：ECharts 增量渲染层
           不响应 geo 漫游的 updateTransform，缩放后点会钉死在原处） */
        const freshN = 50;
        const allPoints = this.points;
        const fresh = allPoints.slice(0, freshN);
        const rest = allPoints.slice(freshN);
        const symSize = v => 5 + (v[2] || 0) * 1.2;
        const baseItem = {
          color: p => U.lvColor(p.data.level),
          borderColor: 'rgba(255,255,255,.5)', borderWidth: .5
        };
        this.setChart('map', T.mapOption(this.mapName, {
          geo: Object.assign({}, this.homeGeo, { regions: faceRegions }),
          /* 悬停高亮不走 ECharts（改成 DOM 覆盖层 .map-hoverdot，见 charts.js）：
             清单滚动时鼠标会连掠多行，每次联动都全量重绘必卡 */
          focus: this.focusMark, hover: [],
          tooltipOpt: {
            formatter: p => {
              if (p.seriesType === 'effectScatter' || p.seriesType === 'scatter') {
                const x = p.data;
                if (!x || !x.title) return '';
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
              type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 3,
              name: '预警点位', data: rest, symbolSize: symSize,
              itemStyle: Object.assign({ opacity: .78 }, baseItem)
            },
            {
              type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 4,
              name: '最新预警', data: fresh, symbolSize: symSize,
              rippleEffect: { brushType: 'stroke', scale: 2.8, period: 3 },
              /* 性能：涟漪层每帧重绘，shadowBlur 逐点开销过高，去掉 */
              itemStyle: Object.assign({
                borderColor: 'rgba(255,255,255,.8)', borderWidth: .6
              }, baseItem)
            }
          ],
          visualMap: T.levelVisualMap({ seriesIndex: [] })
        }));

        /* 重建后把视野拉回原处：不补这一刀的话，每次实时刷新都会把
           用户自己滚出来的视野整个弹回默认位置（"跳完之后地图就不听使唤了"） */
        if (keepView && keepView.center) this.geoApply('map', keepView.center, keepView.zoom);
        else if (this.focus) this.geoSet('map', this.focus.lng, this.focus.lat, this.focus.zoom);

        /* 点击：面 -> 下钻；点 -> 定位并看详情 */
        this.onChart('map', 'click', async p => {
          if (p.seriesType === 'scatter' || p.seriesType === 'effectScatter') {
            this.pickByPoint(p);
            return;
          }
          if (p.seriesType !== 'map' || !p.name || this.cur.level >= 2) return;
          const item = this.agg.find(a => a.name === p.name);
          if (!item || !item.adcode) { this.flash('该区域暂无更细的下级数据'); return; }
          this.stack.push({ adcode: String(item.adcode), name: p.name, level: this.cur.level + 1 });
          this.clearPick();
          await this.refresh();
          this.syncUrl();
        });

        /* 地图 -> 清单：划过圆点，右侧清单自动滚到并高亮对应条目 */
        this.onChart('map', 'mouseover', p => {
          if (p.seriesType !== 'scatter' && p.seriesType !== 'effectScatter') return;
          const id = p.data && p.data.id;
          if (!id || id === this.hotId) return;
          this.setHot(id, false);
          this.scrollToActive();
        });
        this.onChart('map', 'mouseout', () => {
          if (this.cursor < 0) this.setHot(null, false);
        });
        /* 漫游/缩放后的收尾（重投影地图面 + 悬停圈归位）统一在 charts.js 的
           setChart 里挂，页面不要再自己 onChart('georoam') —— 会把那个顶掉 */
      },
      /* 悬停圆环的像素位置（DOM 覆盖层定位用） */
      hoverPx() {
        const r = this.records.find(x => x.id === this.hotId);
        if (!r || r.lng === null || r.lng === undefined) return null;
        return this.geoPointToPx('map', r.lng, r.lat);
      },
      /* 焦点 / 悬浮标记：只改叠加层的 1~2 个点，不整套重建。
         悬浮那一半走 pushMapHot（带滚动冷却 + 合并），否则鼠标扫过清单
         会连发 ECharts 全量重绘，滚动就卡 */
      setHot(id, fromList) {
        this.hotId = id;
        if (fromList && id) {
          const i = this.listRows.findIndex(r => r.id === id);
          if (i >= 0) this.cursor = i;
        }
        this.pushMapHot();
      },
      hoverRow(r) { this.setHot(r.id, true); },
      leaveRow() { if (this.cursor < 0) this.setHot(null, false); },
      /* 关注 / 收藏：置顶 + 高亮，点列表或详情里的 ☆ 都能切换 */
      toggleFav(r) {
        if (!r || !r.id) return;
        this.fav = Fav.toggle(r.id);
        this.flash(Fav.has(r.id) ? '已关注，将在列表置顶' : '已取消关注', Fav.has(r.id) ? 'ok' : 'info');
      },
      scrollToActive() {
        this.$nextTick(() => {
          const el = this.$el.querySelector('.alist-item.hot, .alist-item.sel');
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
        });
      },
      /* 把视野飞到某条预警（不动层级）。列表点击 / 地图点击 / URL 定位都走这里 */
      focusOn(r) {
        if (!r) return;
        if (r.lng === null || r.lng === undefined || r.lat === null || r.lat === undefined) {
          this.flash('该预警没有落区坐标，无法在地图上定位', 'warn');
          return;
        }
        const zoom = T.focusZoom(r.geo_level);
        const place = U.shortName(r.county) || U.shortName(r.city) || U.shortName(r.province) || '';
        this.focus = { id: r.id, lng: r.lng, lat: r.lat, zoom,
                       label: r.type + r.level + (place ? ' · ' + place : '') };
        this.mapOverlay('map', { focus: this.focusMark });
        this.geoFly('map', r.lng, r.lat, zoom);
      },
      clearPick() {
        this.selected = null;
        this.focus = null;
        this.hotId = null;
        this.cursor = -1;
        this.ctxInfo = null;
      },
      /* 回到当前层级的默认视野（不改变下钻层级） */
      resetView() {
        this.focus = null;
        this.mapOverlay('map', { focus: [] });
        this.geoFly('map', null, null, null);
      },
      /* ---------------- 选中一条预警 ---------------- */
      async pickRow(r) {
        if (!r) return;
        this.selected = r;
        this.tab = 'detail';
        this.hotId = null;
        const i = this.listRows.findIndex(x => x.id === r.id);
        this.cursor = i >= 0 ? i : -1;
        this.focusOn(r);
        this.loadContext(r);
        this.syncUrl();
      },
      pickByPoint(p) {
        if ((p.seriesType !== 'scatter' && p.seriesType !== 'effectScatter') || !p.data) return;
        const rec = this.records.find(r => r.id === p.data.id);
        if (rec) this.pickRow(rec);
      },
      /* 从外部（搜索 / 总览 / 问答）跳进来定位某条预警。
        必要先把视图切到它所在的市，否则它会落在当前地图范围之外。 */
      async focusById(id, opts) {
        opts = opts || {};
        let r = this.records.find(x => x.id === id);
        let ctx = null;
        if (!r) {
          try {
            ctx = await API.alarmContext(id);
            r = ctx.alarm;
          } catch (e) {
            this.flash('未找到这条预警，可能已超出数据窗口', 'warn');
            return;
          }
          const ad = String(r.adm_code || '').replace(/\D/g, '');
          if (opts.adopt && /^\d{6}$/.test(ad)) {
            await this.applyAdcode(ad, { silent: true });
            r = this.records.find(x => x.id === id) || r;
          }
        }
        this.selected = r;
        this.tab = 'detail';
        this.hotId = null;
        const i = this.records.findIndex(x => x.id === r.id);
        this.cursor = i >= 0 && i < LIST_MAX ? i : -1;
        this.ctxInfo = ctx;
        this.focusOn(r);
        if (!ctx) this.loadContext(r);
        this.syncUrl();
        this.flash('已定位到 ' + (r.type + r.level + '预警'));
      },
      /* 取"现场对照"：最近气象站实况 + 该站未来几日预报 */
      async loadContext(r) {
        if (!r || !r.id) return;
        /* (x || 0) + 1 而非 ++：私有字段首读是 undefined，自增得 NaN，
           而 NaN !== NaN 会让下面两个守卫永久为假（ctxLoading 卡死、ctxInfo 永远为空） */
        const token = (this._ctxSeq || 0) + 1;
        this._ctxSeq = token;
        this.ctxLoading = true;
        this.ctxInfo = null;
        try {
          const j = await API.alarmContext(r.id);
          if (token === this._ctxSeq) this.ctxInfo = j;
        } catch (e) {
          if (token === this._ctxSeq) this.ctxInfo = null;
        } finally {
          if (token === this._ctxSeq) this.ctxLoading = false;
        }
      },
      /* ---------------- 下钻 / 回退 ---------------- */
      /* 按 adcode 重建下钻栈：跨页跳转与"下钻到此地"共用 */
      async applyAdcode(adcode, opts) {
        const ad = String(adcode || '').replace(/\D/g, '');
        if (!/^\d{6}$/.test(ad)) return false;
        let chain = [];
        try {
          chain = ((await API.regionLookup(ad)).chain) || [];
        } catch (e) { /* 查不到就退回：至少还能按 adcode 聚焦 */ }
        const stack = [{ adcode: '100000', name: '全国', level: 0 }];
        chain.forEach(x => {
          if (x.level === 'province' || x.level === 'city') {
            stack.push({ adcode: String(x.adcode), name: x.name, level: stack.length });
          }
        });
        if (stack.length > 1) {
          this.stack = stack;
          this.filters.province = '';       // 下拉筛选与下钻栈不能同时生效
        }
        if (!(opts && opts.silent)) this.flash('已切换到 ' + this.stack[this.stack.length - 1].name);
        await this.refresh();
        this.syncUrl();
        return true;
      },
      /* 把地图切到这条预警所在的市（详情里的"下钻到此地"） */
      async drillToAlarmRegion() {
        const r = this.selected;
        if (!r || !r.adm_code) { this.flash('该预警没有行政区编码，无法下钻', 'warn'); return; }
        const keepId = r.id;
        await this.applyAdcode(String(r.adm_code), { silent: true });
        await this.focusById(keepId, { adopt: false });
        this.flash('已下钻到 ' + (U.shortName(r.county) || U.shortName(r.city) || '目标区域'));
      },
      async drillTo(i) {
        this.filters.county = '';
        this.stack = this.stack.slice(0, i + 1);
        this.clearPick();
        await this.refresh();
        this.syncUrl();
      },
      /* 逐级回退：出栈一层并重取该层数据 */
      async back() {
        this.filters.county = '';
        if (!this.canBack) return;
        this.stack = this.stack.slice(0, -1);
        this.clearPick();
        await this.refresh();
        this.syncUrl();
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
        this.clearPick();
        await this.refresh();
        this.syncUrl();
      },
      async reset() {
        /* 口径（filters.active）不跟着重置：它是"我们在说哪批数据"，不是筛选项 */
        this.filters = { type: '', level: '', province: '', q: '', county: '', min_rank: '', since: '', until: '',
                         active: this.filters.active };
        this.stack = [{ adcode: '100000', name: '全国', level: 0 }];
        this.clearPick();
        await this.refresh();
        this.syncUrl();
      },
      /* ---------------- 跨页联动 ---------------- */
      gotoStation(s) {
        if (!s || !s.code) return;
        this.$emit('pick', { view: 'station', params: { code: s.code } });
      },
      gotoOverview() {
        this.$emit('pick', { view: 'overview', params: {} });
      },
      lvClass: U.lvClass, shortName: U.shortName,
      lvName(r) { return LEVEL_NAME[r] || '—'; },
      geoLevelCn(g) {
        return ({ province: '省级', city: '市级', county: '区县级', district: '区县级' })[g] || '省级';
      },
      /* 地图等级图例：颜色直接取 theme.js 的规范，**不再在模板里硬编码 hex**。
         原来这里写死了 5 个色值，其中"无预警"写的是 rgba(22,48,74,.85)，
         而地图面实际用的是 T.C.faceEmpty = '#152a40' —— 图例色块和地图不是同一个颜色。
         改成从 T.C 取值后，图例与地图天然同源，也不会再漂移。 */
      mapLegend() {
        return [
          { key: '红色', color: T.C.lv['红色'], note: '（最高）' },
          { key: '橙色', color: T.C.lv['橙色'], note: '' },
          { key: '黄色', color: T.C.lv['黄色'], note: '' },
          { key: '蓝色', color: T.C.lv['蓝色'], note: '' },
          { key: '无预警', color: T.C.faceEmpty, note: '' }
        ];
      },
      /* 今天那一格：当天白天的预报源站常为哨兵值（已清洗为 null），
         这时用夜间预报顶上，比显示一个空格有用 */
      fcInfo(f, i) {
        if (f.day_info) return f.day_info;
        return f.night_info ? '夜 ' + f.night_info : '—';
      },
      fcTemp(f) {
        const v = (f.day_temp !== null && f.day_temp !== undefined) ? f.day_temp : f.night_temp;
        return (v === null || v === undefined) ? '—' : U.num(v, 0) + '°';
      }
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
        <div class="field"><label>时效</label>
          <select v-model="filters.active" @change="applyFilters"
                  title="默认只看当前生效的预警；含历史会带出近 15 天已失效的预警">
            <option value="1">当前生效</option>
            <option value="">含已失效历史</option>
          </select>
        </div>
        <div class="field" style="flex:1;min-width:180px">
          <input type="search" v-model.trim="filters.q" placeholder="搜索预警标题 / 发布单位 / 地区"
                 @keyup.enter="applyFilters" style="width:100%">
        </div>
        <button class="btn ghost" @click="reset">重置</button>
        <span v-if="filters.county || filters.min_rank || filters.since || filters.until" style="font-size:11px;color:var(--cyan)">沙盘筛选：{{ filters.county }} {{ filters.min_rank ? lvName(Number(filters.min_rank)) + '及以上' : '' }} {{ filters.since ? filters.since.slice(5,16) : '' }}{{ filters.until ? ' 至 ' + filters.until.slice(5,16) : '' }}</span>
        <span class="kbd-tip" style="margin-left:6px"><kbd>↑</kbd><kbd>↓</kbd>选择<kbd>Enter</kbd>打开</span>
        <span style="margin-left:auto;font-size:12px;color:#6f89a6">
          当前筛选命中 <b style="color:#3fc6ff">{{ total }}</b> 条
        </span>
      </div>

      <!-- 地图 + 侧栏 -->
      <div class="grid" style="grid-template-columns:minmax(0,1fr) 372px;flex:1;min-height:0">
        <div class="panel">
          <div class="panel-head">
            <h3>预警落区地图</h3>
            <span class="sub cal-note" :class="{ stale: alarmStale }" v-if="alarmNote"
                  :title="alarmStale ? '预警采集链路已停摆，本页展示的是更早那一轮的数据，请检查实时引擎页的「预警信号」任务' : ''"
                  >{{ alarmNote }}</span>
            <span class="sub">{{ dim === 'province' ? '点击省份下钻' : dim === 'city' ? '点击城市下钻至区县' : '已到区县级，点击圆点查看详情' }} · 点击清单可定位 · 可逐级回退（Esc）</span>
          </div>
          <div class="panel-body map-wrap" style="padding:0">
            <div class="map-tools">
              <button class="btn ghost back-btn" :disabled="!canBack" :title="backTip + '（Esc / Alt+←）'"
                      @click="back">← 返回上一级</button>
              <div class="crumb">
                <template v-for="(s,i) in stack" :key="s.adcode">
                  <i v-if="i">›</i>
                  <span :class="{cur: i === stack.length-1}" @click="drillTo(i)">{{ shortName(s.name) }}</span>
                </template>
              </div>
              <span class="view-tag" v-if="focus">⊙ 已定位：{{ focus.label }}</span>
              <button class="btn ghost reset-view" v-if="focus" @click="resetView"
                      title="回到当前层级的默认视野（不清除筛选）">复位视野</button>
              <button class="btn ghost reset-view" v-else @click="copyLink"
                      title="把当前筛选与选中项复制成链接">复制链接</button>
            </div>
            <div class="chart" ref="map"></div>
            <div class="legend-box">
              <div class="legend-row" v-for="l in mapLegend" :key="l.key">
                <span class="legend-swatch" :style="{ background: l.color }"></span>{{ l.key }}{{ l.note }}
              </div>
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
            <div class="panel-body scroll" @mouseleave="leaveRow" @scroll.passive="noteListScroll">
              <template v-if="tab === 'list'">
                <div class="alist">
                  <div class="alist-item" v-for="(r, i) in listRows" :key="r.id"
                       :class="[lvClass(r.level), { sel: selected && selected.id === r.id, hot: hotId === r.id, fav: fav.includes(r.id) }]"
                       @click="pickRow(r)" @mouseenter="hoverRow(r)">
                    <div class="ai-top">
                      <span class="badge" :class="lvClass(r.level)">{{ r.type }}{{ r.level }}</span>
                      <span v-if="U.isNew(r.ingested_at, 10)" class="new-tag">NEW</span>
                      <span class="fav-star" :class="{ on: fav.includes(r.id) }"
                            @click.stop="toggleFav(r)"
                            :title="fav.includes(r.id) ? '取消关注' : '关注（置顶）'">{{ fav.includes(r.id) ? '★' : '☆' }}</span>
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
                  <span class="fav-star" :class="{ on: fav.includes(selected.id) }"
                        @click="toggleFav(selected)"
                        :title="fav.includes(selected.id) ? '取消关注' : '关注（置顶）'"
                        style="margin-left:auto;font-size:17px">{{ fav.includes(selected.id) ? '★' : '☆' }}</span>
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
                    <div class="v" style="font-size:13px">
                      <template v-if="selected.lng !== null && selected.lat !== null">
                        {{ selected.lng.toFixed(3) }}, {{ selected.lat.toFixed(3) }}</template>
                      <template v-else>源站未提供坐标</template>
                      <small>· 定位精度 {{ geoLevelCn(selected.geo_level) }}</small>
                    </div>
                  </div>
                </div>

                <!-- 现场对照：预警说"将会怎样"，实况说"现在如何" -->
                <div class="ctx-head">
                  <span>现场对照</span>
                  <span class="ctx-note" v-if="ctxLoading">正在取最近气象站 …</span>
                  <span class="ctx-note" v-else-if="ctxInfo">{{ ctxInfo.note }}</span>
                </div>
                <template v-if="ctxInfo && ctxInfo.stations.length">
                  <div class="ctx-station" v-for="(s, i) in ctxInfo.stations" :key="s.code"
                       :class="{ best: i === 0 }">
                    <span class="cs-name">{{ shortName(s.city) }}</span>
                    <span class="cs-dist" v-if="s.distance_km !== null">直线 {{ s.distance_km }} km</span>
                    <span class="cs-approx" v-if="s.geo_approx" title="该站坐标为省中心近似值">坐标近似</span>
                    <span class="cs-val">
                      <template v-if="s.temp !== null">{{ U.num(s.temp, 1) }}℃</template>
                      <template v-else>—</template>
                      · {{ s.info || '未知' }}
                      <template v-if="s.rain"> · 雨 {{ U.num(s.rain, 1) }}mm</template>
                    </span>
                  </div>
                  <div class="ctx-head" style="margin-top:10px" v-if="ctxInfo.forecast.length">
                    <span>{{ shortName(ctxInfo.forecast_station.city) }} 未来 {{ ctxInfo.forecast.length }} 日</span>
                    <span class="ctx-note" v-if="ctxInfo.forecast_fetched_at">
                      抓取于 {{ U.ago(ctxInfo.forecast_fetched_at) }}</span>
                  </div>
                  <div class="fc-mini" v-if="ctxInfo.forecast.length">
                    <div class="fm" v-for="(f, i) in ctxInfo.forecast" :key="f.date" :class="{ today: i === 0 }">
                      <div class="d">{{ i === 0 ? '今天' : f.date.slice(5) }}</div>
                      <div class="i">{{ fcInfo(f, i) }}</div>
                      <div class="t">{{ fcTemp(f) }}</div>
                    </div>
                  </div>
                  <div class="ctx-empty" v-else>该站暂无有效预报，等待下一次采集</div>

                  <div class="linkrow">
                    <button class="btn ghost" @click="gotoStation(ctxInfo.stations[0])">
                      查看该站详情 ›</button>
                    <button class="btn ghost" @click="drillToAlarmRegion()" v-if="canDrillFocus">
                      下钻到此地 ›</button>
                    <button class="btn ghost" @click="resetView()" v-if="focus">复位视野</button>
                  </div>
                </template>
                <div class="ctx-empty" v-else-if="!ctxLoading">未找到可对照的气象站</div>

                <div class="linkrow">
                  <a class="btn ghost" :href="selected.url" target="_blank"
                     style="text-decoration:none">查看气象局原文 ↗</a>
                  <button class="btn ghost" @click="copyLink()">复制当前视图链接</button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})();
