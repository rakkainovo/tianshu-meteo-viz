/* ============================================================
   charts.js —— ECharts 图表宿主（Vue 混入）
   统一处理：实例创建 / 复用 / 自适应 / 销毁 / 事件绑定
   ============================================================ */
(function (global) {
  'use strict';

  const ChartHost = {
    data() {
      return { _charts: {}, _bound: {} };
    },
    mounted() {
      this._onWinResize = () => this.resizeCharts();
      window.addEventListener('resize', this._onWinResize);
      // 面板尺寸变化（侧栏收起、字体缩放等）也要跟着重绘
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          clearTimeout(this._roT);
          this._roT = setTimeout(() => this.resizeCharts(), 90);
        });
        if (this.$el && this.$el.nodeType === 1) this._ro.observe(this.$el);
      }
    },
    beforeUnmount() {
      window.removeEventListener('resize', this._onWinResize);
      if (this._ro) this._ro.disconnect();
      Object.values(this._charts).forEach(c => { try { c.dispose(); } catch (e) {} });
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
      /* 设置 option；默认 notMerge，避免残留旧 series */
      setChart(name, option, notMerge) {
        const c = this.chart(name);
        if (!c) return null;
        c.setOption(option || {}, notMerge !== false);
        c.resize();
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
      }
    }
  };

  global.ChartHost = ChartHost;
})(window);
