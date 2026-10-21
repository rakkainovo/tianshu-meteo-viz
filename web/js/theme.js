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
    lv: { '蓝色': '#3d7eff', '黄色': '#ffd233', '橙色': '#ff8a00', '红色': '#ff3b47', '未知': '#7a8aa0' },
    /* ------------------------------------------------------------
       行政区「面」用色 —— 与标点色刻意拆成两个层次
       ------------------------------------------------------------
       标点色（C.lv）是预警等级的语义色，任何情况下都不能动；
       但省面若用同一组高饱和亮色，"红面上叠红点、橙面上叠橙点"
       就会糊成一片（改版前实测确如此）。所以面统一走这套
       **同色相、压暗去饱和**的版本：
         面 只回答"这片区域大概什么情况"，
         点 才回答"哪一条预警、什么等级"。
       判据：点的明度约为面的 2 倍以上，点另带白描边，故必然跳出来。
       用法：面颜色**数据驱动**（series.data 逐项 itemStyle.areaColor），
             不再交给 visualMap —— visualMap 留给图例，用等级原色。 */
    lvFace: {
      '蓝色': '#1d3f7c',
      '黄色': '#7d6b22',
      '橙色': '#6d3512',
      '红色': '#6f1d26',
      '未知': '#333d4d'
    },
    /* 连续色带（按条数多少给面上色）的暗色版，冷 -> 暖 */
    faceRamp: ['#12294a', '#17406c', '#1a5163', '#6e5c20', '#7a3d13', '#7c1f29'],
    faceEmpty: '#152a40'
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
    const n = (labels || []).length;
    /* 允许系列数据是 {value, code} 对象：station.js 用它把"站点编号"挂到条形上，
       点击条形即可打开站点详情。
       这带来一个必须处理的差异：标签 formatter 会收到已经降维成数字的 p.value，
       而 axis tooltip 收到的是**整个对象**，直接插值就会渲染成 '[object Object]'。
       所以默认 tooltip 不能再用 p.value，要从 values[i] 取并把对象拆成数值。
       （历史遗留：从前两个分支各自写了一套 label，对象数据能正常显示只是巧合。） */
    const asNum = v => (v !== null && typeof v === 'object') ? v.value : v;
    const base = {
      backgroundColor: 'transparent',
      title: opt.title ? title(opt.title, opt.subtitle) : undefined,
      tooltip: tooltip({
        trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(63,198,255,.08)' } },
        /* opt.formatter 优先：调用方（live.js 的"近 15 分钟已刷新 X / Y 站"）需要
           比"名称：数值"更细的说明。**此前 bar() 从未读取 opt.formatter / opt.max** ——
           两个调用点的参数一直是死代码，静默失效（见审计）。 */
        formatter: opt.formatter || (p => {
          const it = Array.isArray(p) ? p[0] : p;
          const i = (it && it.dataIndex !== undefined) ? it.dataIndex : -1;
          if (i >= 0 && i < n && labels[i] !== undefined) {
            return '<b>' + labels[i] + '</b><br/>' + (opt.seriesName || '数量') +
                   '：<b style="color:' + C.cyan + '">' + global.U.num(asNum(values[i])) + '</b> ' +
                   (opt.unit || '');
          }
          return `<b>${it.name}</b><br/>${opt.seriesName || '数量'}：` +
                 `<b style="color:${C.cyan}">${global.U.num(it.value)}</b> ${opt.unit || ''}`;
        })
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
      /* opt.max：给"占比"这类有天然上限（100%）的量固定量程。
         不读它的话坐标轴会按数据最大值自适应 —— 全是 100% 的省画出来一样长，
         "谁更新鲜"就看不出来了。 */
      base.xAxis = Object.assign(axisY({ axisLine: { show: false }, splitLine }),
                                 opt.max === undefined ? {} : { max: opt.max });
      base.series = [{
        type: 'bar', name: opt.seriesName || '数量', data: values, barMaxWidth: opt.barWidth || 14,
        itemStyle: { color: opt.color || grad, borderRadius: [0, 4, 4, 0] },
        label: opt.showLabel === false ? { show: false } : {
          show: true, position: 'right', color: C.fg2, fontSize: 11, fontFamily: FONT,
          formatter: p => global.U.num(asNum(p.value))
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
  /* 高亮标记叠加层：两张地图页共用的"焦点/悬浮"视觉。
     它们是**常驻**系列（id 固定为 ov-focus / ov-hover），生成 option 时就挂上，
     之后靠 ChartHost.mapOverlay 按 id 增量改 data —— 只有 1~2 个点，
     切来切去几乎零成本；若改成"有焦点才新增 series"就得整套 setOption 重建，
     几百个点每次都要重画。 */
  const OV_FOCUS = 'ov-focus';
  const OV_HOVER = 'ov-hover';

  function overlaySeries(focus, hover) {
    return [
      {
        id: OV_HOVER, type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 9,
        silent: true, data: hover || [], symbolSize: 19,
        /* 空心圆环：不遮挡下面的等级配色 */
        itemStyle: { color: 'rgba(255,255,255,.001)', borderColor: '#fff',
                     borderWidth: 1.3, opacity: .85 }
      },
      {
        id: OV_FOCUS, type: 'effectScatter', coordinateSystem: 'geo', geoIndex: 0, zlevel: 10,
        silent: true, data: focus || [], symbolSize: 15,
        showEffectOn: 'render',
        rippleEffect: { brushType: 'stroke', scale: 3.4, period: 2.2 },
        itemStyle: { color: '#ffffff', borderColor: '#7cf6d8', borderWidth: 1.6,
                     shadowBlur: 16, shadowColor: 'rgba(124,246,216,.85)' },
        label: {
          show: true, position: 'top', distance: 9,
          color: '#eaf4ff', fontSize: 12, fontFamily: FONT, fontWeight: 600,
          backgroundColor: 'rgba(7,18,32,.88)',
          borderColor: 'rgba(124,246,216,.6)', borderWidth: 1,
          borderRadius: 4, padding: [3, 8],
          textShadowColor: '#000', textShadowBlur: 6,
          formatter: p => (p.data && p.data.label) || ''
        }
      }
    ];
  }

  /* 焦点标记的数据项（自带名字标签） */
  function focusItem(lng, lat, label, extra) {
    return Object.assign({ name: label, value: [lng, lat], label }, extra || {});
  }

  /* 按定位精度给一个合适的缩放级别。
     基准：全国图在 zoom=1.18 时刚好装下整个中国（约 62 个经度），
     于是 zoom 越大可视经度跨度越小 —— 区县级要看清单个县及其邻县，
     省级只要看出落在省里哪一块。 */
  const FOCUS_ZOOM = { district: 6.5, county: 6.5, city: 4.6, province: 3.0 };
  function focusZoom(geoLevel) { return FOCUS_ZOOM[geoLevel] || 5.0; }

  /* 地图视觉规范：面用"行政区底色"，线用青色描边
     性能：关闭 emphasis（避免缩放时鼠标移过触发省份高亮重绘），
           去掉 shadowBlur（每帧重绘所有省的阴影是缩放卡顿主因） */
  function geoStyle(extra) {
    return Object.assign({
      map: '',
      roam: true,
      /* 缩放范围：定位到区县级时预设 zoom 已经是 6.5，上限给 32（够看到街区级），
         下限 .5（能退到比全国再多半屏）。
         注：2026-09-25 之前 map 面的重投影是坏的（见 charts.js geoApply 注释），
         缩放"顶不顶住"根本看不出来；修好之后这个上限才真正生效 */
      scaleLimit: { min: .5, max: 32 },
      zoom: 1.16,
      layoutCenter: ['50%', '54%'],
      layoutSize: '96%',
      itemStyle: {
        areaColor: C.faceEmpty,
        borderColor: 'rgba(96,176,238,.5)',
        borderWidth: .8
      },
      emphasis: { disabled: true, label: { show: false } },
      select: { disabled: true },
      label: { show: false }
    }, extra || {});
  }

  /* 地图容器基础 option：一个 geo 组件 + 若干挂在其上的 series
     性能：animation: false —— 筛选点击 / 实时推送 / 回放每帧都是整套
     notMerge 重建，若重放入场动画，几百个点的 tween 是点击卡顿主因；
     effectScatter 的涟漪（rippleEffect）是独立的逐帧特效，不受此开关影响 */
  function mapOption(mapName, opts) {
    opts = opts || {};
    const o = {
      backgroundColor: 'transparent',
      animation: false,
      tooltip: tooltip(opts.tooltipOpt || {}),
      geo: geoStyle(Object.assign({ map: mapName }, opts.geo || {})),
      /* 末尾挂两个常驻的高亮标记层（默认带；只画点、不参与点击） */
      series: (opts.series || []).concat(
        opts.overlay === false ? [] : overlaySeries(opts.focus, opts.hover))
    };
    if (opts.visualMap) o.visualMap = opts.visualMap;
    if (opts.legend) o.legend = opts.legend;
    return o;
  }

  /* 预警等级分段色带：颜色本身就是语义。
     注意这里一律用**标点原色**（C.lv）——它的职责是"图例"，告诉用户
     图上那种亮色代表哪个等级；行政区面另走 lvFace 的暗色版（见 C 注释），
     两者刻意不同，不要再把面接回这个 visualMap 否则点又会被埋掉。 */
  function levelVisualMap(opt) {
    opt = opt || {};
    return {
      type: 'piecewise',
      pieces: [
        { value: 4, label: '红色预警（最高）', color: C.lv['红色'] },
        { value: 3, label: '橙色预警', color: C.lv['橙色'] },
        { value: 2, label: '黄色预警', color: C.lv['黄色'] },
        { value: 1, label: '蓝色预警', color: C.lv['蓝色'] },
        { value: 0, label: '无预警', color: C.faceEmpty }
      ],
      left: 12, bottom: 16, itemWidth: 13, itemHeight: 10,
      textStyle: { color: C.fg2, fontSize: 11, fontFamily: FONT },
      itemGap: 5, borderColor: 'transparent', backgroundColor: 'transparent',
      show: opt.show !== false,
      seriesIndex: opt.seriesIndex === undefined ? 0 : opt.seriesIndex
    };
  }

  /* 面颜色查表：rank(0..4) -> 暗色。0 / 空值 = 无预警底色 */
  const FACE_BY_RANK = [null, '蓝色', '黄色', '橙色', '红色'];
  function faceColor(rank) {
    const k = FACE_BY_RANK[+rank || 0];
    return k ? C.lvFace[k] : C.faceEmpty;
  }

  /* 面颜色连续插值（按条数着色）：t ∈ [0,1] -> 暗色带上的颜色 */
  function rampColor(t) {
    const ramp = C.faceRamp, n = ramp.length - 1;
    t = Math.max(0, Math.min(1, +t || 0));
    const x = t * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
    const parse = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const a = parse(ramp[i]), b = parse(ramp[i + 1]);
    const m = j => Math.round(a[j] + (b[j] - a[j]) * f);
    return 'rgb(' + m(0) + ',' + m(1) + ',' + m(2) + ')';
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
      /* 范围外散点直接透明——realTime 滑块拖动时 ECharts 内部自动处理，
         不需要监听 dataRange 事件手动重载 series.data（那是双重开销） */
      outOfRange: { opacity: 0 },
      text: opt.text || undefined,
      seriesIndex: opt.seriesIndex === undefined ? 0 : opt.seriesIndex,
      show: opt.show !== false
    };
  }

  global.T = {
    C, FONT, axisX, axisY, title, tooltip,
    bar, pie, line, scatter,
    geoStyle, mapOption, levelVisualMap, valueVisualMap,
    faceColor, rampColor,
    overlaySeries, focusItem, focusZoom, OV_FOCUS, OV_HOVER
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
