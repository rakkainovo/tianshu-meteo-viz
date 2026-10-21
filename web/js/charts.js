/* ============================================================
   charts.js —— ECharts 图表宿主（Vue 混入）
   统一处理：实例创建 / 复用 / 自适应 / 销毁 / 事件绑定
             地图视野飞行 / 高亮标记叠加

   性能优化要点：
   1. window resize 与 ResizeObserver 共用同一个节流 tick（120ms），
      避免拖窗口时每秒几十次重绘 ECharts。
   2. setChart 末尾不再强制 c.resize()，setOption 本身已按容器
      当前尺寸绘制；外部如需在尺寸变化后强制 resize 显式调
      $nextResize()。
   3. 地图视野更新走 geoApply：改坐标系 + 同步地图面分组变换 + 让散点重排，
      每帧净开销约 3ms，所以飞行可以按 60fps 播。
      高亮标记按 series id 增量更新 —— **不能**走 setChart（默认 notMerge），
      否则动画每帧都要把几百个点整套重建，必掉帧。
   ============================================================ */
(function (global) {
  'use strict';

  /* 缓入缓出，位置插值用 */
  const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const ChartHost = {
    data() {
      return { _charts: {}, _bound: {}, _rzT: null, _roT: null, _geoHome: {} };
    },
    mounted() {
      /* window resize：120ms 节流，与 ResizeObserver 共用 _rzT */
      this._onWinResize = () => {
        clearTimeout(this._rzT);
        this._rzT = setTimeout(() => this.resizeCharts(), 120);
      };
      window.addEventListener('resize', this._onWinResize);
      /* 面板尺寸变化（侧栏收起、字体缩放等）也走同一节流 */
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          clearTimeout(this._rzT);
          this._rzT = setTimeout(() => this.resizeCharts(), 120);
        });
        if (this.$el && this.$el.nodeType === 1) this._ro.observe(this.$el);
      }
    },
    beforeUnmount() {
      window.removeEventListener('resize', this._onWinResize);
      if (this._ro) this._ro.disconnect();
      clearTimeout(this._rzT);
      clearTimeout(this._roT);
      this._ovCancelAll();
      Object.values(this._charts).forEach(c => {
        if (c && c.__fly) cancelAnimationFrame(c.__fly);
        if (c && c.__afterFly) cancelAnimationFrame(c.__afterFly);
        try { c.dispose(); } catch (e) {}
      });
      this._charts = {};
    },
    methods: {
      /* 取得（或创建）某个 ref 上的 ECharts 实例 */
      chart(name) {
        const el = this.$refs[name];
        if (!el) return null;
        let c = this._charts[name];
        if (!c || c.isDisposed()) {
          c = echarts.init(el, 'tianshu', { renderer: 'canvas' });
          this._charts[name] = c;
        }
        return c;
      },
      /* 设置 option；默认 notMerge，避免残留旧 series。
         不再强制 resize —— setOption 已按容器当前尺寸绘制；
         若刚 mount 时容器尺寸为 0，外层 resize tick 会自动补上。
         含 geo 的 option 会顺带记下"初始视野"，供 geoReset 复位。
         注意：geoStyle() 不写 center（靠 layoutCenter/layoutSize 定位），
         所以 getOption().geo[0].center 是空数组 —— 必须用 geoDefaultCenter
         回填，否则 geoFly 无从起飞、geoReset 也无处可回。 */
      setChart(name, option, notMerge) {
        const c = this.chart(name);
        if (!c) return null;
        c.setOption(option || {}, notMerge !== false);
        if (option && option.geo) {
          const g = (c.getOption().geo || [])[0] || {};
          this._geoHome[name] = {
            center: (g.center && g.center.length === 2)
              ? g.center.slice() : this.geoDefaultCenter(c),
            zoom: (g.zoom === undefined || g.zoom === null) ? 1 : g.zoom,
            layoutCenter: g.layoutCenter ? g.layoutCenter.slice() : null,
            layoutSize: g.layoutSize
          };
          /* 漫游后把地图面同步过去，见 commitGeo / syncMapGroup 的注释。
             挂在 setChart 里 = 所有地图页一次搞定（子页若要跟着做视觉调整，
             实现 afterGeoRoam(name) 即可，不要再自己 onChart('georoam')
             —— onChart 同名事件会覆盖，把这里的同步顶掉）。
             __committing 守卫：geoApply 内部也会 dispatch 出 georoam，
             不挡掉就会把自己的飞行取消。 */
          this.onChart(name, 'georoam', () => {
            const c = this._charts[name];
            if (!c || c.__committing) return;
            this.geoStop(name);
            this.commitGeo(name);
            this.syncHoverDotSoon();
            if (typeof this.afterGeoRoam === 'function') this.afterGeoRoam(name);
          });
        }
        return c;
      },
      /* 绑定图表事件（同一事件只绑一次） */
      onChart(name, event, handler) {
        const c = this.chart(name);
        if (!c) return;
        const key = name + '|' + event;
        if (this._bound[key]) c.off(event, this._bound[key]);
        this._bound[key] = handler;
        c.on(event, handler);
      },
      /* 销毁并重建某个图表实例（懒创建，下一次 chart()/setChart 时真正 init）。
         用途：ECharts 5.5.1 缺陷——同一实例上更换 geo.map 后（下钻/回退），
         visualMap 对 map 系列面的着色会永久失效，实测连
         setOption(..., {replaceMerge:['geo','series']}) 都救不回来；
         只有全新实例首渲染才正常。换地图时必须走这里。 */
      recreateChart(name) {
        const old = this._charts[name];
        if (old) {
          if (old.__fly) cancelAnimationFrame(old.__fly);
          if (old.__afterFly) cancelAnimationFrame(old.__afterFly);
          try { old.dispose(); } catch (e) { /* ignore */ }
        }
        delete this._charts[name];
        if (this._ovQ && this._ovQ[name] && this._ovQ[name].__raf) {
          cancelAnimationFrame(this._ovQ[name].__raf);
          delete this._ovQ[name];
        }
        return null;
      },
      _ovCancelAll() {
        if (!this._ovQ) this._ovQ = {};
        Object.keys(this._ovQ).forEach(k => {
          if (this._ovQ[k] && this._ovQ[k].__raf) cancelAnimationFrame(this._ovQ[k].__raf);
        });
        this._ovQ = {};
        if (this._hotT) { clearTimeout(this._hotT); this._hotT = null; }
        if (this._hoverDotT) { clearTimeout(this._hoverDotT); this._hoverDotT = null; }
      },

      /* 把「鼠标当前悬在哪一行」推给地图。清单 hover 联动必须走这里。
         策略：滚动期间先不动（滚完补一次），静止时也合并一次。
         配套 syncHoverDot() 把悬停圈画成 DOM 元素 —— 见那里的注释。 */
      pushMapHot() {
        if (this._hotT) clearTimeout(this._hotT);
        const scrolling = (Date.now() - (this._listScrolledAt || 0)) < 160;
        this._hotT = setTimeout(() => {
          this._hotT = null;
          this.syncHoverDot();
        }, scrolling ? 70 : 34);
      },
      /* 清单滚动时调一下，用于"滚动期间别动地图" */
      noteListScroll() { this._listScrolledAt = Date.now(); },

      /* 地图上的"悬停圆环"用 DOM 画，**不挂进 ECharts series**。
         原因：ECharts 每次 setOption 都会走完整的更新 + 重绘流程，地图放大后
         单次可达上百毫秒；而清单滚动时鼠标会连续掠过多行、每行都要联动一次，
         实测滚动 900ms 内会掉出 4~5 个 160ms 的长任务（一顿一顿的来源）。
         换成 DOM 覆盖层后，联动成本约等于零。
         视图只需提供 hoverPx() -> [x, y] | null（见 geoPointToPx）。 */
      syncHoverDot() {
        const host = (this.$el && this.$el.querySelector)
          ? this.$el.querySelector('.map-wrap') : null;
        if (!host) return;
        let dot = host.querySelector('.map-hoverdot');
        let px = null;
        try {
          if (typeof this.hoverPx === 'function') px = this.hoverPx();
        } catch (e) { px = null; }
        if (!px || !isFinite(px[0]) || !isFinite(px[1])) {
          if (dot) dot.style.display = 'none';
          return;
        }
        /* 目标点当前不在视野里（地图被滚到别处了）就别画，免得圆环飘到面板外 */
        const w = host.clientWidth, h = host.clientHeight;
        if (px[0] < -2 || px[1] < -2 || px[0] > w + 2 || px[1] > h + 2) {
          if (dot) dot.style.display = 'none';
          return;
        }
        if (!dot) {
          dot = document.createElement('div');
          dot.className = 'map-hoverdot';
          host.appendChild(dot);
        }
        dot.style.display = 'block';
        dot.style.left = (Math.round(px[0] * 2) / 2) + 'px';
        dot.style.top = (Math.round(px[1] * 2) / 2) + 'px';
      },
      /* 漫游 / 缩放 / 飞行后，把悬停圈重新贴回点位（防抖，DOM 操作成本可忽略） */
      syncHoverDotSoon() {
        clearTimeout(this._hoverDotT);
        this._hoverDotT = setTimeout(() => this.syncHoverDot(), 100);
      },
      /* 经纬度 -> 地图容器内的像素坐标（DOM 覆盖层定位用） */
      geoPointToPx(name, lng, lat) {
        const g = this.geoParts(name);
        if (!g || typeof g.cs.dataToPoint !== 'function') return null;
        let p = null;
        try { p = g.cs.dataToPoint([lng, lat]); } catch (e) { return null; }
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
        return [p[0], p[1]];
      },
      resizeCharts() {
        Object.values(this._charts).forEach(c => { try { c.resize(); } catch (e) {} });
      },
      /* 让容器在 DOM 更新后重算尺寸 */
      $nextResize(names) {
        this.$nextTick(() => {
          (names || Object.keys(this._charts)).forEach(n => {
            const c = this._charts[n];
            if (c) { try { c.resize(); } catch (e) {} }
          });
        });
      },

      /* ---------------- 地图视野 ---------------- */
      /* 取 geo 组件的三件套：图表实例 / GeoModel（持有 option）/ 坐标系统（持有真实视野）。
         roam 之后 option 里的 center/zoom 不一定同步，所以"当前在哪"一律从坐标系统读。 */
      geoParts(name) {
        const c = this._charts[name];
        if (!c || c.isDisposed()) return null;
        try {
          const gm = c.getModel().getComponent('geo', 0);
          const cs = gm && gm.coordinateSystem;
          if (!cs || cs.type !== 'geo' || typeof cs.getZoom !== 'function') return null;
          return { c: c, gm: gm, cs: cs };
        } catch (e) { return null; }
      },
      /* 取「当前 geo 视野中心」的经纬度。
         背景：option 里通常不写 geo.center，靠 layoutCenter/layoutSize 摆位，
         此时 getOption().geo[0].center 是空数组。但视图总要有个中心，
         ECharts 内部会回落到地图包围盒中心 —— 我们从坐标系读回来。
         两条退路：① geo 坐标系的 center（经纬度）；② 像素中心反算经纬度。
         返回 null 表示实在取不到（地图还没渲染完）。 */
      geoDefaultCenter(c) {
        if (!c || c.isDisposed()) return null;
        try {
          const cs = c.getModel().getComponent('geo', 0).coordinateSystem;
          const ctr = cs && cs.center;
          /* 经纬度一定落在 ±180 / ±90 内；像素坐标会远大于此，用它做甄别 */
          if (ctr && ctr.length === 2 && isFinite(ctr[0]) && isFinite(ctr[1])
              && Math.abs(ctr[0]) <= 180 && Math.abs(ctr[1]) <= 90) {
            return [+ctr[0], +ctr[1]];
          }
        } catch (e) { /* 地图未就绪，走退路 */ }
        try {
          const g = (c.getOption().geo || [])[0] || {};
          const px = this._layoutPx(c, g.layoutCenter, 0.5), py = this._layoutPx(c, g.layoutCenter, 0.52, true);
          const v = c.convertFromPixel({ geoIndex: 0 }, [px, py]);
          if (v && v.length === 2 && isFinite(v[0]) && isFinite(v[1])) return [+v[0], +v[1]];
        } catch (e) { /* ignore */ }
        return null;
      },
      /* layoutCenter 项可能是 '50%' / 50 / '50%' 这类，统一换成像素 */
      _layoutPx(c, lc, pct, vertical) {
        const v = lc ? lc[vertical ? 1 : 0] : null;
        const size = vertical ? c.getHeight() : c.getWidth();
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.indexOf('%') > -1) {
          const n = parseFloat(v);
          return isFinite(n) ? size * n / 100 : size * pct;
        }
        return size * pct;
      },
      /* 读当前真实视野（坐标系统的值，不是 option 里的值） */
      geoNow(name) {
        const g = this.geoParts(name);
        if (!g) {
          /* 地图还没建出来：退回 option / 初始视野 */
          const c = this._charts[name];
          if (!c || c.isDisposed()) return null;
          const og = (c.getOption().geo || [])[0] || {};
          return {
            center: (og.center && og.center.length === 2) ? og.center.slice() : null,
            zoom: og.zoom || (this._geoHome[name] || {}).zoom || 1
          };
        }
        let center = null;
        try { center = g.cs.getCenter(); } catch (e) { center = null; }
        if (!center || center.length !== 2 || !isFinite(center[0]) || !isFinite(center[1])) {
          center = this.geoDefaultCenter(g.c);
        }
        let zoom = 1;
        try { zoom = g.cs.getZoom() || 1; } catch (e) { zoom = 1; }
        return { center: center ? center.slice() : null, zoom: zoom };
      },

      /* 立即把视野设到 (center, zoom)。
         ⚠⚠ 本文件最反直觉的一处，改之前务必读完（我在这上面栽了一整天）。
         实测（ECharts 5.5.1 · geo 组件 + 共享 geoIndex 的 map 系列）：
           · cs.setZoom / cs.setCenter   → 只改坐标系。散点和 DOM 浮层跟着动，
             **省界色块纹丝不动**（原因见 syncMapGroup）。
           · dispatchAction({type:'geoRoam'}) → 同上，它只负责推导 center/zoom
             并驱动各系列 updateTransform，不重画地图面。
           · setOption({geo:{center,zoom}}) → 面会跟着动，但代价 12~21ms/次，
             而且每次都会**换掉 Geo 实例**。
         正确且便宜的姿势是三条一起（实测总耗时 5.8~7.7ms，与 setOption 视觉等价）：
           ① cs.setZoom + cs.setCenter  改坐标系（真相源，散点/浮层读它）
           ② syncMapGroup               把漫游变换抄到地图面的分组上
           ③ dispatchAction geoRoam 0 位移  让各系列 updateTransform 重排
         `__committing` 标志是必须的：第 ③ 步会同步抛出 georoam 事件，
         没有它就会被自己的监督器当成"用户漫游"、把飞行取消掉。 */
      geoApply(name, center, zoom) {
        const c = this._charts[name];
        if (!c || c.isDisposed()) return;
        const g = this.geoParts(name);
        if (!g) return;
        const gm = g.gm, cs = g.cs;
        let ctr = (center && center.length === 2) ? [+center[0], +center[1]] : null;
        let z = (typeof zoom === 'number' && isFinite(zoom) && zoom > 0) ? zoom : null;
        if (!ctr || z === null) {
          const cur = this.geoNow(name);
          if (!ctr) ctr = (cur && cur.center) ? cur.center.slice() : null;
          if (z === null) z = (cur && cur.zoom) || 1;
        }
        if (!ctr) return;
        const prev = c.__committing;
        c.__committing = true;
        try {
          cs.setZoom(z);
          /* 第二参必须是 chart 实例：Geo.setCenter 内部要用它算 getWidth/getHeight */
          cs.setCenter(ctr, c);
          /* 与 option 对齐：否则下一次任何 setOption 都会用旧值把视野弹回去 */
          if (gm.option) { gm.option.center = ctr.slice(); gm.option.zoom = z; }
          /* ③ 让散点等系列按新坐标系重排（不重建图形，约 3ms） */
          c.dispatchAction({ type: 'geoRoam', componentType: 'geo', geoIndex: 0, dx: 0, dy: 0 });
          /* ② 放最后：dispatch 内部会重算漫游变换，抄一次最新的 */
          this.syncMapGroup(name, cs);
        } catch (e) {
          /* 兜底：老路子，慢但结果正确 */
          try { c.setOption({ geo: { center: ctr, zoom: z } }); } catch (e2) {}
        } finally {
          c.__committing = prev;
        }
        this._afterGeoApply(name);
      },
      /* 把坐标系的漫游变换（roam）抄到"地图面"所在的分组上。
         —— 为什么必须补这一刀：
         ECharts 把地图面多边形的**经纬度→像素的 raw 变换直接烘焙进形状**里
         （见 MapDraw._buildGeoJSON 里的 `t[0]*r.scaleX + r.x`），而"视野"
         只体现为一个 group 变换，且这个变换**只在 MapDraw.draw() 里抄一次**。
         漫游时 MapDraw.draw() 根本不会被调用 —— geoRoam 动作的 update 是
         'updateTransform'，而 GeoView 没有实现 updateTransform，
         调度器把它收集进数组后就没再用过（源码里那个 `o.push(s)`）。
         ⇒ 不补这一刀：滚轮缩放/拖拽/飞行时**只有散点在动，省界色块原地不动**，
         用户体感就是"地图缩放不灵了"。成本约 0.1ms（4 个属性 + dirty）。 */
      syncMapGroup(name, cs) {
        const c = this._charts[name];
        if (!c || c.isDisposed()) return;
        let gm = null;
        try { gm = c.getModel().getComponent('geo', 0); } catch (e) { return; }
        const sys = cs || (gm && gm.coordinateSystem);
        if (!sys) return;
        let group = null;
        try {
          const view = c.getViewOfComponentModel(gm);
          group = view && view._mapDraw && view._mapDraw.group;
        } catch (e) { return; }
        if (!group) return;
        let roam = null;
        try { roam = sys.getTransformInfo().roam; } catch (e) { return; }
        if (!roam || !isFinite(roam.scaleX)) return;
        group.x = roam.x; group.y = roam.y;
        group.scaleX = roam.scaleX; group.scaleY = roam.scaleY;
        group.dirty();
      },
      /* 视野改完后的收尾：子页可能挂了 afterGeoFly 做与缩放相关的视觉调整
         （例如 station 页按 zoom 调散点半径）。连续飞行时每帧都会调这里 ——
         取消上一次即可，只在停稳后跑一次。 */
      _afterGeoApply(name) {
        if (typeof this.afterGeoFly !== 'function') return;
        const c = this._charts[name];
        if (!c || c.isDisposed()) return;
        if (c.__afterFly) cancelAnimationFrame(c.__afterFly);
        c.__afterFly = requestAnimationFrame(() => {
          c.__afterFly = requestAnimationFrame(() => {
            c.__afterFly = null;
            if (c.isDisposed()) return;
            if (typeof this.afterGeoFly === 'function') this.afterGeoFly(name);
          });
        });
      },

      /* 用户真实漫游（滚轮 / 拖拽）之后把地图面的分组变换同步过去。
         这一步只有 0.1ms，所以每帧都同步、不节流，缩放最跟手。
         坐标系和散点不用管：原生漫游走的就是 geoRoam 动作，两者都已更新；
         只有地图面没人管（见 syncMapGroup）。 */
      commitGeo(name) {
        const c = this._charts[name];
        if (!c || c.isDisposed() || c.__committing) return;
        const v = this.geoNow(name);
        if (v && v.center) {
          let gm = null;
          try { gm = c.getModel().getComponent('geo', 0); } catch (e) { gm = null; }
          if (gm && gm.option) { gm.option.center = v.center.slice(); gm.option.zoom = v.zoom; }
        }
        this.syncMapGroup(name);
      },

      /* 平滑把地图视野移到 (lng, lat)。传 null 坐标 = 复位到本图初始视野。
         时长按"要飞多远"自适应：近的干脆利落，远的留足时间，避免每次都拖一样久。 */
      geoFly(name, lng, lat, zoom, ms) {
        const c = this._charts[name];
        if (!c || c.isDisposed()) return;
        const home = this._geoHome[name] || {};
        const from = this.geoNow(name);
        if (!from || !from.center) return;
        const reset = (lng === null || lng === undefined);
        const homeCtr = (home.center && home.center.length === 2) ? home.center : null;
        const to = reset
          ? { center: homeCtr || from.center, zoom: home.zoom || from.zoom }
          : { center: [lng, lat], zoom: zoom || from.zoom };
        const span = Math.abs(to.center[0] - from.center[0]) + Math.abs(to.center[1] - from.center[1]);
        /* 时长自适应，但压得比之前短：每帧都要重排散点并把大尺寸的地图面重绘一遍，
           拖得越久越显得"生硬"。近的一下到位（340ms），最远 560ms 也就够了。 */
        const dur = ms || Math.max(340, Math.min(560,
          360 + span * 9 + Math.abs(Math.log(Math.max(to.zoom, .01) / Math.max(from.zoom, .01))) * 55));
        if (c.__fly) cancelAnimationFrame(c.__fly);
        const t0 = (global.performance && performance.now) ? performance.now() : Date.now();
        let last = 0;
        /* 帧预算：每帧的净开销是"散点重排 ~2ms + 地图面重绘"（重绘随 zoom 变贵），
           所以既要挡住 120Hz 高刷屏做无用功，也要给总帧数封顶 —— 否则一次长距离
           飞行会硬生生跑 40 帧，越到后面每帧越贵，尾巴上明显一顿。
           按 26 帧摊：dur 400ms → 15ms/帧；dur 560ms → 21.5ms/帧。 */
        const MIN_STEP = Math.max(12, dur / 26);
        const step = now => {
          const t = Math.min(1, (now - t0) / dur);
          if (t < 1 && now - last < MIN_STEP) { c.__fly = requestAnimationFrame(step); return; }
          last = now;
          const e = easeInOut(t);
          this.geoApply(name,
            [from.center[0] + (to.center[0] - from.center[0]) * e,
             from.center[1] + (to.center[1] - from.center[1]) * e],
            /* 缩放走对数插值：视觉上匀速；线性插值会"先慢后猛"最后一下很跳 */
            from.zoom * Math.pow(to.zoom / from.zoom, e));
          if (t < 1) c.__fly = requestAnimationFrame(step);
          else c.__fly = null;
        };
        c.__fly = requestAnimationFrame(step);
      },
      geoStop(name) {
        const c = this._charts[name];
        if (c && c.__fly) { cancelAnimationFrame(c.__fly); c.__fly = null; }
      },
      geoReset(name, ms) { this.geoFly(name, null, null, null, ms); },

      /* ---------------- 缩放原语（供缩放按钮 / 双击 / 右键 / 键盘共用） ----------------
         为什么不用 ECharts 自带的 toolbox dataZoom：geo 组件没有内置缩放控件，
         而本项目的地图视野必须走 geoApply 三件套（见 geoApply 注释），
         自己实现反而便宜且方向可控 —— 这也是"用户说放大缩小是反的"的根治方案：
         显式按钮不存在方向歧义，滚轮保持业界惯例（向上=放大）。 */
      /* 步进缩放。dir=+1 放大 / -1 缩小；px 为容器内坐标锚点（可空）。
         锚点缩放的数学：要让锚点 a（屏幕像素 p）在缩放比 s 下**原地不动**。
         设画布中心 C、旧中心数据坐标 Cd、缩放前每数据单位 k 像素，则
             p = C + (a - Cd)·k
         缩放后 k' = k·s、中心变成 Cd'，要求同一个 a 仍落在 p：
             C + (a - Cd')·k·s = p  →  a - Cd' = (a - Cd)/s
         换成"先把新中心移到哪个像素 np 再 pointToData"：
             np = C + (p - C)·(1 - 1/s)
         **是 (1 - 1/s)，不是 (1 - s)**：后者在放大（s>1）时系数为负，
         新中心会朝锚点的**反方向**跑 —— 实测双击东南海面，视野反而往西北
         内陆飞，"以该点放大"完全看不出来。老注释写错了推导，一并订正。 */
      zoomAt(name, dir, px) {
        const g = this.geoParts(name);
        if (!g) return;
        const cur = this.geoNow(name);
        if (!cur || !cur.center) return;
        const lim = g.gm.get('scaleLimit') || {};
        const K = 1.7;
        const z = Math.max(lim.min || .5, Math.min(lim.max || 32,
          cur.zoom * (dir > 0 ? K : 1 / K)));
        const s = z / cur.zoom;
        let ctr = cur.center;
        if (px && Math.abs(s - 1) > 1e-6) {
          try {
            const c = g.c;
            /* 缩放中心必须取 **geo 自己的布局中心**，不是容器的几何中心。
               本项目 geo 配了 layoutCenter:['50%','54%'] —— 中心在 54% 高处，
               与容器中心差 475*(.54-.50) ≈ 19px；拿容器中心当锚点原点，
               会让锚点在纬度上漂 1° 量级（实测 19.461° → 20.534°），
               "以该点放大"就还是差一口气。layoutCenter 的语义就是中心点坐标
               （可 % 可 px），layoutSize 只影响大小、不影响中心。 */
            let cx = c.getWidth() / 2, cy = c.getHeight() / 2;
            const lc = g.gm && g.gm.get('layoutCenter');
            if (lc && lc.length === 2) {
              const toPx = (v, base) => {
                if (typeof v === 'string' && v.indexOf('%') >= 0) {
                  return parseFloat(v) / 100 * base;
                }
                const n = parseFloat(v);
                return isFinite(n) ? n : null;
              };
              const lx = toPx(lc[0], c.getWidth());
              const ly = toPx(lc[1], c.getHeight());
              if (lx !== null) cx = lx;
              if (ly !== null) cy = ly;
            }
            const f = 1 - 1 / s;
            const np = [cx + (px[0] - cx) * f, cy + (px[1] - cy) * f];
            const ll = g.cs.pointToData(np);
            if (ll && isFinite(ll[0]) && isFinite(ll[1])) ctr = [ll[0], ll[1]];
          } catch (e) { /* 锚点算不了就按中心缩放，行为仍然正确 */ }
        }
        this.geoFly(name, ctr[0], ctr[1], z, 240);
      },
      /* 不带锚点的步进缩放（按钮 / 键盘）：保持当前中心不动。
         注意这里**不能**传容器中心当锚点 —— 那等于宣称"容器中心那个地理点
         不动"，而 geo 的布局中心在 54% 高处、与容器中心差 19px，
         于是每按一次 ＋，视野都会朝北侧滑一点点（"按按钮怎么也跟着漂"）。
         传 null 才是字面意义的"中心不动"。 */
      zoomStep(name, dir) {
        this.zoomAt(name, dir, null);
      },

      /* 立即把视野设到某点（不动画）。用于"重建 option 之后把视野拉回原处"：
         setChart 是 notMerge 的，每次重建都会回到 option 里的初始视野，
         若不补这一刀，实时刷新一来用户正在看的焦点就飞走了。 */
      geoSet(name, lng, lat, zoom) {
        if (lng === null || lng === undefined) return;
        this.geoStop(name);
        const cur = this.geoNow(name);
        this.geoApply(name, [lng, lat], zoom || (cur && cur.zoom) || 1);
      },

      /* ---------------- 高亮标记叠加 ---------------- */
      /* 增量更新"高亮 / 悬浮"两个常驻叠加系列。
         传 undefined = 该项不动；传 [] = 清除。
         只在 series 里带 id，ECharts 合并模式按 id 命中，其余系列原样保留。
         raf 合并 + lazyUpdate：鼠标滑过清单时每行都会触发一次，若逐个 setOption，
         实测每次约 19ms（全量重绘），快速滚动必卡 —— 合并到一帧只做一次。 */
      mapOverlay(name, patch) {
        const c = this._charts[name];
        if (!c || c.isDisposed()) return;
        if (!this._ovQ) this._ovQ = {};
        const q = this._ovQ[name] || (this._ovQ[name] = {});
        if (patch && patch.focus !== undefined) q.focus = patch.focus || [];
        if (patch && patch.hover !== undefined) q.hover = patch.hover || [];
        if (q.__raf) return;
        q.__raf = requestAnimationFrame(() => {
          q.__raf = null;
          if (c.isDisposed()) return;
          const series = [];
          if (q.focus !== undefined) series.push({ id: 'ov-focus', data: q.focus });
          if (q.hover !== undefined) series.push({ id: 'ov-hover', data: q.hover });
          if (!series.length) return;
          try { c.setOption({ series: series }, { lazyUpdate: true }); } catch (e) {}
        });
      }
    }
  };

  global.ChartHost = ChartHost;
})(window);
