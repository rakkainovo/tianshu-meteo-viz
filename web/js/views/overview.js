/* ============================================================
   views/overview.js —— 态势总览
   一屏回答："此时此刻，全国正在发生什么？"

   2026-09-24 交互增强（"点了一个东西要看得见"）：
   1. 点右侧「最新预警」/ 点地图圆点 -> 地图平滑飞行 + 扩散光圈 + 名称标签，
      并在图右上浮出详情卡（含最近气象站实况，由 /api/alarms/<id>/context 提供）
   2. 点省份色块 / 城市排行 -> 带着 adcode 跳到预警地图并自动下钻到该地
   3. 清单 hover <-> 地图圆点 hover 双向高亮；键盘 ↑↓ / Enter / Esc 可全程操作
   4. 视图状态写进 URL（?focus=<id>），可复制分享，也能从搜索/问答深链进来
   ============================================================ */
(function () {
  'use strict';

  const LEVEL_NAME = { 4: '红色', 3: '橙色', 2: '黄色', 1: '蓝色', 0: '无' };
  /* 单次取多少条预警用于打点与清单。
     2026-10-02：**这个上限本身曾经是个坑** —— 全国库内 4,600+ 条时，最新 300 条只覆盖
     最近 8 小时（看着很"实时"）；下钻到广东（337 条）时同一个上限形同虚设，把 12 天前的
     历史预警全铺了出来，"范围越小越陈旧"。现在默认走 active=1 生效口径（全国约 400 条），
     上限提到 800 留足余量，命中条数另外用接口返回的 total，不再拿被截断的数组长度充数。 */
  const ALARM_LIMIT = 800;

  window.ViewOverview = {
    name: 'v-overview',
    props: { meta: Object, ctx: Object, route: Object },
    mixins: [ChartHost],
    data() {
      return {
        loading: true,
        /* 注意：latest 是 computed（= latestAll 前 10 条），这里不能再声明同名
           data，否则 data 会遮住 computed，右侧清单永远显示"暂无预警记录" */
        provAgg: [], cityAgg: [], series: null, latestAll: [],
        typhoons: null, activeType: '', mapName: '',
        /* 等级构成/灾种分布做成响应数据：下钻到某省、或按等级/灾种筛选后
           要跟着变（它们来自 /api/alarms/agg，而不是全局 meta） */
        levels: [], types: [],
        /* 省份页内下钻：null=全国；{adcode,name}=已下钻到该省 */
        drill: null,
        activeLevel: '',
        /* 「橙色及以上」快捷档（min_rank=3）。与 activeLevel 互斥：
           选具体等级时清掉它，反之亦然 —— 两个条件叠加只会把结果筛空 */
        minRank: 0,
        /* 时间窗（趋势图刷选产生）：{since, until, label}；null = 不限时间 */
        win: null,
        /* 默认只画北京时间今天发布且最近一轮采集仍在生效的预警。
           关掉 = 含已失效历史（近 15 天累计），仅用于对照与排查。
           注意这是**口径**不是筛选：它不随「清除全部筛选」一起被清掉。 */
        activeOnly: true,
        activeInfo: null,       // {scan_at, active_total, age_hours, stale}，来自接口
        /* 命中条数：用接口的 total，别用 latestAll.length（那是被 ALARM_LIMIT 截断后的长度） */
        hitTotal: 0,
        /* 放大浮层：{kind, key, title, sub}
           kind = level 等级详情 / type 灾种详情 / province 省份排行 /
                  city 城市排行 / trend 趋势刷选 / list 全部清单 / map 大图 */
        big: null,
        bigDetail: null,        /* 等级 / 灾种详情层的数据包 */
        bigLoading: false,
        /* 地图视野信息条（右下角）：当前缩放/中心/可视范围 */
        viewInfo: null,
        /* 焦点：{id,lng,lat,zoom,label,title,type,level,issuer,ts,place} */
        focus: null, hotId: null, cursor: -1, ctxInfo: null, ctxLoading: false,
        fav: [],                     // 收藏的预警 id（localStorage，跨页保留）
        trendRange: '15d',           // 默认最近 15 天；all 显示全部历史
        trendDim: 'level'            // 趋势图维度：level 分级堆叠 / province 按省对比
      };
    },
    computed: {
      kpi() { return (this.meta && this.meta.kpi) || {}; },
      /* KPI 口径必须跟着地图走。原来第 1 张卡写死「实时预警信号 / 近 24 小时滚动累积」，
         数字却是**建库以来的全量**（4,600 条），和地图上的 400 个点自相矛盾。
         今日生效口径使用列表接口同范围的 active 汇总，零条也不能回退到历史数量。 */
      kpiView() {
        const a = this.activeInfo || {};
        if (this.activeOnly) {
          return Object.assign({}, this.kpi, {
            alarm_total: a.active_total || 0, province_count: a.province_count || 0,
            city_count: a.city_count || 0, issuer_count: a.issuer_count || 0,
            red_orange: a.severe || 0
          });
        }
        return this.kpi;
      },
      /* 口径文案：把"这批点是什么时候的"直接写在标题旁，用户不用猜 */
      activeLabel() {
        if (!this.activeOnly) return '含已失效历史（近 15 天累计）';
        const a = this.activeInfo || (this.meta && this.meta.active) || {};
        if (!a.scan_at) return '今日生效（北京时间）';
        /* 停摆时改用**相对时间**（"5 天前"）。
           原来只给"10-03 11:26"这种绝对时刻，日期是对的，但需要用户自己
           心算"今天几号、差了几天"—— 2026-10-08 那次就是这么被瞒过去的：
           顶栏绿油油写着新鲜度 100%，角标一行小字里躺着 10-03。 */
        if (a.stale) return '预警数据 ' + this.scanAge(a.scan_at)
                          + '（' + this.hm(a.scan_at) + '），采集可能已停摆';
        return '今日发布且仍生效 · 采集于 ' + this.hm(a.scan_at);
      },
      /* 生效口径那一轮采集的时刻 / 是否已停摆（模板与 title 共用，避免到处写一长串兜底） */
      scanAt() {
        const a = this.activeInfo || (this.meta && this.meta.active) || {};
        return a.scan_at || '';
      },
      isStale() {
        const a = this.activeInfo || (this.meta && this.meta.active) || {};
        return !!a.stale;
      },
      /* 行政区全量清单（**含当前 0 条生效的省**）。
         名字 / adcode 的解析一律走这份，不要用 provAgg：生效口径下 provAgg 只含
         "有预警的省"，拿它查名字会把北京这类当前无生效预警的省变成裸 adcode
         （实测下钻北京 → 面包屑与筛选条件都变成「110000」，筛选直接归零）。 */
      regionList() {
        const m = this.meta || {};
        if (this.activeOnly && m.provinces_active && m.provinces_active.length) {
          return m.provinces_active;
        }
        return m.provinces || [];
      },
      /* 空态文案：地图上一条点都没有时，必须说清"是真的没有"还是"筛掉了"，
         否则用户会以为程序坏了（生效口径下这块会变常见：近 24h 只覆盖 20 来个省） */
      emptyTitle() {
        if (this.latestAll && this.latestAll.length) return '';
        const where = this.drill ? this.drill.name : '全国';
        return where + (this.activeOnly ? ' 今日无生效预警' : ' 近 15 天无命中记录');
      },
      typeTop() { return this.types.slice(0, 6); },
      /* 右侧"最新预警"= 当前筛选（灾种×等级×下钻省）下的前 10 条。
         从 latestAll 派生而不是单独拉一份：筛选/下钻时清单跟着变，才是真联动 */
      /* 收藏的预警置顶，右侧「最新预警」一眼能看到"我关心的" */
      latest() {
        const all = this.latestAll || [];
        const fav = all.filter(r => this.fav.indexOf(r.id) >= 0);
        const rest = all.filter(r => this.fav.indexOf(r.id) < 0);
        return fav.concat(rest).slice(0, 10);
      },
      mapPoints() {
        const recs = this.latestAll || [];
        return recs.filter(r => r.lng && r.lat)
          .map(r => ({
            id: r.id,
            name: r.city || r.county || r.province,
            value: [r.lng, r.lat],
            title: r.type + r.level + '预警',
            type: r.type, level: r.level, rank: r.level_rank,
            time: r.ts, issuer: r.issuer
          }));
      },
      /* 骨架屏条件：等级/灾种详情层的 4 个聚合请求还没回来 */
      bigSkeleton() {
        if (!this.big || !this.bigLoading) return false;
        return this.big.kind === 'level' || this.big.kind === 'type';
      },
      focusMark() {
        const f = this.focus;
        return (f && f.lng !== null && f.lng !== undefined)
          ? [T.focusItem(f.lng, f.lat, f.label)] : [];
      },
      hotMark() {
        const r = this.latestAll.find(x => x.id === this.hotId);
        return (r && r.lng) ? [{ name: r.title || '', value: [r.lng, r.lat] }] : [];
      },
      /* 浮动卡里的「最近气象站」一行：站名 + 气温 + 天气 */
      ctxStation() {
        const s = this.ctxInfo && this.ctxInfo.stations && this.ctxInfo.stations[0];
        if (!s) return '';
        const t = (s.temp === null || s.temp === undefined) ? '—' : U.num(s.temp, 1) + '℃';
        return U.shortName(s.city) + ' ' + t + (s.info ? ' ' + s.info : '');
      }
    },
    async created() {
      this.fav = Fav.all();
      await this.load();
      await this.applyRoute(this.route || {});
    },
    mounted() {
      /* 键盘：↑↓ 选、Enter 打开并定位、Esc 收起 */
      this._onKey = e => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
        if (this.$root && this.$root.searchOpen) return;
        if (e.key === 'Escape') {
          /* Esc 四段式：先关放大浮层 -> 收焦点 -> 退出下钻 -> 清时间窗 */
          if (this.big) { e.preventDefault(); this.closeBig(); return; }
          if (this.focus) { e.preventDefault(); this.resetView(); return; }
          if (this.drill) { e.preventDefault(); this.exitProvince(); return; }
          if (this.win) { e.preventDefault(); this.clearWindow(); return; }
          return;
        }
        /* 浮层打开时，其余快捷键交给浮层自己，别去操作背后的清单 */
        if (this.big) return;
        /* 地图缩放/复位的键盘入口：+ 放大、- 缩小、0 回全国视野 */
        if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomIn(); return; }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomOut(); return; }
        if (e.key === '0') { e.preventDefault(); this.resetView(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const n = this.latest.length;
          if (!n) return;
          e.preventDefault();
          const d = e.key === 'ArrowDown' ? 1 : -1;
          const c = this.cursor < 0 ? (d > 0 ? 0 : n - 1)
                                    : Math.max(0, Math.min(n - 1, this.cursor + d));
          this.cursor = c;
          this.setHot(this.latest[c].id);
          this.scrollToActive();
          return;
        }
        if (e.key === 'Enter') {
          const r = this.latest[this.cursor];
          if (r) { e.preventDefault(); this.pickRow(r); }
        }
      };
      window.addEventListener('keydown', this._onKey);
    },
    watch: {
      route(nv) { if (nv && nv._seq) this.applyRoute(nv); }
    },
    /* 路由切换会直接销毁本组件：放大层若开着，body 上的滚动锁和
       关闭兜底定时器必须在这里清掉，否则全站滚动被永久锁死 */
    beforeUnmount() {
      window.removeEventListener('keydown', this._onKey);
      clearTimeout(this._clkT);
      if (this._viT) cancelAnimationFrame(this._viT);
      this._bigAnims(null);
      this._bigClosing = false;
      document.body.style.overflow = '';
    },
    methods: {
      /* 按谓词在当前行政区清单里找一个省（**必须是 method 不能是 computed**：
         带参数的东西放进 computed 会先被求值成对象，调用时报
         "object is not a function"，而且只在 applyRoute 的 async 链里抛，
         页面看着毫无反应、控制台只有一条 unhandledrejection —— 极难定位）。
         先查全量表（含 0 条生效的省），再退回聚合表兜底 */
      regionFind(pred) {
        return this.regionList.find(pred) || this.provAgg.find(pred) || null;
      },
      /* 'YYYY-MM-DD HH:MM:SS' -> 'MM-DD HH:MM'（口径文案用，别把秒也带上） */
      hm(s) {
        if (!s) return '—';
        const t = String(s).replace('T', ' ');
        return t.length >= 16 ? t.slice(5, 16) : t;
      },
      /* 采集时刻 -> 相对时间（"刚刚 / 12 分钟前 / 3 小时前 / 5 天前"）。
         停摆场景下相对时间比绝对时刻更早被发现：人不会去心算 10-03 距今几天，
         但"5 天前"一眼就知道不对劲。 */
      scanAge(s) {
        if (!s) return '—';
        const t = new Date(String(s).replace(/-/g, '/')).getTime();
        if (Number.isNaN(t)) return this.hm(s);
        const m = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (m < 2) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' 小时前';
        return Math.floor(h / 24) + ' 天前';
      },
      async load() {
        this.loading = true;
        try {
          /* 首屏就按 filterQuery 取数（含 active=1 生效口径）。
             原来是全不带的裸请求，于是首帧会把 4,000+ 条历史预警全画到地图上，
             等 applyRoute 回来才纠正 —— 那一下"满屏旧点"正是要消灭的观感。 */
          const q = this.filterQuery();
          const [provAgg, cityAgg, series, ty, lvAgg, tyAgg, alarmAll] = await Promise.all([
            API.alarmAgg(Object.assign({ dim: 'province', top: 40 }, this.ctxQuery('province'))),
            API.alarmAgg(Object.assign({ dim: 'city', top: 8 }, this.ctxQuery('city'))),
            API.alarmSeries(this.seriesQuery()),
            API.typhoonOverview(),
            API.alarmAgg(Object.assign({ dim: 'level' }, q)),
            API.alarmAgg(Object.assign({ dim: 'type', top: 8 }, q)),
            API.alarms(Object.assign({ limit: ALARM_LIMIT }, q))
          ]);
          this.provAgg = provAgg.data || [];
          this.cityAgg = cityAgg.data || [];
          this.series = series;
          this.typhoons = ty;
          this.levels = lvAgg.data || [];
          this.types = tyAgg.data || [];
          this.useAlarms(alarmAll);
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
      /* ---------------- 筛选（灾种 × 等级 × 下钻省份 × 时间窗）统一重取 ----------------
         四者叠加成同一个查询，等级构成/灾种分布/地图散点/清单一起跟着变，
         避免"地图过滤了、饼图还是全国"的假联动。
         ctxQuery(dim)：按某一维聚合时要把**这一维的筛选去掉**，
         否则"看黄色预警的灾种构成"会变成"看黄色预警里筛选出的灾种=黄色"，
         结果只剩一行。 */
      filterQuery() {
        const q = {};
        if (this.activeType) q.type = this.activeType;
        if (this.activeLevel) q.level = this.activeLevel;
        if (this.minRank) q.min_rank = this.minRank;
        if (this.drill) q.province = this.drill.name;
        if (this.win) { q.since = this.win.since; q.until = this.win.until; }
        /* 生效口径：地图 / 色块 / 清单 / 等级构成全部走同一个 active=1，
           否则又会出现"点是最新的、色块是 15 天累计"的两套口径 */
        if (this.activeOnly) { q.active = 1; q.period = 'today'; }
        else q.period = '15d';
        return q;
      },
      ctxQuery(dim) {
        const q = Object.assign({}, this.filterQuery());
        delete q[dim];
        return q;
      },
      /* 趋势图的分桶查询：默认分级堆叠；「省份对比」时按省拆分（后端 dim=province）。
         下钻到省后省份对比失去意义（filterQuery 已带 province 约束），
         此时退回分级堆叠，避免 dim=province 与 province 筛选叠加成单省一条线。
         **趋势图不走今日生效口径**：它天生是"近 15 天怎么演变的"历史视角，
         限制在生效集合里会退化成只剩最近 24 小时的一两根柱子。
         **趋势图也不吃地图刷选时间窗**（since/until 必须删掉）：它就是时间轴本身。
         不删会怎样（2026-10-09 实测）：刷选 10-09 02:00~04:59 后后端只回 3 个桶
         （全量 280 个）、series 从 4 条塌成 2 条 —— 曲线等于被换了批数据重画，
         轴范围/图例/基线全变，用户看到的就是"一缩小时间窗形态就不对了"。 */
      seriesQuery() {
        const q = Object.assign({ bucket: 'hour' }, this.filterQuery());
        delete q.active;
        delete q.period;
        if (this.trendRange === '15d') q.period = '15d';
        delete q.since;
        delete q.until;
        if (this.trendDim === 'province' && !this.drill) q.dim = 'province';
        return q;
      },
      async changeTrendRange() {
        const seq = (this._trendSeq || 0) + 1;
        this._trendSeq = seq;
        const series = await API.alarmSeries(this.seriesQuery());
        if (seq !== this._trendSeq) return;
        this.series = series;
        this.renderTrend();
      },
      /* 趋势图维度切换：只重取趋势，不动地图/清单（比整体 applyFilters 轻） */
      async setTrendDim(d) {
        if (this.trendDim === d) return;
        this.trendDim = d;
        await this.changeTrendRange();
      },
      async applyFilters(opts) {
        /* keepTrend：只有时间窗变了。趋势图的数据与窗口无关（见 seriesQuery），
           所以既不重查它。 */
        const keepTrend = !!(opts && opts.keepTrend) && !!this.series;
        const q = this.filterQuery();
        /* 地图色块的面数据也要跟着重取 —— 原来这里漏了，导致按等级/灾种筛选后
           色块纹丝不动（下钻态尤其明显：面是上一次的聚合） */
        const face = this.drill
          ? API.alarmAgg(Object.assign({ dim: 'city', top: 40 }, this.ctxQuery('city')))
          : API.alarmAgg(Object.assign({ dim: 'province', top: 40 }, this.ctxQuery('province')));
        const [recs, lvAgg, tyAgg, sers, faceAgg] = await Promise.all([
          API.alarms(Object.assign({ limit: ALARM_LIMIT }, q)),
          API.alarmAgg(Object.assign({ dim: 'level' }, q)),
          API.alarmAgg(Object.assign({ dim: 'type', top: 8 }, q)),
          keepTrend ? Promise.resolve(this.series) : API.alarmSeries(this.seriesQuery()),
          face
        ]);
        this.useAlarms(recs);
        if (this.drill) this.cityAgg = faceAgg.data || [];
        else this.provAgg = faceAgg.data || [];
        this.levels = lvAgg.data || [];
        this.types = tyAgg.data || [];
        this.series = sers;
        /* 焦点条目被过滤掉时收回，别留一个"看不见的定位" */
        if (this.focus && !this.latestAll.find(x => x.id === this.focus.id)) {
          this.clearFocus();
        }
        /* 放大层盖住主地图时先别重画它 —— 全国地图（色块 + 最多 800 个散点）
           是这次提交里最贵的一笔，实测松手后那一帧阻塞 0.7~1.2s，大头就是它；
           而用户此刻在浮层里根本看不到它。关层时补画（见 closeBig）。
           拖动时间窗时若松手不到 620ms 又继续拖，这 0.7s 的阻塞正好砸在拖动中间，
           鼠标事件被拖后处理，手感就是"卡住"。 */
        if (this.big) this._mapDirty = true;
        else this.renderMap();
        this.renderLevel();
        this.renderType();
        /* keepTrend 时只补小面板的 markArea 高亮 —— **大层趋势图绝不重画**：
           它不吃时间窗，而拖动中途整图重建（setChart 是 notMerge）会把 ECharts
           的 dataZoom 拖拽状态连同滑块一起打断，表现就是"卡住之后再拖也不动"。 */
        if (keepTrend) this.setChart('trend', this.trendOption(this.series, 0));
        else this.renderTrend();
        this.syncUrl();
      },
      /* 统一收口 /api/alarms 的返回。
         原来各处直接写 latestAll = recs.records，于是筛选条上的「命中 N 条」
         显示的是**被 ALARM_LIMIT 截断后的长度**，不是真实命中数。 */
      useAlarms(recs) {
        this.latestAll = recs.records || [];
        this.hitTotal = (recs.total === undefined) ? this.latestAll.length : recs.total;
        if (recs.active) this.activeInfo = recs.active;
      },
      /* 时效口径切换：当前生效 <-> 含已失效历史。
         这是口径不是筛选，故 clearAllFilters 不会把它重置。 */
      async toggleActive() {
        this.activeOnly = !this.activeOnly;
        if (this.drill) await this.loadDrillData();
        else await this.applyFilters();
        this.flash(this.activeOnly
          ? '已切回「今日生效」：只显示今天（北京时间）发布且本轮仍生效的预警'
          : '已切到「含历史」：包含近 15 天已失效的预警，仅用于对照与排查', 'ok');
      },
      async setType(t) {
        this.activeType = (this.activeType === t ? '' : t);
        await this.applyFilters();
      },
      async setLevel(lv) {
        this.activeLevel = (this.activeLevel === lv ? '' : lv);
        if (this.activeLevel) this.minRank = 0;
        await this.applyFilters();
      },
      /* KPI「橙色及以上」：一键筛选 min_rank>=3，再点取消 */
      async setTier() {
        this.minRank = this.minRank ? 0 : 3;
        if (this.minRank) this.activeLevel = '';
        await this.applyFilters();
        this.flash(this.minRank ? '已筛选：橙色及以上（' + this.latestAll.length + ' 条）'
                                : '已取消「橙色及以上」筛选', 'ok');
      },
      /* ---------------- 时间窗：两级更新 ----------------
         拖动时间轴时每个 dataZoom 事件都跑一遍 applyFilters 是不行的：
         那里面有 5 个接口 + 重画全国地图（实测松手后有一帧阻塞 703ms）。
         所以拆成两级 ——
           · 拖动中：只记账 + 更新窗口标签（纯 DOM），大层趋势图纹丝不动；
           · 停手后（拖动停止 620ms）：才提交那次重活（地图/清单/构成/排行 + 小面板高亮）。
         窗口标签实时跟着走，所以"拖的时候看得见自己选到哪了"这点没丢。 */
      _winKey() { return this.win ? this.win.since + '~' + this.win.until : ''; },
      _setWin(since, until) {
        this.win = since
          ? { since: since, until: until, label: since.slice(5) + ' ~ ' + until.slice(5) }
          : null;
      },
      /* 拖动中调用：只改状态，重活延后。
         _winPending 期间 renderTrend() 会跳过同步大层（那是可拖拽的画布，不能重建）。 */
      _stageWin(since, until) {
        this._setWin(since, until);
        this._winPending = true;
        this.syncUrl();
        if (!this._commitDeb) {
          this._commitDeb = U.debounce(() => this._commitWin(), 620);
        }
        this._commitDeb();
      },
      _commitWin() {
        this._winPending = false;
        if (this._winCommitted === this._winKey()) return;
        this._winCommitted = this._winKey();
        this.applyFilters({ keepTrend: true });
      },
      /* 外部入口（深链 ?since= / 清窗 ✕ / 快捷区间）：设窗并立即提交，
         不必等 620ms —— 这些都不是高频事件。
         大层的缩放范围**就是**窗口本身，所以窗口被外部改时要把视野搬过去
         （拖动路径不在这里：那时滑块本来就在用户手上，搬了反而打架）。
         重画大层在这一刻是安全的：没有拖拽手势正在进行。 */
      applyWindow(since, until) {
        this._setWin(since, until);
        this._winPending = false;
        this._winCommitted = this._winKey();
        if (this.big && this.big.kind === 'trend') this.renderBigTrend();
        this.applyFilters({ keepTrend: true });
      },
      clearWindow() { if (this.win) this.applyWindow(null); },
      /* 快捷时间窗（小时；0 = 全部）。
         为什么必须有：大层时间轴的滑块把手本身就占 ~8% 宽度，529 个桶摊在上面，
         想用鼠标拖出"近 24 小时"这种窄窗基本不可能 —— 这就是"时间窗有最小值"。
         精确入口交给这几个 chip；细调也可以用鼠标滚轮在图上缩放（inside zoom）。 */
      quickWin(hours) {
        const b = (this.series && this.series.buckets) || [];
        const n = b.length;
        if (n < 2) return;
        if (!hours) { this.applyWindow(null); return; }
        const last = b[n - 1];
        const d = new Date(last.replace(/-/g, '/') + ':00');
        d.setHours(d.getHours() - hours);
        const p2 = x => (x < 10 ? '0' : '') + x;
        const from = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
                   + ' ' + p2(d.getHours()) + ':00';
        let i0 = b.findIndex(x => x >= from);
        if (i0 < 0) i0 = 0;
        this.applyWindow(b[i0], this._bucketEnd(last));
      },
      /* 一键清掉全部筛选，回到"此刻全国" */
      async clearAllFilters() {
        this.activeType = '';
        this.activeLevel = '';
        this.minRank = 0;
        this.win = null;
        if (this.drill) { await this.exitProvince(); }
        else { await this.applyFilters(); }
        this.flash('已清除全部筛选，回到全国实时口径', 'ok');
      },
      /* 实时推送到达：「静默」重取数据（不显示加载遮罩，保留已选灾种与当前焦点） */
      async onLive() {
        const q = this.filterQuery();
        /* 下钻态要在省内取面数据（原来固定取全国 TOP8，实时推送一到，
           下钻中的地图面就被全国城市替换掉了） */
        const face = this.drill
          ? API.alarmAgg(Object.assign({ dim: 'city', top: 40 }, this.ctxQuery('city')))
          : API.alarmAgg(Object.assign({ dim: 'province', top: 40 }, this.ctxQuery('province')));
        const [faceAgg, cityAgg, sers, ty, lvAgg, tyAgg, alarmAll] = await Promise.all([
          face,
          API.alarmAgg(Object.assign({ dim: 'city', top: 8 }, this.ctxQuery('city'))),
          API.alarmSeries(this.seriesQuery()),
          API.typhoonOverview(),
          API.alarmAgg(Object.assign({ dim: 'level' }, q)),
          API.alarmAgg(Object.assign({ dim: 'type', top: 8 }, q)),
          API.alarms(Object.assign({ limit: ALARM_LIMIT }, q))
        ]);
        if (this.drill) {
          this.cityAgg = faceAgg.data || [];
        } else {
          this.provAgg = faceAgg.data || [];
          this.cityAgg = cityAgg.data || [];
        }
        this.series = sers;
        this.typhoons = ty;
        this.levels = lvAgg.data || [];
        this.types = tyAgg.data || [];
        this.useAlarms(alarmAll);
        /* 选中的那条只要还在结果里就留着，别把用户正在看的东西抖掉 */
        if (this.focus) {
          const keep = this.latestAll.find(x => x.id === this.focus.id);
          if (keep) this.focus = this.focusFromRecord(keep, this.focus.zoom);
          else this.clearFocus();
        }
        this.render();
        if (this.big && (this.big.kind === 'level' || this.big.kind === 'type')) {
          this.loadBigDetail(this.big.kind, this.big.key, true);
        }
      },
      render() {
        /* 放大层开着时主地图被完全盖住，重画它只是白烧 CPU（还要 0.7s+），
           标记脏位、关层时补画。见 applyFilters 里的同一处判断。 */
        if (this.big) this._mapDirty = true;
        else this.renderMap();
        this.renderLevel();
        this.renderType();
        this.renderTrend();
      },

      /* ---------------- 省份页内下钻 ----------------
         之前点省份是直接跳到预警地图页：用户"点击地图"的第一预期是就地展开
         这个省，而不是整个页面被换掉。现在：单击省份在本页下钻（面包屑可回），
         跳预警地图作为详情卡里的二级动作。
         下钻入口统一走 drillAt()（带防连跳守卫，双击不会钻两级）。 */
      async drillProvinceIn(name) {
        const p = this.regionFind(x => x.name === name);
        if (!p || !p.adcode) { this.flash('该省暂无更细的下钻数据'); return; }
        this.drill = { adcode: String(p.adcode), name };
        this.clearFocus();
        await this.loadDrillData();
        this.flash('已下钻到 ' + name + '，点「返回全国」回到全国态势', 'ok');
      },
      async loadDrillData() {
        const d = this.drill;
        if (!d) return;
        this.loading = true;
        try {
          const [cityAgg2, lvAgg, tyAgg, sers, recs] = await Promise.all([
            API.alarmAgg(Object.assign({ dim: 'city', top: 40 }, this.ctxQuery('city'))),
            API.alarmAgg(Object.assign({ dim: 'level' }, this.ctxQuery('level'))),
            API.alarmAgg(Object.assign({ dim: 'type', top: 8 }, this.ctxQuery('type'))),
            API.alarmSeries(this.seriesQuery()),
            API.alarms(Object.assign({ limit: ALARM_LIMIT }, this.filterQuery()))
          ]);
          this.cityAgg = cityAgg2.data || [];
          this.levels = lvAgg.data || [];
          this.types = tyAgg.data || [];
          this.series = sers;
          this.useAlarms(recs);
          this.mapName = await MapHub.use(d.adcode);
          this.render();
          this.syncUrl();
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },
      async exitProvince() {
        if (!this.drill) return;
        this.drill = null;
        this.loading = true;
        try {
          const [provAgg, cityAgg2, lvAgg, tyAgg, sers, recs] = await Promise.all([
            API.alarmAgg(Object.assign({ dim: 'province', top: 40 }, this.ctxQuery('province'))),
            API.alarmAgg(Object.assign({ dim: 'city', top: 8 }, this.ctxQuery('city'))),
            API.alarmAgg(Object.assign({ dim: 'level' }, this.ctxQuery('level'))),
            API.alarmAgg(Object.assign({ dim: 'type', top: 8 }, this.ctxQuery('type'))),
            API.alarmSeries(this.seriesQuery()),
            API.alarms(Object.assign({ limit: ALARM_LIMIT }, this.filterQuery()))
          ]);
          this.provAgg = provAgg.data || [];
          this.cityAgg = cityAgg2.data || [];
          this.levels = lvAgg.data || [];
          this.types = tyAgg.data || [];
          this.series = sers;
          this.useAlarms(recs);
          this.mapName = await MapHub.use('100000');
          this.render();
          this.syncUrl();
        } finally {
          this.loading = false;
          this.$nextResize();
        }
      },

      /* ---------------- 路由 / URL 状态 ---------------- */
      async applyRoute(rt) {
        rt = rt || {};
        /* 放大浮层：URL 里没有 big 参数而当前开着 -> 先收起。
           必须放在最前面：后面的 applyFilters/applyWindow 都会 syncUrl，
           那时若 this.big 还在，刚被去掉的 big 参数又会被写回 URL。 */
        const wantBig = rt.big || '';
        if (!wantBig && this.big) {
          this.big = null;
          this.bigDetail = null;
          this._bigDropCharts();
        }
        /* 时效口径也能从 URL 恢复（?hist=1 = 含已失效历史）。
           先设标志、后由下面的分支触发重取；若没有别的分支重取，这里补一次。 */
        const wantHist = !!rt.hist;
        const histChanged = (wantHist === this.activeOnly);
        if (histChanged) this.activeOnly = !wantHist;
        let refetched = false;
        /* 下钻状态也能从 URL 恢复（分享/刷新不丢层级） */
        if (rt.adcode && (!this.drill || this.drill.adcode !== String(rt.adcode))) {
          const known = this.regionFind(x => String(x.adcode) === String(rt.adcode));
          this.drill = { adcode: String(rt.adcode), name: (known && known.name) || rt.adcode };
          await this.loadDrillData();
          refetched = true;
        } else if (!rt.adcode && this.drill) {
          await this.exitProvince();
          refetched = true;
        }
        if (rt.level && rt.level !== this.activeLevel) {
          this.activeLevel = rt.level;
          this.minRank = 0;
          await this.applyFilters();
          refetched = true;
        }
        if (rt.tier && !this.minRank) {
          this.minRank = 3;
          await this.applyFilters();
          refetched = true;
        }
        if (histChanged && !refetched) await this.applyFilters();
        if (rt.since && (!this.win || this.win.since !== rt.since)) {
          this.applyWindow(rt.since, rt.until || this._bucketEnd(rt.since));
        } else if (!rt.since && this.win) {
          this.applyWindow(null);
        }
        if (rt.focus && (!this.focus || this.focus.id !== rt.focus)) {
          await this.focusById(rt.focus);
        } else if (!rt.focus && this.focus) {
          /* 外部把 focus 参数去掉了（例如点了别处的总览入口）-> 跟着收起 */
          this.clearFocus();
        }
        /* 放大浮层：深链到"黄色预警详情"这类状态，答辩演示/分享用得上 */
        if (wantBig) {
          const cur = this.big ? (this.big.kind + (this.big.key ? ':' + this.big.key : '')) : '';
          if (wantBig !== cur) {
            const parts = wantBig.split(':');
            await this.openBig(parts[0], parts[1] || '');
          }
        }
      },
      syncUrl() {
        const p = {};
        if (this.focus) p.focus = this.focus.id;
        if (this.drill) p.adcode = this.drill.adcode;
        if (!this.focus && this.activeType) p.type = this.activeType;
        if (this.activeLevel) p.level = this.activeLevel;
        if (this.minRank) p.tier = 1;
        if (this.win) { p.since = this.win.since; p.until = this.win.until; }
        if (!this.activeOnly) p.hist = 1;        // 含已失效历史的口径可深链分享
        if (this.big) p.big = this.big.kind + (this.big.key ? ':' + this.big.key : '');
        const qs = Object.keys(p).map(k => k + '=' + encodeURIComponent(p[k])).join('&');
        const hash = '#/overview' + (qs ? '?' + qs : '');
        if (location.hash !== hash) {
          try { history.replaceState(null, '', hash); } catch (e) { location.hash = hash; }
        }
      },

      /* ---------------- 焦点定位 ---------------- */
      focusFromRecord(r, zoom) {
        const place = U.shortName(r.county) || U.shortName(r.city) || U.shortName(r.province) || '';
        return {
          id: r.id, lng: r.lng, lat: r.lat,
          zoom: zoom || T.focusZoom(r.geo_level),
          label: r.type + r.level + (place ? ' · ' + place : ''),
          title: r.title, type: r.type, level: r.level, issuer: r.issuer,
          ts: r.ts, place: place || '—',
          isNew: U.isNew(r.ingested_at, 10)
        };
      },
      focusOn(r) {
        if (!r) return;
        if (r.lng === null || r.lng === undefined || r.lat === null || r.lat === undefined) {
          this.flash('该预警没有落区坐标，无法在地图上定位', 'warn');
          return;
        }
        this.focus = this.focusFromRecord(r);
        /* 只在 map 图实例已就绪时才动它；否则 renderMap 会用新 focus 重建 */
        this.mapOverlay('map', { focus: this.focusMark });
        this.geoFly('map', r.lng, r.lat, this.focus.zoom);
      },
      clearFocus() {
        this.focus = null;
        this.hotId = null;
        this.cursor = -1;
        this.ctxInfo = null;
        this.mapOverlay('map', { focus: [] });
        this.syncUrl();
      },
      resetView() {
        this.focus = null;
        this.ctxInfo = null;
        this.mapOverlay('map', { focus: [] });
        this.geoFly('map', null, null, null);
        this.syncUrl();
      },
      /* 点右侧清单 / 点地图圆点 -> 定位 + 取现场对照 + 卡片 */
      async pickRow(r) {
        if (!r) return;
        this.focusOn(r);
        const i = this.latest.findIndex(x => x.id === r.id);
        this.cursor = i >= 0 ? i : -1;
        this.hotId = null;
        this.mapOverlay('map', { hover: [] });
        this.loadContext(r.id);
        this.syncUrl();
      },
      pickByPoint(p) {
        if ((p.seriesType !== 'scatter' && p.seriesType !== 'effectScatter') || !p.data) return;
        const rec = this.latestAll.find(r => r.id === p.data.id);
        if (rec) this.pickRow(rec);
      },
      /* 从外部（搜索 / 问答 / 预警地图）深链进来定位某条预警 */
      async focusById(id) {
        let r = this.latestAll.find(x => x.id === id);
        let ctx = null;
        if (!r) {
          try {
            ctx = await API.alarmContext(id);
            r = ctx.alarm;
          } catch (e) {
            this.flash('未找到这条预警，可能已超出数据窗口', 'warn');
            return;
          }
        }
        if (!r) return;
        this.focusOn(r);
        this.ctxInfo = ctx;
        if (!ctx) this.loadContext(id);
        const i = this.latest.findIndex(x => x.id === id);
        this.cursor = i >= 0 ? i : -1;
        this.syncUrl();
      },
      async loadContext(id) {
        if (!id) return;
        const token = (this._ctxSeq || 0) + 1;   /* 不能写 ++this._x：首读 undefined 会得 NaN */
        this._ctxSeq = token;
        this.ctxLoading = true;
        this.ctxInfo = null;
        try {
          const j = await API.alarmContext(id);
          if (token === this._ctxSeq) this.ctxInfo = j;
        } catch (e) {
          if (token === this._ctxSeq) this.ctxInfo = null;
        } finally {
          if (token === this._ctxSeq) this.ctxLoading = false;
        }
      },
      /* ---------------- 悬浮联动 ---------------- */
      /* 走 pushMapHot：滚动中不动地图、静止时 70ms 合并（详见 charts.js） */
      setHot(id) {
        this.hotId = id;
        this.pushMapHot();
      },
      hoverRow(r) {
        this.setHot(r.id);
        const i = this.latest.findIndex(x => x.id === r.id);
        if (i >= 0) this.cursor = i;
      },
      leaveRow() { this.setHot(null); },
      /* 关注 / 收藏：置顶 + 高亮（右侧清单、放大明细里都能切） */
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

      /* ---------------- 跨页联动 ---------------- */
      /* 跳预警地图并下钻到该省：保留为二级动作（详情卡 / 工具条入口）。
         地图上的单击走的是 drillAt()（同页下钻），这里才是"换页去看完整现场" */
      drillProvince(name) {
        const p = this.regionFind(x => x.name === name);
        if (!p || !p.adcode) { this.flash('该省暂无更细的下钻数据'); return; }
        this.$emit('pick', { view: 'alarm', params: { adcode: String(p.adcode), name: name } });
      },
      /* 点城市排行 -> 预警地图并下钻到该市 */
      drillCity(c) {
        /* find 不到（该市当前时间窗 0 条预警，聚合里没有它）也会走到这里，
           兜底对象只有 name 没有 adcode —— 文案要跟"有数据但缺 adcode"区分开，
           实测点 0 条的市 flash「暂无下钻数据」会让人以为是坏了 */
        if (!c || !c.adcode) {
          this.flash((c && c.name ? '「' + c.name + '」' : '该市') +
            '当前时间窗内无预警记录，没有可下钻的详情');
          return;
        }
        this.$emit('pick', { view: 'alarm', params: { adcode: String(c.adcode), name: c.name } });
      },
      /* 地图上"下钻"的唯一入口（省 / 市共用），带防连跳守卫。
         为什么需要守卫：双击必然产生两次 click，而第一次单击已经把地图换成了
         省图 —— 第二次 click 的**同一个鼠标像素**在新地图上命中的是省内的某个市，
         不挡就会一次双击钻两级（实测「全国›四川›阿坝藏族羌族」，而且市一级是
         直接跳到预警地图页，看起来就是"双击乱跳"）。

         判据用「层级 + 名字 + 时间」，**不用落点**：
         下钻会让筛选状态条出现、地图容器整体上移，同一个鼠标位置的容器坐标
         会跟着变（实测 y 234 → 195），拿落点比对必然误判成"换了地方点"。
         ① 900ms 内又一次**更深**的下钻（省 → 市）→ 忽略：这就是双击的第二次 click；
         ② 900ms 内**同一个目标**再次下钻 → 忽略（幂等去重，赶在地图切换前的
            第二次 click 会重复请求同一次下钻）；
         ③ 其余一律放行 —— 所以"点完一个省马上点另一个省"不会被无谓吃掉。
         900ms = Windows「双击速度」设置的可调上限（200~900ms）。 */
      drillAt(name, asCity, px) {
        const now = Date.now();
        const last = this._lastDrill;
        if (last && (now - last.t) < 900) {
          const deeper = asCity && !last.asCity;
          const same = (!!asCity === !!last.asCity) && name === last.name;
          if (deeper || same) return;
        }
        this._lastDrill = { t: now, name: name, asCity: !!asCity, px: px || null };
        if (asCity) this.drillCity(this.cityAgg.find(c => c.name === name) || { name });
        else this.drillProvinceIn(name);
      },
      /* 带着当前焦点跳到预警地图（那里有完整的"现场对照"与下钻） */
      openInAlarm() {
        if (!this.focus) return;
        this.$emit('pick', { view: 'alarm', params: { focus: this.focus.id } });
      },

      /* ---------------- 渲染 ---------------- */
      renderMap() {
        if (!this.mapName) return;
        /* ECharts 5.5.1 缺陷规避：同一实例上更换 geo.map 后 visualMap 着色永久
           失效（见 charts.js recreateChart 注释）—— 下钻/回全国换地图必须重建 */
        if (this._renderedMap && this._renderedMap !== this.mapName) {
          this.recreateChart('map');
        }
        this._renderedMap = this.mapName;
        /* 重建（实时刷新）要保住用户自己滚/缩出来的视野，不然每次推送都弹回全国。
           新建实例（下钻/回退）时 geoNow 为 null，自然落到新地图的默认视野 */
        const keepView = this.geoNow('map');
        const d = this.provAgg.filter(p => p.name);
        /* 性能：拆分 effectScatter，前 50 条最新保留 ripple，其余转 scatter */
        const all = this.mapPoints;
        const fresh = all.slice(0, 50);
        const rest = all.slice(50);
        const symSize = v => 5 + (v[2] || 0) * 1.1;
        const baseItem = {
          color: p => U.lvColor(p.data.level),
          borderColor: 'rgba(255,255,255,.5)', borderWidth: .5
        };
        /* 全国态：色块 = 省；下钻态：色块 = 省内各市（cityAgg） */
        const isDrill = !!this.drill;
        /* 「选中了某个具体等级」时色块改成**该等级条数**的连续着色：
           四色等级语义回答不了"这个等级哪儿最多"，条数色谱能一眼看出来。
           值本身由后端过滤保证（ctxQuery 已把 level 条件带进聚合请求）*/
        const byCount = !!this.activeLevel;
        const faceData = (isDrill ? this.cityAgg : this.provAgg)
          .filter(p => p.name).map(p => ({
            name: p.name,
            value: byCount ? (p.count || 0) : (p.max_rank || 0),
            count: p.count
          }));
        const cntMax = Math.max(1, faceData.reduce((m, x) => Math.max(m, x.value), 0));
        /* 面的暗色走 geo 原生逐区样式（T.faceColor / T.rampColor）：
           本页地图底面由 geo 组件绘制，map series 只提供数据，
           data 里的 itemStyle 不参与面着色；而 visualMap 要留给图例
           显示等级原色，不能再拿去给面上色（否则标点被同色面埋掉） */
        const faceRegions = faceData.map(x => ({
          name: x.name,
          itemStyle: {
            areaColor: byCount ? T.rampColor(x.value / cntMax) : T.faceColor(x.value)
          }
        }));
        this.setChart('map', T.mapOption(this.mapName, {
          geo: { zoom: 1.18, layoutCenter: ['50%', '54%'], layoutSize: '94%',
                 regions: faceRegions },
          /* 悬停高亮改成 DOM 覆盖层（.map-hoverdot，见 charts.js）：
             清单滚动时鼠标连掠多行，走 ECharts 必卡 */
          focus: this.focusMark, hover: [],
          tooltipOpt: {
            formatter: p => {
              if (p.seriesType === 'effectScatter' || p.seriesType === 'scatter') {
                const x = p.data;
                return `<b>${x.title}</b><br/>${U.shortName(x.issuer)}` +
                       `<br/>发布时间 ${x.time.slice(5)}` +
                       '<br/><span style="color:#7cf6d8">点击在地图上定位</span>';
              }
              const r = LEVEL_NAME[p.data && p.data.rank] || '无';
              const hint = isDrill
                ? '<br/><span style="color:#7cf6d8">单击去预警地图查看该市</span>'
                : '<br/><span style="color:#7cf6d8">单击下钻到该省</span>' +
                  '<span style="color:#8fa6c4">　·　滚轮 / ＋− 缩放</span>';
              if (byCount) {
                return `<b>${p.name}</b><br/><span style="color:${U.lvColor(this.activeLevel)}">` +
                       `${this.activeLevel}预警：<b>${p.value || 0}</b> 条</span>` +
                       (p.data && p.data.count
                         ? `<br/>该地共 <b>${p.data.count}</b> 条（各等级）` : '') + hint;
              }
              return `<b>${p.name}</b><br/>预警数量：<b style="color:#3fc6ff">${p.value || 0}</b> 条` +
                     (p.value ? `<br/>最高等级：<span style="color:${U.lvColor(r)}">${r}</span>` : '') + hint;
            }
          },
          series: [
            {
              type: 'map', map: this.mapName, geoIndex: 0, name: '最高预警等级',
              data: faceData,
              emphasis: { label: { show: false } }
            },
            {
              type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 3,
              name: '预警点位', data: rest, symbolSize: symSize,
              /* 不用 large/progressive：增量渲染层不响应 geo 漫游，缩放后点钉死 */
              itemStyle: Object.assign({ opacity: .78 }, baseItem),
              label: { show: false }
            },
            {
              type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 4,
              name: '最新预警', data: fresh, symbolSize: symSize,
              showEffectOn: 'render',
              rippleEffect: { brushType: 'stroke', scale: 2.6, period: 3.2 },
              /* 性能：shadowBlur 逐点开销极高且此层每帧都在重绘（涟漪），去掉 */
              itemStyle: Object.assign({
                borderColor: 'rgba(255,255,255,.75)', borderWidth: .6
              }, baseItem),
              label: { show: false }
            }
          ],
          /* 图例只作图例：等级模式的语义已由右栏 DOM 图例（亮色）承担，
             故不再重复显示；按条数模式给出"多/少"色带说明 */
          visualMap: byCount
            ? T.valueVisualMap(0, cntMax, T.C.faceRamp, {
                text: ['多', '少'], seriesIndex: [],
                /* 图例标题：告诉用户现在看的是"条数"而不是"等级" */
                textStyle: { color: U.lvColor(this.activeLevel), fontSize: 11 }
              })
            : undefined
        }));

        /* 重建后把视野拉回原处（否则每次实时刷新都会跳回全国） */
        if (keepView && keepView.center) this.geoApply('map', keepView.center, keepView.zoom);
        else if (this.focus) this.geoSet('map', this.focus.lng, this.focus.lat, this.focus.zoom);
        this.updateViewInfo();

        /* ---- 拖拽守卫 ----
           去掉"单击延迟"后必须挡住一种新误触：按住拖动地图平移（roam:true），
           松手时 zrender 仍会在光标落点下的省份上抛一个 click —— 于是"拖完地图"
           就变成"下钻到某个省"。记录按下/松开坐标，位移 > 6px 视为拖拽，忽略
           本次 click。真实单击的位移是 0，不受影响。 */
        this._bindDragGuard('map');

        /* ---- 点击 ----
           交互约定（与地图上写着的提示必须一致）：
           ・**单击省份色块 = 下钻**，立即执行。单击是最高频的动作，任何延迟
             都只会让人觉得"点了没反应"；
           ・**双击不再兼任"放大"**。双击天然包含一次单击，下钻若挂在单击上，
             双击就会连跳两级 —— 实测慢双击（间隔 320ms，仍在 Windows 双击窗口
             内）→ 先钻到四川、地图换成省图后第二次单击又命中阿坝 → 一路钻到市。
             用户看到的就是"双击乱跳 / 没放大"。现在双击省份 = 单击（靠
             drillAt 的守卫窗幂等，只下钻一级）；
           ・**双击地图空白（海洋 / 无省份处）= 以该点放大**：空白没有下钻语义，
             不会和任何动作打架，Shift+双击 = 缩小；
           ・缩放的正规入口：滚轮（向上放大）/ 右下 ＋−⌂ / 键盘 +−0 / 右键缩小。 */
        this.onChart('map', 'click', p => {
          if (this._wasDragged('map')) return;
          if (p.seriesType === 'scatter' || p.seriesType === 'effectScatter') {
            this.pickByPoint(p);
            return;
          }
          if (p.seriesType !== 'map' || !p.name) { this.clearFocus(); return; }
          this.drillAt(p.name, isDrill, this._evPx(p));
        });
        /* ---- 空白处手势（双击放大 / 右键缩小）挂在 zrender 层 ----
           为什么不能用 chart.on('dblclick') / on('contextmenu')：
           ECharts 只在事件"命中数据项"时才把事件转发到图表层（见 echarts
           `_initEvents`：target 解析不出 dataIndex / eventData 就不 trigger），
           于是"双击海面放大""右键海面缩小"这类**没有图元**的手势永远收不到
           事件 —— 实测点海面时 zrender 收到 1 次 dblclick，图表层收到 0 次，
           表现就是"双击空白毫无反应"。zr 层不做这层过滤，所以空白手势挂 zr。 */
        this._bindZrGestures('map');
        /* 地图 -> 清单：划过圆点，右侧清单自动滚到并高亮对应条目 */
        this.onChart('map', 'mouseover', p => {
          if (p.seriesType !== 'scatter' && p.seriesType !== 'effectScatter') return;
          const id = p.data && p.data.id;
          if (id && id !== this.hotId) { this.setHot(id); this.scrollToActive(); }
        });
        this.onChart('map', 'mouseout', () => this.setHot(null));
        /* 漫游/缩放后的收尾统一在 charts.js 的 setChart 里挂，见那里的注释 */
      },
      /* zrender 事件 -> 容器内像素坐标（锚点缩放用） */
      _evPx(p) {
        const e = p && p.event;
        const x = (e && (e.offsetX !== undefined ? e.offsetX : e.zrX)) || null;
        const y = (e && (e.offsetY !== undefined ? e.offsetY : e.zrY)) || null;
        return (x === null || y === null) ? null : [x, y];
      },
      /* 原生 zr 事件 -> 容器内像素坐标（zr 事件本身就是原生事件，属性平铺） */
      _zrPx(e) {
        if (!e) return null;
        const x = (e.offsetX !== undefined) ? e.offsetX : e.zrX;
        const y = (e.offsetY !== undefined) ? e.offsetY : e.zrY;
        return (x === undefined || y === undefined) ? null : [x, y];
      },
      /* 读 zr 事件的修饰键。坑：zrender 会把原生事件**归一化成一个新对象**
         （只有 zrX/zrY/offsetX/offsetY/pointerId…），修饰键不在它身上，
         而在 originalEvent（旧版叫 event）里 —— 直接读 e.shiftKey 永远是
         undefined，Shift+双击 会被静默当成普通双击（表现为"做了但没生效"）。
         实测：CDP 的 dispatchMouseEvent 带 modifiers 也不够，还得真按 Shift。 */
      _zrShift(e) {
        if (!e) return false;
        if (e.shiftKey) return true;
        const o = e.originalEvent || e.event;
        return !!(o && o.shiftKey);
      },
      /* 空白处手势：双击放大、右键缩小。
         挂 zrender 而不是图表层的原因见 renderMap 里的注释（ECharts 只转发
         命中了数据项的事件）。
         判定"空白"用 findHover：双击落点在**任何图元**上（省份色块 / 预警圆点）
         都不放大 —— 色块上的双击是"单击下钻"的地盘，圆点上的双击是"定位"的
         地盘，两边都不该被缩放抢走。右键不挑地方，随处都能缩小。 */
      _bindZrGestures(name) {
        const c = this.chart(name);
        if (!c) return;
        const zr = c.getZr();
        if (c.__zrGest) {
          Object.keys(c.__zrGest).forEach(ev => zr.off(ev, c.__zrGest[ev]));
        }
        const onNothing = e => {
          const px = this._zrPx(e);
          if (!px) return true;
          const hr = zr.findHover(px[0], px[1]);
          return !(hr && hr.target);
        };
        const h = {
          dblclick: e => {
            if (!onNothing(e)) return;
            this.zoomAt(name, this._zrShift(e) ? -1 : 1, this._zrPx(e));
          },
          contextmenu: e => {
            /* 顺手禁掉浏览器右键菜单（zr 事件就是原生事件，直接拦） */
            if (e && e.preventDefault) e.preventDefault();
            this.zoomAt(name, -1, this._zrPx(e));
          }
        };
        zr.on('dblclick', h.dblclick);
        zr.on('contextmenu', h.contextmenu);
        c.__zrGest = h;
      },
      /* 拖拽守卫：判定"这次 click 是不是拖动造成的"。
         地图 roam:true，按住拖动平移后松手，zrender 仍会在光标下的省份上抛
         click —— 不做这个判定，每次拖完地图都会莫名下钻一个省。
         状态按图表名分开存（主图 / 大图各自的按下点不能混）。 */
      _bindDragGuard(name) {
        this._drag = this._drag || {};
        this.onChart(name, 'mousedown', p => {
          this._drag[name] = { down: this._evPx(p), dragged: false };
        });
        this.onChart(name, 'mouseup', p => {
          const st = this._drag[name];
          if (!st) return;
          const up = this._evPx(p);
          if (st.down && up) {
            st.dragged = Math.abs(up[0] - st.down[0]) > 6 ||
                         Math.abs(up[1] - st.down[1]) > 6;
          }
        });
      },
      _wasDragged(name) {
        const st = (this._drag || {})[name];
        if (!st || !st.dragged) return false;
        st.dragged = false;
        return true;
      },
      /* ---------------- 视野信息条 ----------------
         拖拽/飞行期间每帧都会触发，用 rAF 合并到每帧最多算一次 */
      updateViewInfo() {
        if (this._viT) return;
        this._viT = requestAnimationFrame(() => {
          this._viT = null;
          const c = this._charts.map;
          if (!c || c.isDisposed()) return;
          const g = this.geoParts('map');
          const v = this.geoNow('map');
          if (!g || !v || !v.center) return;
          let span = null;
          try {
            const a = g.cs.pointToData([0, 0]);
            const b = g.cs.pointToData([c.getWidth(), c.getHeight()]);
            if (a && b) span = [+Math.abs(b[0] - a[0]).toFixed(1), +Math.abs(b[1] - a[1]).toFixed(1)];
          } catch (e) { /* ignore */ }
          this.viewInfo = {
            zoom: +v.zoom.toFixed(2),
            ctr: v.center[0].toFixed(1) + '°E,' + v.center[1].toFixed(1) + '°N',
            span: span ? span[0] + '°×' + span[1] + '°' : '—'
          };
        });
      },
      /* charts.js 的漫游/飞行收尾钩子：视野一动就把信息条跟上 */
      afterGeoRoam() { this.updateViewInfo(); },
      afterGeoFly() { this.updateViewInfo(); },
      /* 缩放按钮 / 键盘入口 */
      zoomIn() { this.zoomStep('map', 1); },
      zoomOut() { this.zoomStep('map', -1); },
      /* 悬停圆环的像素位置（DOM 覆盖层定位用） */
      hoverPx() {
        const r = this.latestAll.find(x => x.id === this.hotId);
        if (!r || r.lng === null || r.lng === undefined) return null;
        return this.geoPointToPx('map', r.lng, r.lat);
      },
      renderLevel() {
        const data = this.levels.filter(l => l.count > 0).map(l => ({
          name: l.name, value: l.count,
          itemStyle: { color: U.lvColor(l.name), cursor: 'pointer' }
        }));
        this.setChart('level', T.pie(data, {
          legend: true, center: ['50%', '46%'], radius: ['44%', '68%'],
          labelFmt: '{b}\n{c} 条'
        }));
        /* 点环图某个等级 → 放大看这个等级的具体情况（用户最初提的诉求） */
        this.onChart('level', 'click', p => {
          if (p && p.name) this.openBig('level', p.name);
        });
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
        this.setChart('trend', this.trendOption(this.series, 0));
        /* 大层开着就让它跟着走：大小两张趋势图**必须看同一份数据**。
           （原来这里只重画小面板，大层停在打开那一刻的 series，
             刷选/换筛选之后两图对不上。）
           ⚠ 但正在拖时间窗（还有待提交的窗口）时绝不碰大层 ——
           拖动中途整图重建会打断 ECharts 的 dataZoom 拖拽，手感直接死掉。 */
        if (this.big && this.big.kind === 'trend' && !this._winPending) this.renderBigTrend();
      },
      /* 趋势图 option（小面板与大层共用）。
         ⚠ 趋势图的查询**不带时间窗**：它是"时间轴选择器"，
         刷选后自己塌缩成只剩所选区间就没法再往外拖了。
         小面板没有 dataZoom，靠 markArea 高亮当前窗口；
         大层的窗口**就是滑块本身**，所以不再画 markArea。 */
      trendOption(series, big) {
        const b = series.buckets || [];
        const s = (series.series || []).map(x => ({
          name: x.name, color: x.color || U.lvColor(x.name), data: x.data
        }));
        const o = T.line(b, s, {
          rotate: 0, smooth: false, showSymbol: !!big, yName: '条 / 小时'
        });
        if (big) {
          o.grid = { left: 56, right: 28, top: 34, bottom: 58, containLabel: true };
          /* dataZoom 走 ECharts 默认的 filterMode:'filter'（缩放时按可见子集重算 y 轴）。
             "形态稳定"靠的是数据不随窗口变（见 seriesQuery），不是把 y 轴钉死；
             试过 'none'，会把 y 轴算崩成 [0,1]。
             ⚠ 也试过 animation:false / showDataShadow:false 想给拖动减负，
             CDP 交错实测（开 GPU，中位帧时）12.4ms vs 12.6ms —— **没有差别**，
             所以没留：入场动画和滑块里的形态预览都还回去了。 */
          o.dataZoom = [
            { type: 'inside', xAxisIndex: 0 },
            { type: 'slider', xAxisIndex: 0, height: 20, bottom: 12,
              left: 56, right: 28, borderColor: 'transparent',
              backgroundColor: 'rgba(63,198,255,.06)', fillerColor: 'rgba(63,198,255,.15)',
              handleSize: '110%', handleStyle: { color: '#3fc6ff' },
              textStyle: { color: '#8fa6bf', fontSize: 10 } }
          ];
        } else if (this.win) {
          o.series = o.series.concat([this._winMarkSeries()]);
        }
        return o;
      },
      /* 一条不参与交互的辅助系列，只用来承载"当前时间窗"的 markArea。
         **只给小面板用**（它没有 dataZoom，需要一个画在图上的高亮）。
         ⚠ 两个纪律，都踩过：
         ① 只允许在整图重画（trendOption）时带上它。曾经用它做增量更新
            （setOption 合并进已渲染的图），合并那一刻大层 y 轴从 [0,3] 塌成 [0,1]，
            四条线全被顶出画面；
         ② 别给大层加它。大层的窗口就是滑块选区，重复画一遍只是每帧多一份开销，
            而且会让这个可拖拽的图多一条"幽灵系列"影响交互。 */
      _winMarkSeries() {
        const w = this.win;
        return {
          id: 'bigwin', name: '时间窗', type: 'line', data: [], silent: true,
          tooltip: { show: false }, showSymbol: false, z: 1,
          markArea: {
            silent: true, itemStyle: { color: 'rgba(63,198,255,.10)' },
            label: { show: false },
            data: w ? [[{ xAxis: w.since }, { xAxis: w.until }]] : []
          }
        };
      },

      /* ================= 放大浮层 =================
         用户的诉求原话："预警等级一栏就能放大看到具体情况"。
         做成两层：
         ① 面板级放大 —— 每个面板标题栏的 ⤢ 打开同一份数据的"大画布"版本
            （更大的图 + 更多条目 + 更细的标注）；
         ② 维度详情 —— 点等级环/等级图例/等级 chip 的 ⤢，把"这一维的某个值"
            摊开成 指标卡 ×6 + 省份分布 + 另一维构成 + 时间演化 + 逐条清单，
            并且能在层内继续下钻（点省份 -> 下钻该省 / 点条目 -> 地图定位）。
         数据全部由 4 个并行聚合请求拼成，不动后端。 */
      bigTitle(kind, key) {
        const scope = this.drill ? this.drill.name : '全国';
        if (kind === 'level') return { title: key + '预警 · 详情', sub: scope + '及全国分布 · 数据实时' };
        if (kind === 'type') return { title: key + ' · 详情', sub: scope + '及全国分布 · 数据实时' };
        if (kind === 'province') return { title: '省级预警排行', sub: 'TOP 30 · 点击省份下钻' };
        if (kind === 'city') return { title: '城市预警排行', sub: 'TOP 30 · 点击城市查看' };
        if (kind === 'trend') return { title: '预警时间演化 · 刷选', sub: '拖选区间 = 全页按时间过滤' };
        if (kind === 'list') return { title: '预警明细清单', sub: '当前筛选结果 · 点击在地图上定位' };
        if (kind === 'map') return { title: '全国预警态势 · 大图', sub: '单击省份下钻 · 滚轮/＋− 缩放 · 双击空白处放大' };
        return { title: '详情', sub: '' };
      },
      async openBig(kind, key, ev) {
        /* 上一层的关闭动画若还在收尾（fill:forwards 的透明度还挂着），先掐掉再开新层 */
        this._bigClosing = false;
        this._bigAnims(null);
        document.body.style.overflow = 'hidden';   // 浮层打开期间锁住背景页滚动
        const t = this.bigTitle(kind, key);
        /* from = 点击来源（缩略图面板 / KPI 卡）的视口矩形，供 _bigIn 做 FLIP；
           深链、点环图等没有 DOM 事件时是 null，退化为居中缩放 */
        this.big = { kind: kind, key: key || '', title: t.title, sub: t.sub,
                     from: Motion.source(ev, '.panel, .kpi') };
        this.bigDetail = null;
        if (kind === 'level' || kind === 'type') this.bigLoading = true;
        this._bigDropCharts();
        await this.$nextTick();
        /* 卡片一进 DOM 就播放大动画（不等数据），"从缩略图长出来"最顺；
           异步数据的详情层靠 .bv-card 的 min-height 兜底，落点不塌 */
        this._bigIn();
        if (kind === 'level' || kind === 'type') await this.loadBigDetail(kind, key);
        else if (kind === 'trend') this.renderBigTrend();
        else if (kind === 'province' || kind === 'city') this.renderBigRank(kind);
        else if (kind === 'map') this.renderBigMap();
        /* list 是纯 DOM 列表，不需要图表 */
        this.$nextResize();
      },
      /* FLIP：把卡片从来源矩形"长"到全屏。无来源（深链）时退化为居中轻微缩放。
         几何计算与关键帧在 motion.js（总览放大层与站点页弹窗共用一套）。
         用 WAAPI 而非 CSS animation：起点/终点是运行时量出来的，写不进样式表。 */
      _bigIn() {
        const card = this.$el && this.$el.querySelector('.bv-card');
        if (!card || !this.big) return;
        this._bigAnims([Motion.play(card, Motion.inFrames(card, this.big.from),
                                    Motion.IN_DUR, Motion.EASE_IN)]);
      },
      /* 关闭：反向缩回来源矩形（或轻微缩小淡出）。播完再真正卸载 DOM ——
         旧版"打开有动画、关闭瞬间消失"，前后不对称就是生硬感的另一半。
         动画用 fill:forwards：Vue leave 过渡期间保持透明，不会闪回一帧不透明。 */
      closeBig() {
        if (!this.big || this._bigClosing) return;
        this._bigClosing = true;
        const view = this.$el && this.$el.querySelector('.bigview');
        const card = view && view.querySelector('.bv-card');
        const finish = () => {
          if (!this._bigClosing) return;             // 已被 openBig 接管（新开一层）
          this._bigClosing = false;
          this._bigAnims(null, true);                // 只丢引用，别 cancel（防闪回一帧）
          document.body.style.overflow = '';         // 解除滚动锁
          /* 地图大图退出时把焦点图层收掉，别在主地图上留一个"大图才有的"标记 */
          this.big = null;
          this.bigDetail = null;
          this._bigDropCharts();
          /* 放大层开着期间被"跳过重画"的主地图在这里补上（见 applyFilters）。 */
          if (this._mapDirty) { this._mapDirty = false; this.renderMap(); }
          this.syncUrl();
        };
        if (!view || !card || Motion.reduce()) { finish(); return; }
        const anims = [
          Motion.play(view, Motion.fadeFrames(false), Motion.OUT_DUR, 'linear', 'forwards'),
          Motion.play(card, Motion.outFrames(card, this.big.from), Motion.OUT_DUR, Motion.EASE_OUT, 'forwards')
        ];
        this._bigAnims(anims);
        /* finished 不 resolve 的极端情况（页签后台被节流）用超时兜底，保证一定能关掉 */
        Motion.whenDone(anims, finish);
        this._bigCloseT = setTimeout(finish, 900);
      },
      /* 记住当前浮层的 WAAPI 动画句柄。openBig 接管时要掐掉还没收尾的关闭动画
         （旧 fill:forwards 的透明度会把新层压住）；finish 卸载前**只丢弃引用**、
         不 cancel 已完成的动画 —— cancel 会让 opacity 弹回 1，在 Vue 卸载前闪一帧 */
      _bigAnims(list, dropDone) {
        if (this._bigAnimList) this._bigAnimList.forEach(a => {
          if (!a) return;
          try {
            if (dropDone && a.playState === 'finished') return;
            a.cancel();
          } catch (e) {}
        });
        this._bigAnimList = (list || []).filter(Boolean);
        if (!list || !this._bigAnimList.length) clearTimeout(this._bigCloseT);
      },
      _bigDropCharts() {
        ['bigProv', 'bigType', 'bigLine', 'bigMap', 'bigRank'].forEach(n => this.recreateChart(n));
      },

      /* ---------------- 维度详情（等级 / 灾种） ---------------- */
      /* 详情层的查询：跨省对比（丢掉下钻限制），聚合维度不自锁，
         自身维度用 key 精确锁定。时间窗 / 灾种这类"外部筛选"保留。 */
      detailQuery(dim) {
        const q = Object.assign({}, this.filterQuery());
        delete q.province;
        if (dim) delete q[dim];
        q[this.big.kind] = this.big.key;
        return q;
      },
      async loadBigDetail(kind, key, silent) {
        if (!silent) this.bigLoading = true;
        const other = kind === 'level' ? 'type' : 'level';
        try {
          const [prov, oth, sers, recs] = await Promise.all([
            API.alarmAgg(Object.assign({ dim: 'province', top: 30 }, this.detailQuery('province'))),
            API.alarmAgg(Object.assign({ dim: other, top: 20 }, this.detailQuery(other))),
            API.alarmSeries(Object.assign({ bucket: 'hour' }, this.detailQuery(''))),
            API.alarms(Object.assign({ limit: ALARM_LIMIT }, this.detailQuery('')))
          ]);
          const recs2 = recs.records || [];
          const ts = recs2.map(r => r.ts).filter(Boolean).sort();
          /* 用接口的 total，别用数组长度（被 ALARM_LIMIT 截断后就不是命中数了） */
          const total = (recs.total === undefined) ? recs2.length : recs.total;
          this.bigDetail = {
            kind: kind, key: key,
            total: total,
            provs: (prov.data || []).filter(x => x.name),
            others: (oth.data || []).filter(x => x.name),
            series: sers,
            recs: recs2,
            provCount: (prov.data || []).filter(x => x.name).length,
            otherCount: (oth.data || []).filter(x => x.name).length,
            issuerCount: Object.keys(U.groupBy(recs2, r => r.issuer)).length,
            span: ts.length ? [ts[0], ts[ts.length - 1]] : null,
            /* 占比口径：该等级/灾种条数 ÷ 当前筛选下的总条数（等级分布求和） */
            sharePct: this._shareOf(total)
          };
          if (!silent) await this.$nextTick();
          this.renderBigDetail();
        } catch (e) {
          this.bigDetail = null;
        } finally {
          if (!silent) this.bigLoading = false;
        }
      },
      _shareOf(total) {
        const sum = (this.levels || []).reduce((m, x) => m + (x.count || 0), 0);
        if (!sum || !total) return null;
        return Math.min(100, (total / sum) * 100);
      },
      renderBigDetail() {
        const d = this.bigDetail;
        if (!d) return;
        const isLv = d.kind === 'level';
        const main = isLv ? U.lvColor(d.key) : U.typeColor(d.key);
        /* 省份分布：横向条，颜色 = 该维度值的主色，点击 -> 下钻该省 */
        const p = d.provs.slice(0, 15).reverse();
        this.setChart('bigProv', T.bar(p.map(x => U.shortName(x.name)), p.map(x => x.count), {
          horizontal: true, color: main, barWidth: 13, unit: '条', seriesName: d.key + '预警',
          grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true }
        }));
        this.onChart('bigProv', 'click', ev => this._bigProvPick(ev));
        /* 另一维构成：等级详情 -> 看灾种；灾种详情 -> 看等级 */
        const oth = d.others.slice(0, 10);
        this.setChart('bigType', T.pie(
          oth.map(x => ({
            name: x.name, value: x.count,
            itemStyle: { color: isLv ? U.typeColor(x.name) : U.lvColor(x.name) }
          })),
          { radius: ['46%', '72%'], center: ['50%', '46%'], labelFmt: '{b} {c} 条' }
        ));
        /* 时间演化：该维度值自己的曲线（单色，比四色堆叠更聚焦） */
        const b = (d.series.buckets) || [];
        const s = (d.series.series || []).map(x => ({ name: x.name, color: main, data: x.data }))
          .filter(x => x.data.some(v => v > 0));
        this.setChart('bigLine', T.line(b, s.length ? s : [{ name: d.key, color: main, data: b.map(() => 0) }],
          { yName: '条 / 小时', showSymbol: b.length < 40 }));
      },
      _bigProvPick(ev) {
        const name = ev && ev.name;
        if (!name) return;
        const hit = this.bigDetail && this.bigDetail.provs.find(x => U.shortName(x.name) === name || x.name === name);
        const real = hit ? hit.name : name;
        this.closeBig();
        /* 层内点省份 -> 直接下钻过去（这正是"继续往下看"的路径） */
        this.drillProvinceIn(real);
      },

      /* ---------------- 趋势放大层 + 时间刷选 ---------------- */
      renderBigTrend() {
        if (!this.series) return;
        const o = this.trendOption(this.series, true);
        this._zoomFromWin(o);
        this.setChart('bigLine', o);
        /* 刷选 -> 全页时间窗。拖动事件连发，120ms 节流只用来记账（见 _stageWin），
           真正的重活由 _stageWin 内部 620ms 防抖后再提交。 */
        const onZoom = this._zoomDeb = U.debounce(e => this._onTrendZoom(e), 120);
        this.onChart('bigLine', 'dataZoom', onZoom);
      },
      /* 大层的缩放范围 = 当前时间窗（单一真源）。
         为什么不"读回旧视野再恢复"：窗口已经完整表达了缩放位置，多一个状态源就会
         在"窗口从深链来 / 从拖拽来"两条路之间打架。setChart 是 notMerge，
         重画后按窗口重算一遍最省心。
         桶是等距补密的（后端 densify_buckets），所以 index 就是小时序号。 */
      _zoomFromWin(o) {
        const b = (this.series && this.series.buckets) || [];
        const n = b.length;
        if (!o.dataZoom || n < 2) return;
        let s = 0, e = 100;
        if (this.win) {
          let i0 = -1;
          for (let i = 0; i < n; i++) { if (b[i] >= this.win.since) { i0 = i; break; } }
          let i1 = -1;
          for (let i = n - 1; i >= 0; i--) { if (b[i] <= this.win.until) { i1 = i; break; } }
          if (i0 >= 0 && i1 >= i0) { s = i0 / (n - 1) * 100; e = i1 / (n - 1) * 100; }
        }
        o.dataZoom.forEach(d => { d.start = s; d.end = e; });
      },
      /* 刷选 -> 全页时间窗。
         桶序列是等距补密过的（见后端 densify_buckets），且趋势图恒取全量，
         所以 index ↔ 时间 的映射稳定，不会像以前那样"划的位置和落下的窗口对不上"。
         ⚠ 这里只记账（_stageWin），**一个接口都不发、一张图都不重画** ——
         拖动期间每帧都发 5 个接口 + 重画全国地图，是"越拖越卡"的直接原因。 */
      _onTrendZoom(e) {
        const b = (this.series && this.series.buckets) || [];
        const n = b.length;
        if (n < 2) return;
        const z = (e && e.batch && e.batch.length) ? e.batch[0] : (e || {});
        let i0 = z.startIndex, i1 = z.endIndex;
        if (i0 === undefined || i1 === undefined) {
          if (z.start === undefined || z.end === undefined) return;
          i0 = Math.round(z.start / 100 * (n - 1));
          i1 = Math.round(z.end / 100 * (n - 1));
        }
        i0 = Math.max(0, Math.min(n - 1, i0));
        i1 = Math.max(0, Math.min(n - 1, i1));
        /* 划空 / 划到全量 = 取消时间窗 */
        if (i1 <= i0 || (i0 === 0 && i1 === n - 1)) { this._stageWin(null); return; }
        this._stageWin(b[i0], this._bucketEnd(b[i1]));
      },
      /* 分桶右边界：'2026-09-29 08:00'(小时桶) -> '2026-09-29 08:59:59' */
      _bucketEnd(b) {
        if (!b) return b;
        if (b.length === 13) return b + ':59:59';            /* YYYY-MM-DD HH */
        if (b.length === 16) return b.slice(0, 14) + '59:59'; /* YYYY-MM-DD HH:00 */
        if (b.length === 10) return b + ' 23:59:59';          /* YYYY-MM-DD */
        return b;
      },

      /* ---------------- 排行 / 清单放大层 ---------------- */
      renderBigRank(kind) {
        const isCity = kind === 'city';
        const src = (isCity ? this.cityAgg : this.provAgg).filter(x => x.name).slice(0, 30);
        const p = src.slice().reverse();
        this.setChart('bigRank', T.bar(p.map(x => U.shortName(x.name)), p.map(x => x.count), {
          horizontal: true, colors: p.map(x => U.lvColor(LEVEL_NAME[x.max_rank] || '未知')),
          barWidth: 14, unit: '条', seriesName: '预警条数',
          grid: { left: 8, right: 60, top: 10, bottom: 10, containLabel: true }
        }));
        this.onChart('bigRank', 'click', ev => {
          const name = ev && ev.name;
          if (!name) return;
          const hit = src.find(x => U.shortName(x.name) === name || x.name === name);
          if (!hit) return;
          this.closeBig();
          if (isCity) this.drillCity(hit); else this.drillProvinceIn(hit.name);
        });
      },
      /* 地图大图：主地图那套 option 的"大画布"版本 */
      renderBigMap() {
        if (!this.mapName) return;
        this.recreateChart('bigMap');
        const isDrill = !!this.drill;
        const byCount = !!this.activeLevel;
        const face = (isDrill ? this.cityAgg : this.provAgg).filter(p => p.name).map(p => ({
          name: p.name, value: byCount ? (p.count || 0) : (p.max_rank || 0)
        }));
        const all = this.mapPoints;
        const symSize = v => 5 + (v[2] || 0) * 1.1;
        /* 面的暗色同主图：走 geo 逐区样式，visualMap 只留作图例 */
        const cntMax = Math.max(1, face.reduce((m, x) => Math.max(m, x.value), 0));
        const faceRegions = face.map(x => ({
          name: x.name,
          itemStyle: {
            areaColor: byCount ? T.rampColor(x.value / cntMax) : T.faceColor(x.value)
          }
        }));
        this.setChart('bigMap', T.mapOption(this.mapName, {
          geo: { zoom: 1.18, layoutCenter: ['50%', '53%'], layoutSize: '96%',
                 regions: faceRegions },
          tooltipOpt: {
            formatter: p => {
              if (p.seriesType === 'scatter' || p.seriesType === 'effectScatter') {
                return '<b>' + p.data.title + '</b><br/>' + U.shortName(p.data.issuer) +
                       '<br/>发布时间 ' + p.data.time.slice(5) +
                       '<br/><span style="color:#7cf6d8">点击定位</span>';
              }
              return '<b>' + p.name + '</b><br/>预警 ' + (p.value || 0) + ' 条';
            }
          },
          series: [
            { type: 'map', map: this.mapName, geoIndex: 0, name: '预警态势',
              data: face, emphasis: { label: { show: false } } },
            { type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 3,
              name: '预警点位', data: all, symbolSize: symSize,
              itemStyle: { opacity: .82, color: p => U.lvColor(p.data.level),
                           borderColor: 'rgba(255,255,255,.5)', borderWidth: .5 },
              label: { show: false } }
          ],
          visualMap: byCount
            ? T.valueVisualMap(0, cntMax, T.C.faceRamp,
                               { text: ['多', '少'], seriesIndex: [] })
            : T.levelVisualMap({ seriesIndex: [] })
        }));
        /* 大图与主图保持同一套手势语义（提示文案才对得上）：
           点圆点 -> 关层回主视图定位；点省份 -> 关层并下钻；
           空白处双击 -> 放大；右键 -> 缩小（同样挂 zr 层，见 _bindZrGestures）。 */
        this._bindDragGuard('bigMap');
        this._bindZrGestures('bigMap');
        this.onChart('bigMap', 'click', p => {
          if (this._wasDragged('bigMap')) return;
          if (p.seriesType === 'scatter') {
            const r = this.latestAll.find(x => x.id === (p.data && p.data.id));
            if (!r) return;
            this.closeBig();
            this.pickRow(r);
            return;
          }
          if (p.seriesType !== 'map' || !p.name) return;
          const isDrill = !!this.drill;
          this.closeBig();
          this.drillAt(p.name, isDrill, this._evPx(p));
        });
      },
      /* 层内清单点击 -> 关闭层 + 主地图定位 */
      pickFromBig(r) {
        this.closeBig();
        this.pickRow(r);
      },
      /* 详情层主按钮：把"这一维的这个值"作为筛选条件应用到整个总览页 */
      async bigFilterSelf() {
        const k = this.big.kind, v = this.big.key;
        this.closeBig();
        if (k === 'level') { this.minRank = 0; this.activeLevel = v; }
        else if (k === 'type') { this.activeType = v; }
        await this.applyFilters();
        this.flash('已筛选：' + (k === 'level' ? v + '预警' : v) + ' · ' +
                   this.latestAll.length + ' 条', 'ok');
      },
      lvClass: U.lvClass,
      shortName: U.shortName,
      /* 刚入库（10 分钟内）的预警打上 NEW 徽标 —— 让"实时"看得见 */
      isNewOne(r) { return U.isNew(r.ingested_at, 10); }
    },
    template: `
    <div class="grid g-ov">
      <!-- KPI：每张卡都能点（点进去就是"这一格数字背后的明细"） -->
      <div class="sp-12 kpi-row" style="grid-template-columns:repeat(6,1fr)">
        <div class="kpi clickable" style="--accent:#3fc6ff" @click="openBig('list', '', $event)"
             title="查看预警明细清单">
          <div class="k-label">{{ activeOnly ? '实时预警信号' : '预警信号总量' }}</div>
          <div class="k-value"><span v-countup="kpiView.alarm_total"></span><small>条</small></div>
          <div class="k-foot">{{ activeOnly ? activeLabel : '含已失效历史' }}<span class="k-go">明细 ›</span></div>
        </div>
        <div class="kpi clickable" style="--accent:#7cf6d8" @click="openBig('province', '', $event)"
             title="查看省级预警排行（可下钻）">
          <div class="k-label">覆盖省级行政区</div>
          <div class="k-value"><span v-countup="kpiView.province_count"></span><small>个</small></div>
          <div class="k-foot">涉及 {{ kpiView.city_count }} 个地市<span class="k-go">排行 ›</span></div>
        </div>
        <div class="kpi clickable" style="--accent:#ff8a00" :class="{picked: minRank>0}"
             @click="setTier()"
             :title="minRank ? '取消「橙色及以上」筛选' : '一键筛选出橙色及以上预警'">
          <div class="k-label">橙色及以上</div>
          <div class="k-value"><span v-countup="kpiView.red_orange"></span><small>条</small></div>
          <div class="k-foot">需重点关注的致灾性天气
            <span class="k-go">{{ minRank ? '取消筛选 ✕' : '一键筛选 ›' }}</span></div>
        </div>
        <div class="kpi clickable" style="--accent:#b48bff" @click="openBig('type', '', $event)"
             title="查看灾种构成明细">
          <div class="k-label">预警发布单位</div>
          <div class="k-value"><span v-countup="kpiView.issuer_count"></span><small>家</small></div>
          <div class="k-foot">省 / 市 / 县三级气象台<span class="k-go">灾种 ›</span></div>
        </div>
        <div class="kpi clickable" style="--accent:#41d6c3"
             @click="$emit('pick', { view: 'station' })" title="进入气象站点视图">
          <div class="k-label">气象观测站点</div>
          <div class="k-value"><span v-countup="kpi.station_total"></span><small>个</small></div>
          <div class="k-foot">有效观测 {{ U.num(kpi.obs_valid) }} 条<span class="k-go">站点页 ›</span></div>
        </div>
        <div class="kpi clickable" style="--accent:#ffb648"
             @click="$emit('pick', { view: 'typhoon' })" title="进入台风路径视图">
          <div class="k-label">台风路径</div>
          <div class="k-value"><span v-countup="kpi.typhoon_total"></span><small>个</small></div>
          <div class="k-foot">{{ U.num(kpi.typhoon_points) }} 个路径点<span class="k-go">台风页 ›</span></div>
        </div>
      </div>

      <!-- 筛选状态条：把"我现在筛了什么、命中多少"摆在明面上，一键可撤。
           口径不是默认值时也显示（否则切到"含历史"后这条会整个消失，
           连"命中 4,705 条（图上取最新 800 条）"都没了，用户看不出被截断） -->
      <div class="sp-12 filter-bar"
           v-if="activeType || activeLevel || minRank || win || drill || !activeOnly">
        <span class="fb-label">当前筛选</span>
        <span class="fb-chip" v-if="drill">地区：{{ drill.name }}<b @click="exitProvince">✕</b></span>
        <span class="fb-chip" v-if="activeType">灾种：{{ activeType }}<b @click="setType(activeType)">✕</b></span>
        <span class="fb-chip" v-if="activeLevel"
              :style="{ borderColor: U.lvColor(activeLevel), color: U.lvColor(activeLevel) }">
          等级：{{ activeLevel }}<b @click="setLevel(activeLevel)">✕</b></span>
        <span class="fb-chip" v-if="minRank">橙色及以上<b @click="setTier()">✕</b></span>
        <span class="fb-chip" v-if="win">时间：{{ win.label }}<b @click="clearWindow">✕</b></span>
        <span class="fb-chip" v-if="!activeOnly">时效：含已失效历史<b @click="toggleActive">✕</b></span>
        <span class="fb-total">命中 <b>{{ hitTotal }}</b> 条<template
          v-if="latestAll.length < hitTotal">（图上取最新 {{ latestAll.length }} 条）</template></span>
        <button class="btn ghost fb-clear" @click="clearAllFilters">清除全部</button>
      </div>

      <!-- 地图 -->
      <div class="sp-8 panel">
        <div class="panel-head">
          <h3>全国预警态势图</h3>
          <!-- 时效口径开关：当前生效（默认）<-> 含已失效历史。
               做成常驻按钮而不是筛选 chip —— 它是"我们说的是哪批数据"，不是筛选项 -->
          <button class="btn ghost cal-chip" :class="{hist: !activeOnly}"
                  @click="toggleActive"
                  :title="activeOnly
                    ? '当前只显示今天（北京时间）发布且本轮仍生效的预警（' + activeLabel + '）。点击查看近 15 天含已失效的全部预警'
                    : '当前显示近 15 天全部预警（含已失效），仅用于对照与排查。点击切回当前生效'">
            时效：{{ activeOnly ? '今日生效' : '含历史' }}<i v-if="activeOnly"
              :class="{ 'cal-stale': isStale }"
              :title="isStale ? '预警采集已停摆，地图上的点是这一轮的旧数据' : ''">· {{ isStale ? scanAge(scanAt) : hm(scanAt) }}</i>
          </button>
          <!-- 地图色块的语义必须和口径一起说清：
               生效口径下色块与点是同一批数据；含历史口径下色块是近 15 天累计、
               点只画最近 800 条 —— 不写明白就又是一次"两套口径"的误解 -->
          <span class="sub" v-if="activeOnly">{{ drill ? '省级视图 · 色块 = 该省各市' + (activeLevel ? '「' + activeLevel + '」条数' : '最高预警等级') : (activeLevel ? '色块 = 各省「' + activeLevel + '」条数（' + activeLevel + '越多越红）' : '色块 = 该省最高预警等级（单击下钻）') }}　圆点 = 预警落区（点击定位）　滚轮 / ＋− 缩放</span>
          <span class="sub" v-else>含历史口径 · 色块 = {{ drill ? drill.name + '各市' : '各省' }}近 15 天{{ activeLevel ? '「' + activeLevel + '」条数' : '最高预警等级' }}累计　圆点 = 最近 {{ latestAll.length }} 条落区　滚轮 / ＋− 缩放</span>
          <button class="ph-zoom" @click="openBig('map', '', $event)" title="放大地图到全屏">⤢</button>
        </div>
        <div class="panel-body map-wrap" style="padding:0">
          <div class="map-tools">
            <template v-if="drill">
              <span class="crumb"><span @click="exitProvince">全国</span><i>›</i><span class="cur">{{ drill.name }}</span></span>
              <button class="btn ghost reset-view" @click="exitProvince"
                      title="回到全国态势（Esc）">返回全国</button>
              <button class="btn ghost reset-view" @click="drillProvince(drill.name)"
                      title="跳转到预警地图页，查看该省逐条预警与下钻">在预警地图中打开</button>
            </template>
            <template v-if="focus">
              <span class="view-tag">⊙ 已定位：{{ focus.label }}</span>
              <button class="btn ghost reset-view" @click="resetView"
                      title="回到全国视野并收起详情（Esc）">复位视野</button>
            </template>
          </div>
          <div class="chart" ref="map"></div>

          <!-- 当天没有匹配预警时展示空态，历史记录通过主动切换查看。 -->
          <div class="map-empty"
               v-if="!loading && !latestAll.length">
            <b>{{ emptyTitle }}</b>
            <span v-if="activeOnly">{{ activeLabel }}</span>
            <span v-else-if="!activeOnly">当前筛选条件下没有任何记录</span>
            <button class="btn ghost" v-if="activeOnly" @click="toggleActive">看近 15 天历史 ›</button>
          </div>

          <!-- 缩放控件：显式按钮没有"方向反了"的歧义。
               滚轮向上=放大、右键=缩小、键盘 +/−/0 同此；
               双击只在**地图空白处**放大（省份面上双击 = 单击 = 下钻） -->
          <div class="map-zoombar">
            <button class="mz-btn" @click="zoomIn" title="放大（滚轮向上 / 键盘 +）">＋</button>
            <button class="mz-btn" @click="zoomOut" title="缩小（滚轮向下 / 右键 / 键盘 −）">−</button>
            <button class="mz-btn" @click="resetView" title="复位到全国视野（Esc / 键盘 0）">⌂</button>
          </div>

          <!-- 视野信息条：当前缩放倍率与可视范围，缩放是否有反馈一目了然 -->
          <div class="map-viewinfo" v-if="viewInfo"
               title="当前地图视野">🔍 {{ viewInfo.zoom }}×　中心 {{ viewInfo.ctr }}　跨度 {{ viewInfo.span }}</div>

          <!-- 浮动详情卡：点了一条预警，就在地图上把它的信息摆出来 -->
          <div class="map-card" v-if="focus">
            <div class="mc-top">
              <span class="badge" :class="lvClass(focus.level)">{{ focus.type }}{{ focus.level }}</span>
              <span v-if="focus.isNew" class="new-tag">NEW</span>
              <span class="mc-close" @click="clearFocus" title="关闭（Esc）">✕</span>
            </div>
            <div class="mc-title">{{ focus.title }}</div>
            <div class="mc-row">发布单位<b>{{ shortName(focus.issuer) }}</b></div>
            <div class="mc-row">发布时间<b>{{ focus.ts }}</b></div>
            <div class="mc-row">预警落区<b>{{ focus.place }}</b></div>
            <div class="mc-row">落区坐标<b>{{ focus.lng.toFixed(3) }}, {{ focus.lat.toFixed(3) }}</b></div>
            <div class="mc-row" v-if="ctxLoading">最近气象站<b>查询中 …</b></div>
            <div class="mc-row" v-else-if="ctxStation">最近气象站<b>{{ ctxStation }}</b></div>
            <div class="mc-row" v-else>最近气象站<b>暂无</b></div>
            <div class="mc-acts">
              <button class="btn" @click="openInAlarm()" title="去预警地图看完整现场对照与下钻">预警地图中打开</button>
              <button class="btn ghost" @click="resetView">复位</button>
            </div>
          </div>

          <div class="legend-box">
            <div class="legend-row" v-for="l in levels" :key="l.name" v-show="l.count>0">
              <span class="legend-swatch" :style="{background:U.lvColor(l.name)}"></span>
              <span>{{ l.name }}预警 · {{ l.count }} 条</span>
            </div>
          </div>
          <div v-if="loading" class="panel-loading"><div class="boot-ring"></div></div>
        </div>
      </div>

      <!-- 右侧：等级 + 灾种 -->
      <div class="sp-4 col-stack">
        <div class="panel" style="flex:1">
          <div class="panel-head"><h3>预警等级构成</h3>
            <span class="sub">{{ drill ? drill.name : '全国' }}口径 · 点环图放大</span>
            <button class="ph-zoom" @click="openBig('level', activeLevel || (levels[0] && levels[0].name) || '', $event)"
                    title="放大查看等级详情">⤢</button>
          </div>
          <div class="panel-body" style="padding:4px">
            <div class="chart" ref="level" style="height:calc(100% - 36px)"
                 title="点击某个等级 -> 放大查看它的省份分布 / 灾种构成 / 逐条清单"></div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin:5px 4px 2px">
              <span v-for="l in levels.filter(x=>x.count>0)" :key="l.name" class="chip"
                    :class="{on: activeLevel===l.name}"
                    :style="activeLevel===l.name
                      ? { background: U.lvColor(l.name), borderColor: 'transparent', color: '#0a1626' }
                      : { color: U.lvColor(l.name), borderColor: U.lvColor(l.name) }"
                    @click="setLevel(l.name)"
                    :title="'按「' + l.name + '」筛选全页（再点取消）'"
                    style="font-size:11px;padding:3px 8px">{{ l.name }} {{ l.count }}
                <b class="chip-zoom" @click.stop="openBig('level', l.name, $event)"
                   title="放大查看该等级详情">⤢</b></span>
            </div>
            <div v-if="loading" class="panel-loading"><div class="boot-ring"></div></div>
          </div>
        </div>
        <div class="panel" style="flex:1.1">
          <div class="panel-head"><h3>灾种分布</h3><span class="sub">点击可在地图上过滤</span>
            <button class="ph-zoom" @click="openBig('type', activeType || (types[0] && types[0].name) || '', $event)"
                    title="放大查看灾种详情">⤢</button>
          </div>
          <div class="panel-body" style="padding:4px 8px 6px">
            <div class="chart" ref="typeTop" style="height:calc(100% - 34px)"></div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:6px">
              <span v-for="t in types.slice(0,5)" :key="t.name" class="chip"
                    :class="{on: activeType===t.name}" @click="setType(t.name)"
                    :title="'按「' + t.name + '」筛选（再点取消）'"
                    style="font-size:11px;padding:3px 8px">{{ t.name }} {{ t.count }}
                <b class="chip-zoom" @click.stop="openBig('type', t.name, $event)" title="放大查看该灾种详情">⤢</b></span>
            </div>
            <div v-if="loading" class="panel-loading"><div class="boot-ring"></div></div>
          </div>
        </div>
      </div>

      <!-- 趋势 -->
      <div class="sp-5 panel">
        <div class="panel-head trend-head"><h3>预警数量时间演化</h3>
          <select class="trend-range" v-model="trendRange" @change="changeTrendRange" aria-label="时间演化展示范围">
            <option value="15d">最近 15 天</option><option value="all">全部历史（运行以来）</option>
          </select>
          <span class="sub">{{ trendDim === 'province' ? '各省预警对比 · 点 ⤢ 拖选时间窗' : '按小时分级堆叠 · 点 ⤢ 拖选时间窗' }}</span>
          <span class="chip mini" :class="{ on: trendDim === 'level' }" @click="setTrendDim('level')" title="按预警等级堆叠">按等级</span>
          <span class="chip mini" v-if="!drill" :class="{ on: trendDim === 'province' }" @click="setTrendDim('province')" title="按省份对比（TOP 省）">省份对比</span>
          <button class="ph-zoom" @click="openBig('trend', '', $event)" title="放大并拖选时间区间">⤢</button>
        </div>
        <div class="panel-body" style="padding:4px"><div class="chart" ref="trend"></div><div v-if="loading" class="panel-loading"><div class="boot-ring"></div></div></div>
      </div>

      <!-- 城市排行 -->
      <div class="sp-4 panel">
        <div class="panel-head"><h3>城市预警热度</h3>
          <span class="sub">{{ drill ? drill.name + ' · 各市 TOP8' : '全国 TOP 8' }} · 点击查看</span>
          <button class="ph-zoom" @click="openBig('city', '', $event)" title="放大查看完整排行">⤢</button>
        </div>
        <div class="panel-body scroll">
          <div class="ranklist" v-if="cityAgg.length">
            <div class="rank-item" v-for="(c,i) in cityAgg" :key="c.name"
                 @click="drillCity(c)" title="在预警地图中查看该市预警">
              <span class="rank-no">{{ i+1 }}</span>
              <span class="rank-name">{{ shortName(c.name) }}</span>
              <span class="rank-bar"><i :style="{width: (c.count / cityAgg[0].count * 100) + '%'}"></i></span>
              <span class="rank-val">{{ c.count }}</span>
            </div>
          </div>
          <div v-else class="empty">暂无城市预警数据</div>
        </div>
      </div>

      <!-- 最新预警 -->
      <div class="sp-3 panel">
        <div class="panel-head">
          <h3>最新预警</h3>
          <span class="sub">点击定位 <span class="kbd-tip"><kbd>↑</kbd><kbd>↓</kbd><kbd>Enter</kbd></span></span>
          <button class="ph-zoom" @click="openBig('list', '', $event)" title="放大查看全部预警明细">⤢</button>
        </div>
        <div class="panel-body scroll" style="padding:8px" @mouseleave="leaveRow"
             @scroll.passive="noteListScroll">
          <div class="alist" v-if="latest.length">
            <div class="alist-item" v-for="r in latest" :key="r.id"
                 :class="[lvClass(r.level), { sel: focus && focus.id === r.id, hot: hotId === r.id, fav: fav.includes(r.id) }]"
                 @click="pickRow(r)" @mouseenter="hoverRow(r)">
              <div class="ai-top">
                <span class="badge" :class="lvClass(r.level)">{{ r.type }}{{ r.level }}</span>
                <span v-if="isNewOne(r)" class="new-tag">NEW</span>
                <span class="fav-star" :class="{ on: fav.includes(r.id) }"
                      @click.stop="toggleFav(r)"
                      :title="fav.includes(r.id) ? '取消关注' : '关注（置顶）'">{{ fav.includes(r.id) ? '★' : '☆' }}</span>
                <span class="ai-time">{{ r.ts.slice(5) }}</span>
              </div>
              <div class="ai-title">{{ r.title }}</div>
              <div class="ai-sub">{{ shortName(r.issuer) }}</div>
            </div>
          </div>
          <div v-else class="empty">暂无预警记录</div>
        </div>
      </div>

      <!-- ============ 放大浮层：任一面板标题栏的 ⤢ 都在这里打开 ============ -->
      <transition name="bv">
      <div class="bigview" v-if="big" @click.self="closeBig">
        <div class="bv-card">
          <div class="bv-head">
            <h2>{{ big.title }}</h2>
            <span class="bv-sub">{{ big.sub }}</span>
            <span class="bv-close" @click="closeBig" title="关闭（Esc）">✕</span>
          </div>
          <div class="bv-body">

            <!-- 骨架屏：等级/灾种详情要等 4 个聚合请求并发回来，
                 旧版是转圈遮罩盖住整张卡（"先看到一片空，再啪地铺满"）。
                 现在按真实布局的尺寸预铺占位块 —— 数据到位时布局不跳、
                 内容由 bv-rise 错峰浮现，体感是"长出来"而不是"换脸"。 -->
            <div class="bv-sk" v-if="bigSkeleton" aria-busy="true">
              <div class="bv-kpis">
                <div class="bv-kpi" v-for="i in 6" :key="'sk' + i">
                  <i class="sk-bar" style="width:46%"></i>
                  <b class="sk-bar tall" style="width:72%"></b>
                </div>
              </div>
              <div class="bv-actions">
                <span class="sk-bar box" style="width:206px;height:28px"></span>
                <span class="sk-bar" style="width:300px"></span>
              </div>
              <div class="bv-grid">
                <div class="bv-panel sp7"><div class="sk-block" style="height:300px"></div></div>
                <div class="bv-panel sp5"><div class="sk-block" style="height:300px"></div></div>
                <div class="bv-panel sp12"><div class="sk-block" style="height:190px"></div></div>
              </div>
            </div>

            <!-- 等级 / 灾种详情 -->
            <template v-if="big.kind==='level' || big.kind==='type'">
              <template v-if="bigDetail">
                <div class="bv-kpis">
                  <div class="bv-kpi"><i>总量</i><b>{{ U.num(bigDetail.total) }}</b><s>条</s></div>
                  <div class="bv-kpi"><i>占当前筛选</i>
                    <b>{{ bigDetail.sharePct===null ? '—' : bigDetail.sharePct.toFixed(1) }}</b><s>%</s></div>
                  <div class="bv-kpi"><i>涉及省份</i><b>{{ bigDetail.provCount }}</b><s>个</s></div>
                  <div class="bv-kpi"><i>{{ big.kind==='level' ? '涉及灾种' : '涉及等级' }}</i>
                    <b>{{ bigDetail.otherCount }}</b><s>类</s></div>
                  <div class="bv-kpi"><i>发布单位</i><b>{{ bigDetail.issuerCount }}</b><s>家</s></div>
                  <div class="bv-kpi wide"><i>时间跨度</i>
                    <b class="sm">{{ bigDetail.span
                      ? bigDetail.span[0].slice(5,16) + ' → ' + bigDetail.span[1].slice(5,16) : '—' }}</b></div>
                </div>
                <div class="bv-actions">
                  <button class="btn" @click="bigFilterSelf()"
                          title="把这一维的筛选条件应用到整个总览页并关闭本层">
                    {{ big.kind==='level' ? '在地图上只看「' + big.key + '」' : '只看「' + big.key + '」' }}</button>
                  <span class="bv-hint">点省份条 → 直接下钻该省　·　点清单条目 → 关层并回主地图定位</span>
                </div>
              </template>
              <div class="bv-grid" v-if="bigDetail">
                <div class="bv-panel sp7"><h4>省份分布<em>点击下钻</em></h4>
                  <div class="chart" ref="bigProv" style="height:300px"></div></div>
                <div class="bv-panel sp5"><h4>{{ big.kind==='level' ? '灾种构成' : '等级构成' }}</h4>
                  <div class="chart" ref="bigType" style="height:300px"></div></div>
                <div class="bv-panel sp12"><h4>时间演化<em>{{ big.key }} 逐小时</em></h4>
                  <div class="chart" ref="bigLine" style="height:190px"></div></div>
                <div class="bv-panel sp12">
                  <h4>逐条清单<em>{{ bigDetail.recs.length }} 条{{
                    bigDetail.recs.length > 120 ? '（显示前 120）' : '' }}</em></h4>
                  <div class="bv-list">
                    <div class="bv-item" v-for="r in bigDetail.recs.slice(0,120)" :key="r.id"
                         :class="{ fav: fav.includes(r.id) }"
                         @click="pickFromBig(r)" :title="r.title">
                      <span class="badge" :class="lvClass(r.level)">{{ r.type }}{{ r.level }}</span>
                      <span class="fav-star" :class="{ on: fav.includes(r.id) }"
                            @click.stop="toggleFav(r)"
                            :title="fav.includes(r.id) ? '取消关注' : '关注（置顶）'">{{ fav.includes(r.id) ? '★' : '☆' }}</span>
                      <span class="bv-it-title">{{ r.title }}</span>
                      <span class="bv-it-meta">{{ shortName(r.issuer) }} · {{ r.ts.slice(5,16) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- 趋势图 + 时间刷选 -->
            <template v-else-if="big.kind==='trend'">
              <div class="bv-actions">
                <select class="trend-range" v-model="trendRange" @change="changeTrendRange" aria-label="时间演化展示范围">
                  <option value="15d">最近 15 天</option><option value="all">全部历史（运行以来）</option>
                </select>
                <span class="bv-hint">拖动下方时间轴选择区间（也可在图上滚轮缩放）→ 地图 / 清单 / 等级构成 /
                  灾种 / 城市排行会一起按该时间窗过滤；趋势图保留所选展示范围，充当时间轴</span>
                <span class="chip mini" @click="quickWin(24)" title="只看最近 24 小时">近 24 小时</span>
                <span class="chip mini" @click="quickWin(72)" title="只看最近 3 天">近 3 天</span>
                <span class="chip mini" @click="quickWin(168)" title="只看最近 7 天">近 7 天</span>
                <span class="chip mini" @click="quickWin(0)" title="取消地图时间筛选，保留趋势展示范围">清除时间筛选</span>
                <span class="win-tag" v-if="win">时间窗 {{ win.label }}<b @click="clearWindow">✕</b></span>
              </div>
              <div class="bv-panel sp12">
                <h4>预警数量时间演化<em>{{ trendRange === '15d' ? '最近 15 天' : '全部历史（运行以来）' }} · 拖选下方时间轴</em></h4>
                <div class="chart" ref="bigLine" style="height:380px"></div>
              </div>
            </template>

            <!-- 省份 / 城市排行 -->
            <template v-else-if="big.kind==='province' || big.kind==='city'">
              <div class="bv-actions">
                <span class="bv-hint">条形颜色 = 该地最高预警等级　·　点击条形直接下钻</span>
                <span class="fb-total" v-if="activeLevel">按 <b>{{ activeLevel }}</b> 条数统计</span>
              </div>
              <div class="bv-panel sp12">
                <div class="chart" ref="bigRank" style="height:660px"></div>
              </div>
            </template>

            <!-- 预警明细清单 -->
            <template v-else-if="big.kind==='list'">
              <div class="bv-actions">
                <span class="bv-hint">当前筛选结果（最多 {{ latestAll.length }} 条）· 点击条目 → 关闭本层并在地图上定位</span>
                <span class="fb-total">命中 <b>{{ hitTotal }}</b> 条<template
                  v-if="latestAll.length < hitTotal">（列出最新 {{ latestAll.length }} 条）</template></span>
              </div>
              <div class="bv-panel sp12">
                <div class="bv-list">
                  <div class="bv-item" v-for="r in latestAll" :key="r.id"
                       :class="{ fav: fav.includes(r.id) }"
                       @click="pickFromBig(r)" :title="r.title">
                    <span class="badge" :class="lvClass(r.level)">{{ r.type }}{{ r.level }}</span>
                    <span class="fav-star" :class="{ on: fav.includes(r.id) }"
                          @click.stop="toggleFav(r)"
                          :title="fav.includes(r.id) ? '取消关注' : '关注（置顶）'">{{ fav.includes(r.id) ? '★' : '☆' }}</span>
                    <span class="bv-it-title">{{ r.title }}</span>
                    <span class="bv-it-meta">{{ shortName(r.issuer) }} · {{ r.ts.slice(5,16) }}</span>
                  </div>
                  <div v-if="!latestAll.length" class="empty">当前筛选下没有预警</div>
                </div>
              </div>
            </template>

            <!-- 地图大图 -->
            <template v-else-if="big.kind==='map'">
              <div class="bv-actions">
                <span class="bv-hint">单击省份下钻 · 滚轮 / ＋− 缩放 · 双击空白处放大 · 右键缩小　·　点圆点 → 关层回主视图定位</span>
              </div>
              <div class="bv-panel sp12">
                <div class="chart" ref="bigMap" style="height:640px"></div>
              </div>
            </template>

          </div>
        </div>
      </div>
      </transition>
    </div>`
  };
})();
