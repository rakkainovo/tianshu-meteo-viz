/* ============================================================
   views/qa.js —— 智能问答
   自然语言提问 -> 意图解析 -> SQL 查询 -> 结论 + 图表
   ============================================================ */
(function () {
  'use strict';

  const RECOMMEND = [
    '现在有多少条预警？',
    '哪个省的预警最多？',
    '广东省有哪些预警？',
    '全国最高气温出现在哪里？',
    '最冷的地方是哪里？',
    '预警的等级分布如何？',
    '灾种构成是怎样的？',
    '预警数量随时间怎么变化？',
    '广东和湖南哪个预警更多？',
    '最强的台风是哪个？',
    '现在整体形势怎么样？',
    '红色预警有几条？'
  ];

  /* 轻量 Markdown 渲染：只覆盖问答结论里实际用到的语法 */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#7cf6d8">$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function md(text) {
    const lines = String(text || '').split('\n');
    const out = [];
    let list = [], table = [];
    const flushList = () => {
      if (list.length) { out.push('<ul>' + list.map(x => '<li>' + inline(x) + '</li>').join('') + '</ul>'); list = []; }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter(r => !/^\|[\s:|-]+\|$/.test(r.trim()))
        .map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      if (rows.length) {
        const head = rows[0], body = rows.slice(1);
        out.push('<table class="tbl" style="margin-top:8px"><thead><tr>' +
          head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
          body.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>');
      }
      table = [];
    };
    lines.forEach(raw => {
      const l = raw.trim();
      if (l.startsWith('|')) { flushList(); table.push(l); return; }
      if (/^[-•]\s+/.test(l)) { flushTable(); list.push(l.replace(/^[-•]\s+/, '')); return; }
      flushList(); flushTable();
      if (l) out.push('<p>' + inline(l) + '</p>');
      else out.push('<div style="height:6px"></div>');
    });
    flushList(); flushTable();
    return out.join('');
  }

  window.ViewQA = {
    name: 'v-qa',
    props: { meta: Object, ctx: Object },
    data() {
      return {
        q: '', busy: false,
        msgs: [],
        recommend: RECOMMEND,
        last: null
      };
    },
    created() {
      this.msgs.push({
        role: 'bot',
        text: '你好，我是**天枢问答助手**。\n\n' +
          '我接入的是本平台自采的气象数据集——**208 条实时预警**、**2528 个气象观测站**、' +
          '**28 个台风**的完整路径。你可以直接用大白话问我，我会把答案算出来，' +
          '顺便画一张图。\n\n试试下面这些问题，或者直接打字问我：',
        intent: 'greeting'
      });
      this.$nextTick(() => this.drawAll());
    },
    beforeUnmount() {
      Object.values(this._qaCharts || {}).forEach(c => { try { c.dispose(); } catch (e) {} });
    },
    methods: {
      html(t) { return md(t); },
      async ask(text) {
        const q = (text || this.q || '').trim();
        if (!q || this.busy) return;
        this.q = '';
        this.msgs.push({ role: 'me', text: q });
        const holder = { role: 'bot', text: '正在解析问题并查询数据集 …', loading: true };
        this.msgs.push(holder);
        this.busy = true;
        this.scroll();
        try {
          const r = await API.qa(q);
          Object.assign(holder, {
            text: r.answer || '（无结果）',
            chart: r.chart || null,
            intent: r.intent, engine: r.engine, sql: r.sql,
            slots: r.slots, focus: r.focus,
            loading: false
          });
          this.last = holder;
        } catch (e) {
          Object.assign(holder, { text: '查询失败：' + (e.message || e), loading: false, intent: 'error' });
        } finally {
          this.busy = false;
          this.scroll();
          this.$nextTick(() => { this.drawAll(); window.dispatchEvent(new Event('resize')); });
        }
      },
      scroll() {
        this.$nextTick(() => {
          const el = this.$refs.stream;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },
      registerChart(i, el) {
        if (!el) return;
        this._els = this._els || {};
        this._els[i] = el;
        this.$nextTick(() => this.draw(i));
      },
      draw(i) {
        const el = (this._els || {})[i];
        const opt = this.msgs[i] && this.msgs[i].chart;
        if (!el || !opt) return;
        this._qaCharts = this._qaCharts || {};
        let c = echarts.getInstanceByDom(el);
        if (!c) c = echarts.init(el, 'tianshu', { renderer: 'canvas' });
        c.setOption(opt, true);
        c.resize();
        this._qaCharts[i] = c;
      },
      drawAll() {
        this.msgs.forEach((m, i) => { if (m.chart) this.draw(i); });
      },
      intentCn(it) {
        return ({
          count: '数量统计', filter_list: '条件筛选', rank_province: '省份排名',
          rank_city: '城市排名', rank_issuer: '发布单位排名', level_dist: '等级分布',
          type_dist: '灾种分布', trend: '时间趋势', compare: '地区对比',
          station_extreme: '要素极值', station_rank: '要素排名', station_count: '站点统计',
          weather_summary: '天气概况',
          typhoon_overview: '台风总览', typhoon_strongest: '台风强度', typhoon_path: '台风路径',
          overview: '态势总结', unknown: '未识别', error: '异常', greeting: '—'
        })[it] || it;
      }
    },
    template: `
    <div class="qa-wrap">
      <div class="qa-main">
        <div class="panel" style="flex:1;min-height:0">
          <div class="panel-head"><h3>对话分析</h3>
            <span class="sub">答案中的每个数字都可追溯到一条 SQL</span></div>
          <div class="panel-body" style="display:flex;flex-direction:column;min-height:0">
            <div class="qa-stream" ref="stream">
              <div v-for="(m,i) in msgs" :key="i" class="qa-msg" :class="{me: m.role==='me'}">
                <div class="qa-avatar">{{ m.role==='me' ? '我' : '枢' }}</div>
                <div class="qa-bubble">
                  <div v-if="m.loading" style="color:#6f89a6">{{ m.text }}</div>
                  <div v-else v-html="html(m.text)"></div>

                  <div v-if="m.chart" class="qa-chart"
                       :ref="el => registerChart(i, el)"></div>

                  <div class="qa-meta" v-if="m.context">
                    <code>{{ m.context }}</code>
                  </div>

                  <div class="qa-meta" v-if="m.intent && m.intent !== 'greeting'">
                    <span>意图：<b style="color:#3fc6ff">{{ intentCn(m.intent) }}</b></span>
                    <span>解析：{{ m.engine === 'llm' ? '大模型增强' : '规则引擎' }}</span>
                    <span v-if="m.slots && Object.keys(m.slots).length">
                      条件：{{ Object.entries(m.slots).map(([k,v]) => k+'='+v).join('，') }}</span>
                  </div>
                  <pre v-if="m.sql">{{ m.sql }}</pre>

                  <div style="margin-top:8px" v-if="m.focus">
                    <button class="btn ghost" @click="$emit('goto', m.focus.view)">前往查看 ›</button>
                  </div>
                </div>
              </div>
            </div>

            <div style="margin-top:10px">
              <div class="qa-sug" style="margin-bottom:9px">
                <span class="chip" v-for="s in recommend.slice(0,6)" :key="s"
                      @click="ask(s)" style="font-size:11.5px">{{ s }}</span>
              </div>
              <div class="qa-input">
                <input type="text" v-model="q" placeholder="用大白话提问，例如：湖南省有哪些红色预警？"
                       @keyup.enter="ask()" :disabled="busy">
                <button class="btn primary" @click="ask()" :disabled="busy">
                  {{ busy ? '查询中…' : '提问' }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="qa-side">
        <div class="panel" style="flex:0 0 auto">
          <div class="panel-head"><h3>问答能力</h3></div>
          <div class="panel-body" style="font-size:12.5px;line-height:1.85;color:#a9bdd6">
            支持 6 类问法：<br>
            <b style="color:#e8f0fb">① 计数</b>　现在有多少条预警<br>
            <b style="color:#e8f0fb">② 排名</b>　哪个省预警最多<br>
            <b style="color:#e8f0fb">③ 筛选</b>　广东有哪些暴雨预警<br>
            <b style="color:#e8f0fb">④ 极值</b>　全国最高气温在哪里<br>
            <b style="color:#e8f0fb">⑤ 趋势</b>　预警数量随时间怎么变<br>
            <b style="color:#e8f0fb">⑥ 对比</b>　广东和湖南哪个更多
          </div>
        </div>

        <div class="panel" style="flex:0 0 auto">
          <div class="panel-head"><h3>解析结果</h3>
            <span class="sub">可解释性</span></div>
          <div class="panel-body" v-if="last && last.intent !== 'greeting'">
            <div class="sd-grid" style="grid-template-columns:repeat(2,1fr)">
              <div class="sd-cell"><div class="l">识别意图</div>
                <div class="v" style="font-size:14px">{{ intentCn(last.intent) }}</div></div>
              <div class="sd-cell"><div class="l">解析通道</div>
                <div class="v" style="font-size:14px">{{ last.engine === 'llm' ? '大模型' : '规则引擎' }}</div></div>
            </div>
            <div style="margin-top:10px;font-size:12px;color:#a9bdd6">抽取到的约束条件</div>
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
              <span class="badge lv-yellow" v-for="(v,k) in (last.slots||{})" :key="k">{{ k }} = {{ v }}</span>
              <span v-if="!last.slots || !Object.keys(last.slots).length"
                    style="font-size:12px;color:#6f89a6">无额外约束</span>
            </div>
          </div>
          <div class="panel-body" v-else style="font-size:12.5px;color:#6f89a6">
            提问后会在这里显示意图识别与参数抽取的中间结果。
          </div>
        </div>

        <div class="panel" style="flex:1">
          <div class="panel-head"><h3>全部示例问题</h3></div>
          <div class="panel-body scroll" style="display:flex;flex-direction:column;gap:7px">
            <span class="chip" v-for="s in recommend" :key="s" @click="ask(s)"
                  style="justify-content:flex-start">{{ s }}</span>
          </div>
        </div>
      </div>
    </div>`
  };
})();
