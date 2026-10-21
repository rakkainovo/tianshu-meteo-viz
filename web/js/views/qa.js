/* ============================================================
   views/qa.js —— 智能问答
   自然语言提问 -> 意图解析 -> SQL 查询 -> 结论 + 图表
   ============================================================ */
(function () {
  'use strict';

  const RECOMMEND = [
    '沙坪坝站现在气温多少？',
    '沙坪坝站明天天气怎么样？',
    '北京和上海哪个更热？',
    '沙坪坝站最近24小时气温变化如何？',
    '上海现在多少度？',
    '今日重庆各个站点的天气',
    '明天上海要带伞吗？',
    '深圳穿什么衣服合适？',
    '广州适合晾晒吗？',
    '暴雨预警的地方现在在下雨吗？',
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
    '今天星期几？',
    '现在几点？'
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
        out.push('<div class="qa-table-scroll"><table class="tbl" style="margin-top:8px"><thead><tr>' +
          head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
          body.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>');
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
    props: { meta: Object, ctx: Object, route: Object },
    data() {
      return {
        q: '', busy: false,
        msgs: [],
        recommend: RECOMMEND,
        last: null,
        cap: null,                                  // 问答引擎通道状态（规则 / 大模型）
        conversation: {},
        micOk: false, mic: false                    // 语音输入：是否支持 / 是否正在监听
      };
    },
    created() {
      this.msgs.push({ role: 'bot', intent: 'greeting', text: '你好，今天想了解哪个站点或地区的天气？' });
      try {
        const saved = JSON.parse(sessionStorage.getItem('tianshu.qa.v2') || 'null');
        if (saved && Array.isArray(saved.msgs) && saved.msgs.length) {
          this.msgs = saved.msgs.filter(m => !m.loading).slice(-40);
          this.conversation = saved.context || {};
          this.last = [...this.msgs].reverse().find(m => m.role === 'bot' && m.intent !== 'greeting') || null;
        }
      } catch (e) { /* Storage is optional. */ }
      API.qaCapability().then(c => {
        this.cap = c || null;
      }).catch(() => {});
      this.$nextTick(() => { this.drawAll(); this.refreshIcons(); this.scroll(); });
      /* 语音输入依赖 Web Speech API：不支持就不渲染麦克风按钮 */
      this.micOk = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },
    beforeUnmount() {
      this.stopMic();
      Object.values(this._qaCharts || {}).forEach(c => { try { c.dispose(); } catch (e) {} });
    },
    methods: {
      html(t) { return md(t); },
      refreshIcons() { if (window.lucide) window.lucide.createIcons(); },
      saveConversation() {
        try { sessionStorage.setItem('tianshu.qa.v2', JSON.stringify({ msgs: this.msgs.slice(-40), context: this.conversation })); }
        catch (e) { /* Storage quota must not interrupt the conversation. */ }
      },
      newConversation() {
        if (this.busy) return;
        Object.values(this._qaCharts || {}).forEach(c => { try { c.dispose(); } catch (e) {} });
        this._qaCharts = {}; this._qaEls = {};
        this.msgs = [{ role: 'bot', intent: 'greeting', text: '你好，今天想了解哪个站点或地区的天气？' }];
        this.conversation = {}; this.last = null; this.q = ''; this.recommend = RECOMMEND;
        this.saveConversation();
      },
      chooseStation(m, station) {
        this.conversation = Object.assign({}, this.conversation, { pending_question: m.question });
        this.ask(station.province + '·' + station.name + '站（' + station.code + '）', station.code);
      },
      scopeText() {
        const scopes = this.conversation.scopes || [];
        if (scopes.length) return scopes.map(s => s.name + (s.kind === 'station' ? '站 · ' + s.code : '')).join(' / ');
        return this.ctx && this.ctx.station_name ? this.ctx.station_province + '·' + this.ctx.station_name + '站' : '未指定';
      },
      /* 语音输入：说一句 -> 转文字 -> 自动提问。中途可再点一次停止 */
      toggleMic() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { this.flash('当前浏览器不支持语音输入', 'warn'); return; }
        if (this.mic) { this.stopMic(); return; }
        const rec = new SR();
        rec.lang = 'zh-CN';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        this._rec = rec;
        rec.onresult = e => {
          const t = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript;
          if (t) { this.q = t; this.ask(); }
        };
        rec.onerror = e => {
          this.stopMic();
          if (e && e.error && e.error !== 'aborted' && e.error !== 'no-speech') {
            this.flash('语音识别失败：' + e.error, 'warn');
          }
        };
        rec.onend = () => { this.mic = false; };
        this.mic = true;
        try { rec.start(); } catch (err) { this.mic = false; this.flash('无法启动语音输入', 'warn'); }
      },
      stopMic() {
        if (this._rec) { try { this._rec.stop(); } catch (e) { /* ignore */ } this._rec = null; }
        this.mic = false;
      },
      async ask(text, selection) {
        const q = (text || this.q || '').trim();
        if (!q || this.busy) return;
        this.q = '';
        const messages = this.msgs.filter(m => m.intent !== 'greeting' && !m.loading)
          .slice(-8).map(m => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text.slice(0, 1500) }));
        this.msgs.push({ role: 'me', text: q });
        const holder = { role: 'bot', text: '正在解析问题并查询数据集 …', loading: true };
        this.msgs.push(holder);
        this.busy = true;
        this.scroll();
        try {
          const r = await API.qa(q, { context: this.conversation, page_context: this.ctx || {},
            messages, selection: typeof selection === 'string' ? selection : undefined });
          Object.assign(holder, {
            text: r.answer || '（无结果）',
            answerRule: r.answer_rule || '',       // 大模型润色前的规则原文，可对照
            evidence: r.evidence || null,          // 数据截止时刻 + 支撑 SQL，可自证
            chart: r.chart || null,
            intent: r.intent, engine: r.engine, sql: r.sql,
            slots: r.slots, focus: r.focus,
            question: r.question || q,
            candidates: r.candidates || [],
            loading: false
          });
          this.last = holder;
          if (r.context) this.conversation = r.context;
          this.recommend = r.suggestions && r.suggestions.length ? r.suggestions : RECOMMEND;
          this.saveConversation();
        } catch (e) {
          Object.assign(holder, { text: '查询失败：' + (e.message || e), loading: false, intent: 'error' });
        } finally {
          this.busy = false;
          this.scroll();
          this.$nextTick(() => { this.drawAll(); this.refreshIcons(); window.dispatchEvent(new Event('resize')); });
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
          station_now: '城市实时天气', station_list: '站点实况清单',
          station_detail: '实况查询', station_forecast: '逐日预报', station_history: '单站历史',
          station_alarms: '所在地预警', weather_tools: '组合查询', clarify: '待确认',
          station_compare: '气象对比',
          weather_summary: '天气概况',
          typhoon_overview: '台风总览', typhoon_strongest: '台风强度', typhoon_path: '台风路径',
          overview: '态势总结',
          advice: '生活建议',
          alarm_live_check: '预警×实况关联', free_llm: '自由问答',
          clock: '日历 / 时钟',
          unknown: '未识别', error: '异常', greeting: '—'
        })[it] || it;
      },
      /* 证据链的行：后端给什么就显示什么（不再写死三个键），
         否则"日历/时钟"这类回答的「回答依据 / 服务端时间」会渲染不出来 */
      evidenceRows(ev) {
        const LAB = { '最新预警时间': '最新预警发布' };
        return Object.entries(ev || {})
          .filter(([k, v]) => k !== '支撑 SQL' && v)
          .map(([k, v]) => ({ k: k, label: LAB[k] || k, v: v }));
      },
      /* 生成方式：把"数字是谁算的、话是谁说的"讲清楚 */
      engineCn(e) {
        return ({
          rule: '规则引擎（结论可复现）',
          data: '数据查询', tools: '工具查询', 'tools+llm': '工具查询 + 模型解读',
          'rule+llm': '规则查数 + 大模型解读',
          llm: '大模型',
          'llm+llm': '大模型（解析 + 解读）',
          error: '异常'
        })[e] || e;
      }
    },
    template: `
    <div class="qa-wrap">
      <div class="qa-main">
        <div class="panel" style="flex:1;min-height:0">
          <div class="panel-head"><h3>对话分析</h3>
            <button class="btn ghost qa-new" @click="newConversation" :disabled="busy" title="开始新对话" aria-label="开始新对话"><i data-lucide="message-square-plus"></i></button></div>
          <div class="panel-body" style="display:flex;flex-direction:column;min-height:0">
            <div class="qa-stream" ref="stream">
              <div v-for="(m,i) in msgs" :key="i" class="qa-msg" :class="{me: m.role==='me'}">
                <div class="qa-avatar">{{ m.role==='me' ? '我' : '枢' }}</div>
                <div class="qa-bubble">
                  <div v-if="m.loading" class="t-muted">{{ m.text }}</div>
                  <div v-else v-html="html(m.text)"></div>
                  <div class="qa-candidates" v-if="m.candidates && m.candidates.length">
                    <button class="btn ghost" v-for="s in m.candidates" :key="s.code" :disabled="busy || m !== last"
                            @click="chooseStation(m, s)">{{ s.province }} · {{ s.name }}站 · {{ s.code }}</button>
                  </div>

                  <div v-if="m.chart" class="qa-chart"
                       :ref="el => registerChart(i, el)"></div>

                  <div class="qa-meta" v-if="m.context">
                    <code>{{ m.context }}</code>
                  </div>

                  <div class="qa-meta" v-if="m.intent && m.intent !== 'greeting'">
                    <span>意图：<b style="color:#3fc6ff">{{ intentCn(m.intent) }}</b></span>
                    <span>生成：{{ engineCn(m.engine) }}</span>
                    <span v-if="m.slots && Object.keys(m.slots).length">
                      条件：{{ Object.entries(m.slots).map(([k,v]) => k+'='+v).join('，') }}</span>
                  </div>

                  <!-- 证据链：让每个结论都能自己证明不是编的 -->
                  <div class="qa-evidence" v-if="evidenceRows(m.evidence).length">
                    <div class="qe-head">数据依据</div>
                    <div class="qe-row" v-for="r in evidenceRows(m.evidence)" :key="r.k">
                      <span>{{ r.label }}</span><b>{{ r.v }}</b></div>
                  </div>

                  <details class="qa-rule" v-if="m.answerRule">
                    <summary>查看规则引擎原始结论（未被模型改写）</summary>
                    <div v-html="html(m.answerRule)"></div>
                  </details>

                  <details v-if="m.sql" class="qa-rule"><summary>查询依据</summary><pre>{{ m.sql }}</pre></details>

                  <div style="margin-top:8px" v-if="m.focus">
                    <button class="btn ghost" @click="$emit('goto', m.focus.view, m.focus.params)">查看站点详情 ›</button>
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
                <input type="text" v-model="q" placeholder="例如：沙坪坝站现在气温多少？" maxlength="2000" aria-label="气象问题"
                       @keyup.enter="ask()" :disabled="busy">
                <button v-if="micOk" class="btn ghost qa-mic" :class="{ listening: mic }"
                        @click="toggleMic" :title="mic ? '停止语音输入' : '语音输入（对着麦克风说出问题）'">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>
                </button>
                <button class="btn primary" @click="ask()" :disabled="busy">
                  {{ busy ? '查询中…' : '提问' }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="qa-side">
        <div class="panel" style="flex:0 0 auto">
          <div class="panel-head"><h3>查询上下文</h3></div>
          <div class="panel-body t-sub" style="font-size:12.5px;line-height:1.85">
            <div class="qa-scope-label">当前对象</div><div class="qa-scope-value">{{ scopeText() }}</div>
            <div v-if="conversation.start" class="qa-scope-label">{{ conversation.start }}<template v-if="conversation.end && conversation.end !== conversation.start"> 至 {{ conversation.end }}</template></div>

            <div style="margin-top:9px;padding-top:8px;border-top:1px solid rgba(90,140,200,.18)">
              <b class="t-strong">数据连接</b>　本地气象库
              <template v-if="cap">
                <span :style="{color: cap.llm_ready ? '#3ddc97' : '#8fa6c0'}">
                  {{ cap.llm_ready ? ' · 大模型已启用' : ' · 大模型未配置' }}</span>
                <div v-if="cap.llm_ready" style="color:#7d93ad;font-size:11.5px;line-height:1.6">
                  {{ cap.llm_model }} · {{ cap.llm_host }}</div>
              </template>
            </div>
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
                <div class="v" style="font-size:14px">{{ engineCn(last.engine) }}</div></div>
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
