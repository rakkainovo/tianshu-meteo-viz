/* ============================================================
   theme.js —— ECharts 视觉规范 + 地图注册中心
   把"颜色语义 / 坐标轴 / 提示框 / 图例"统一在这里，保证六个页面观感一致
   ============================================================ */
(function (global) {
  'use strict';

  const C = {
    fg: '#e8f0fb', fg2: '#a9bdd6', fg3: '#6f89a6',
    axis: '#4a6480', grid: 'rgba(110,145,190,.13)',
    cyan: '#3fc6ff', mint: '#7cf6d8', purple: '#b48bff', amber: '#ffb648',
    lv: { '蓝色': '#3d7eff', '黄色': '#ffd233', '橙色': '#ff8a00', '红色': '#ff3b47', '未知': '#7a8aa0' }
  };
  const FONT = '"HarmonyOS Sans SC","PingFang SC","Microsoft YaHei",sans-serif';

  /* ---------------- 主题注册 ---------------- */
  echarts.registerTheme('tianshu', {
    color: [C.cyan, C.mint, C.purple, C.amber, '#5bc8ff', '#8ee6a8', '#ff6b6b', '#c08b5c'],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT, color: C.fg },
    title: { textStyle: { color: C.fg, fontSize: 13, fontWeight: 500 } },
    legend: { textStyle: { color: C.fg2, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    tooltip: {
      backgroundColor: 'rgba(7,18,32,.95)', borderColor: 'rgba(80,180,255,.35)',
      borderWidth: 1, textStyle: { color: C.fg, fontSize: 12, fontFamily: FONT },
      axisPointer: { lineStyle: { color: 'rgba(63,198,255,.45)' }, shadowStyle: { color: 'rgba(63,198,255,.06)' } }
    },
    grid: { left: 46, right: 20, top: 40, bottom: 26, containLabel: true }
  });

  /* ---------------- 基础构件 ---------------- */
  const axisLabel = { color: C.fg2, fontSize: 11 };
  const axisLine = { lineStyle: { color: C.axis } };
  const splitLine = { lineStyle: { color: C.grid, type: 'dashed' } };

  function axisX(extra) {
    return Object.assign({
      type: 'category', axisLabel, axisLine, axisTick: { show: false }, splitLine: { show: false }
    }, extra || {});
  }
  function axisY(extra) {
    return Object.assign({
      type: 'value', nameTextStyle: { color: C.fg3, fontSize: 11 }, axisLabel, splitLine,
      axisLine: { show: false }, axisTick: { show: false }
    }, extra || {});
  }
  function title(text, sub) {
    return {
      text, subtext: sub || '', left: 6, top: 2,
      textStyle: { color: C.fg, fontSize: 13, fontWeight: 500, fontFamily: FONT },
      subtextStyle: { color: C.fg3, fontSize: 11 }
    };
  }
  function tooltip(extra) {
    return Object.assign({
      backgroundColor: 'rgba(7,18,32,.95)', borderColor: 'rgba(80,180,255,.35)',
      borderWidth: 1, textStyle: { color: C.fg, fontSize: 12, fontFamily: FONT }
    }, extra || {});
  }

  /* ---------------- 常用图表 ---------------- */
  function bar(labels, values, opt) {
    opt = opt || {};
    const horizontal = !!opt.horizontal;
    const base = {
      backgroundColor: 'transparent',
      title: opt.title ? title(opt.title, opt.subtitle) : undefined,
      tooltip: tooltip({
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(63,198,255,.08)' } },
        formatter: p => {
          const it = Array.isArray(p) ? p[0] : p;
          return `<b>${it.name}</b><br/>${opt.seriesName || '数量'}：<b style="color:${C.cyan}">${global.U.num(it.value)}</b> ${opt.unit || ''}`;
        }
      }),
      grid: opt.grid || (horizontal ? { left: 84, right: 46, top: opt.title ? 44 : 16, bottom: 14, containLabel: false }
                                    : { left: 46, right: 18, top: opt.title ? 44 : 18, bottom: 26, containLabel: true })
    };
    const grad = opt.gradient || {
      type: 'linear', x: 0, y: 0, x2: horizontal ? 1 : 0, y2: horizontal ? 0 : 1,
      colorStops: [{ offset: 0, color: opt.from || '#1d6f9f' }, { offset: 1, color: opt.to || C.cyan }]
    };
    if (horizontal) {
      base.yAxis = Object.assign(axisY(), {
        type: 'category', data: labels, inverse: true, splitLine: { show: false },
        axisLabel: Object.assign({}, axisLabel, { margin: 10 })
      });
      base.xAxis = axisY({ axisLine: { show: false }, splitLine });
      base.series = [{
        type: 'bar', name: opt.seriesName || '数量', data: values, barMaxWidth: opt.barWidth || 14,
        itemStyle: { color: opt.color || grad, borderRadius: [0, 4, 4, 0] },
        label: opt.showLabel === false ? { show: false } : {
          show: true, position: 'right', color: C.fg2, fontSize: 11, fontFamily: FONT,
          formatter: p => global.U.num(p.value)
        },
        animationDuration: 700, animationEasing: 'cubicOut'
      }];
    } else {
      base.xAxis = axisX({ data: labels, axisLabel: Object.assign({}, axisLabel, { interval: 0, rotate: opt.rotate || 0 }) });
      base.yAxis = axisY({ name: opt.yName || '' });
      const colors = opt.colors || null;
      base.series = [{
        type: 'bar', name: opt.seriesName || '数量', data: values, barMaxWidth: opt.barWidth || 26,
        itemStyle: {
          color: colors ? (p => colors[p.dataIndex % colors.length]) : (opt.color || grad),
          borderRadius: [4, 4, 0, 0]
        },
        label: opt.showLabel ? {
          show: true, position: 'top', color: C.fg2, fontSize: 11, fontFamily: FONT,
          formatter: p => global.U.num(p.value)
        } : { show: false },
        animationDuration: 700, animationEasing: 'cubicOut'
      }];
    }
    return base;
  }

  function pie(data, opt) {
    opt = opt || {};
    return {
      backgroundColor: 'transparent',
      title: opt.title ? title(opt.title, opt.subtitle) : undefined,
      tooltip: tooltip({ trigger: 'item', formatter: p => `${p.marker}<b>${p.name}</b><br/>${global.U.num(p.value)} ${opt.unit || '条'}（${p.percent}%）` }),
      legend: opt.legend === false ? { show: false } : {
        type: 'scroll', bottom: 0, left: 'center', itemWidth: 9, itemHeight: 9,
        textStyle: { color: C.fg2, fontSize: 11, fontFamily: FONT }, pageTextStyle: { color: C.fg3 }
      },
      series: [{
        type: 'pie', radius: opt.radius || ['42%', '66%'], center: opt.center || ['50%', '50%'],
        avoidLabelOverlap: true, data, minAngle: 2,
        label: opt.label === false ? { show: false } : {
          show: true, color: C.fg2, fontSize: 11, fontFamily: FONT,
          formatter: opt.labelFmt || '{b}\n{d}%'
        },
        labelLine: { length: 8, length2: 8, lineStyle: { color: 'rgba(120,160,200,.5)' } },
        itemStyle: { borderColor: 'rgba(6,16,28,.9)', borderWidth: 2 },
        emphasis: { scale: true, scaleSize: 6, itemStyle: { shadowBlur: 16, shadowColor: 'rgba(63,198,255,.5)' } },
        animationType: 'scale', animationDuration: 700
      }]
    };
  }

  function line(buckets, series, opt) {
    opt = opt || {};
    return {
      backgroundColor: 'transparent',
      title: opt.title ? title(opt.title, opt.subtitle) : undefined,
      tooltip: tooltip({ trigger: 'axis' }),
      legend: { show: (opt.legend !== false) && series.length > 1, top: 2, right: 8, itemWidth: 10, itemHeight: 8, textStyle: { color: C.fg2, fontSize: 11 } },
      grid: opt.grid || { left: 44, right: 22, top: opt.title ? 46 : 30, bottom: 24, containLabel: true },
      xAxis: axisX({
        data: buckets, boundaryGap: false,
        axisLabel: Object.assign({}, axisLabel, {
          fontSize: 10, rotate: opt.rotate === undefined ? 0 : opt.rotate,
          formatter: v => (typeof v === 'string' && v.length > 10 ? v.slice(opt.sliceFrom === undefined ? 5 : opt.sliceFrom) : v)
        })
      }),
      yAxis: axisY({ name: opt.yName || '', minInterval: opt.minInterval || 1 }),
      series: series.map(s => ({
        name: s.name, type: 'line', smooth: opt.smooth !== false, symbol: 'circle', symbolSize: 5,
        showSymbol: opt.showSymbol !== false && buckets.length < 40,
        data: s.data,
        lineStyle: { width: 2, color: s.color, shadowBlur: 8, shadowColor: s.color + '66' },
        itemStyle: { color: s.color },
        areaStyle: s.area === false ? undefined : {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: s.color + '4d' }, { offset: 1, color: s.color + '00' }]
          }
        },
        animationDuration: 800
      }))
    };
  }

  function scatter(data, opt) {
    opt = opt || {};
    return {
      backgroundColor: 'transparent',
      title: opt.title ? title(opt.title, opt.subtitle) : undefined,
      tooltip: tooltip({ formatter: opt.formatter }),
      grid: opt.grid || { left: 52, right: 24, top: opt.title ? 44 : 22, bottom: 42, containLabel: true },
      xAxis: axisY(Object.assign({ name: opt.xName || '', scale: true, splitLine }, { axisLine: { show: false }, axisTick: { show: false } })),
      yAxis: axisY(Object.assign({ name: opt.yName || '', scale: true, splitLine }, { axisLine: { show: false }, axisTick: { show: false } })),
      series: [{
        type: 'scatter', data, symbolSize: opt.symbolSize || 7,
        itemStyle: {
          color: opt.color || C.cyan, opacity: .72,
          borderColor: 'rgba(255,255,255,.28)', borderWidth: .5,
          shadowBlur: 6, shadowColor: 'rgba(63,198,255,.35)'
        },
        emphasis: { itemStyle: { opacity: 1, borderColor: '#fff', borderWidth: 1 } },
        animationDuration: 600
      }]
    };
  }

  /* ---------------- 地图 ---------------- */
  /* 地图视觉规范：面用"行政区底色"，线用青色描边，悬停高亮 */
  function geoStyle(extra) {
    return Object.assign({
      map: '',
      roam: true,
      scaleLimit: { min: .8, max: 12 },
      zoom: 1.16,
      layoutCenter: ['50%', '54%'],
      layoutSize: '96%',
      itemStyle: {
        areaColor: 'rgba(16,42,68,.72)',
        borderColor: 'rgba(88,168,230,.45)',
        borderWidth: .8,
        shadowColor: 'rgba(63,198,255,.28)',
        shadowBlur: 12
      },
      emphasis: {
        disabled: false,
        itemStyle: { areaColor: 'rgba(63,198,255,.30)', borderColor: C.mint, borderWidth: 1.4 },
        label: { show: true, color: '#fff', fontSize: 12, fontWeight: 600, textShadowColor: '#000', textShadowBlur: 6 }
      },
      select: { disabled: true },
      label: { show: false }
    }, extra || {});
  }

  /* 地图容器基础 option：一个 geo 组件 + 若干挂在其上的 series */
  function mapOption(mapName, opts) {
    opts = opts || {};
    const o = {
      backgroundColor: 'transparent',
      tooltip: tooltip(opts.tooltipOpt || {}),
      geo: geoStyle(Object.assign({ map: mapName }, opts.geo || {})),
      series: opts.series || []
    };
    if (opts.visualMap) o.visualMap = opts.visualMap;
    if (opts.legend) o.legend = opts.legend;
    return o;
  }

  /* 预警等级分段色带：直接复用官方四色，颜色本身就是语义 */
  function levelVisualMap(opt) {
    opt = opt || {};
    return {
      type: 'piecewise',
      pieces: [
        { value: 4, label: '红色预警（最高）', color: C.lv['红色'] },
        { value: 3, label: '橙色预警', color: C.lv['橙色'] },
        { value: 2, label: '黄色预警', color: C.lv['黄色'] },
        { value: 1, label: '蓝色预警', color: C.lv['蓝色'] },
        { value: 0, label: '无预警', color: 'rgba(22,48,74,.6)' }
      ],
      left: 12, bottom: 16, itemWidth: 13, itemHeight: 10,
      textStyle: { color: C.fg2, fontSize: 11, fontFamily: FONT },
      itemGap: 5, borderColor: 'transparent', backgroundColor: 'transparent',
      show: opt.show !== false,
      seriesIndex: opt.seriesIndex === undefined ? 0 : opt.seriesIndex
    };
  }

  /* 连续色带（站点温度/湿度这类连续量） */
  function valueVisualMap(min, max, colors, opt) {
    opt = opt || {};
    return {
      type: 'continuous', min, max,
      calculable: true, orient: 'vertical',
      right: 14, bottom: 22, itemHeight: 120, itemWidth: 11,
      textStyle: { color: C.fg2, fontSize: 11, fontFamily: FONT },
      inRange: { color: colors || ['#1b4f8a', '#2f9bff', '#41d6c3', '#ffd233', '#ff8a00', '#ff3b47'] },
      text: opt.text || undefined,
      seriesIndex: opt.seriesIndex === undefined ? 0 : opt.seriesIndex,
      show: opt.show !== false
    };
  }

  global.T = {
    C, FONT, axisX, axisY, title, tooltip,
    bar, pie, line, scatter,
    geoStyle, mapOption, levelVisualMap, valueVisualMap
  };

  /* ============================================================
     MapHub —— 行政区划地图懒加载与注册
     三级下钻：100000(全国) -> {省adcode} -> c{市adcode}
     ============================================================ */
  const registered = new Set();
  const pending = new Map();

  const MapHub = {
    /* 返回可直接用于 series.map / geo.map 的地图名 */
    async use(adcode) {
      const code = String(adcode);
      const key = 'ts-' + code;
      if (registered.has(key)) return key;
      if (pending.has(key)) return pending.get(key);
      const p = API.geo(code).then(geo => {
        // 名称去掉"市/省"等后缀差异带来的匹配问题：以 GeoJSON 自身为准
        echarts.registerMap(key, geo);
        registered.add(key);
        pending.delete(key);
        return key;
      }).catch(e => { pending.delete(key); throw e; });
      pending.set(key, p);
      return p;
    },
    /* 该地图是否已经注册（用于避免重复动画） */
    has(adcode) { return registered.has('ts-' + adcode); }
  };
  global.MapHub = MapHub;
})(window);
