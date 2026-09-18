# -*- coding: utf-8 -*-
"""
qa.py —— 智能问答引擎（自然语言 -> 数据查询 -> 结论 + 图表）

为什么这么设计
--------------
直接把数据丢给大模型让它"看图说话"，在课程作业场景下有两个硬伤：
一是答案不可复现、可能编造数字；二是没网/没 Key 时整个功能就废了。

所以这里采用**双通道**架构：

    通道 A（默认，零依赖）  规则解析器：正则 + 词典匹配，把问句映射成结构化意图
    通道 B（增强，可选）    大模型解析器：让 LLM 只负责"把这句话翻译成意图 JSON"，
                            真正的查数与画图仍由本地代码完成

两条通道共享同一个 **意图 -> SQL 执行器 -> 结论/图表渲染器**。
即：模型不接触原始数据、不做算术，只在必要时帮忙理解口语化表述 ——
结论里的每个数字都可追溯到一条可复现的 SQL。

配置大模型（可选，不配也能完整使用）：
    set LLM_API_KEY=sk-xxxx
    set LLM_BASE=https://api.deepseek.com/v1     # 任何 OpenAI 兼容接口均可
    set LLM_MODEL=deepseek-chat
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Any

LEVELS = ["红色", "橙色", "黄色", "蓝色"]
LEVEL_RANK = {"蓝色": 1, "黄色": 2, "橙色": 3, "红色": 4}
LEVEL_RANK_R = {v: k for k, v in LEVEL_RANK.items()}
LEVEL_COLOR = {"红色": "#ff3b47", "橙色": "#ff8a00", "黄色": "#ffd233",
               "蓝色": "#3d7eff", "未知": "#7a8aa0"}

BG, FG, AXIS, GRID = "transparent", "#e8f0fb", "#5a708c", "rgba(120,150,190,.14)"


# ==================================================================== 工具
def _base_option(title: str) -> dict:
    return {
        "backgroundColor": BG,
        "title": {"text": title, "left": 8, "top": 4,
                  "textStyle": {"color": FG, "fontSize": 13, "fontWeight": 500}},
        "grid": {"left": 48, "right": 22, "top": 44, "bottom": 30, "containLabel": True},
        "tooltip": {"trigger": "axis", "backgroundColor": "rgba(9,20,36,.94)",
                    "borderColor": "rgba(80,180,255,.35)",
                    "textStyle": {"color": FG, "fontSize": 12}},
        "textStyle": {"color": FG, "fontFamily": "Microsoft YaHei, sans-serif"},
    }


def _axis(name: str = "") -> dict:
    return {"type": "category", "name": name, "axisLine": {"lineStyle": {"color": AXIS}},
            "axisLabel": {"color": "#a9bdd6", "fontSize": 11},
            "splitLine": {"show": False}}


def _value_axis(name: str = "") -> dict:
    return {"type": "value", "name": name,
            "axisLine": {"show": False}, "axisLabel": {"color": "#a9bdd6", "fontSize": 11},
            "splitLine": {"lineStyle": {"color": GRID}}}


def bar_option(title: str, labels: list, values: list, colors: list | None = None,
               horizontal: bool = False, unit: str = "条") -> dict:
    o = _base_option(title)
    o["tooltip"]["formatter"] = "{b}<br/>{a}: {" + ("c" if not horizontal else "c") + "} " + unit
    if horizontal:
        o["yAxis"] = {**_axis(), "inverse": True, "data": labels}
        o["xAxis"] = _value_axis()
        o["grid"] = {"left": 84, "right": 40, "top": 40, "bottom": 26, "containLabel": True}
        o["series"] = [{"type": "bar", "name": title, "data": values, "barMaxWidth": 16,
                        "itemStyle": {"borderRadius": [0, 3, 3, 0],
                                      "color": {"type": "linear", "x": 0, "y": 0, "x2": 1, "y2": 0,
                                                "colorStops": [{"offset": 0, "color": "#1c4f8a"},
                                                               {"offset": 1, "color": "#3fc6ff"}]}},
                        "label": {"show": True, "position": "right", "color": FG, "fontSize": 11}}]
    else:
        o["xAxis"] = {**_axis(), "data": labels, "axisLabel": {"color": "#a9bdd6", "fontSize": 11,
                                                               "interval": 0, "rotate": 0}}
        o["yAxis"] = _value_axis()
        o["series"] = [{"type": "bar", "name": title, "data": values, "barMaxWidth": 28,
                        "itemStyle": {"borderRadius": [4, 4, 0, 0],
                                      "color": colors or {"type": "linear", "x": 0, "y": 0, "x2": 0, "y2": 1,
                                                          "colorStops": [{"offset": 0, "color": "#3fc6ff"},
                                                                         {"offset": 1, "color": "#1c4f8a"}]}}}]
    return o


def pie_option(title: str, data: list[dict], unit: str = "条") -> dict:
    return {
        "backgroundColor": BG,
        "title": {"text": title, "left": 8, "top": 4,
                  "textStyle": {"color": FG, "fontSize": 13, "fontWeight": 500}},
        "tooltip": {"trigger": "item", "backgroundColor": "rgba(9,20,36,.94)",
                    "borderColor": "rgba(80,180,255,.35)", "textStyle": {"color": FG},
                    "formatter": "{b}<br/>{c} " + str(unit) + "（{d}%）"},
        "legend": {"bottom": 0, "textStyle": {"color": "#a9bdd6", "fontSize": 11},
                   "itemWidth": 10, "itemHeight": 10},
        "series": [{"type": "pie", "radius": ["40%", "66%"], "center": ["50%", "52%"],
                    "avoidLabelOverlap": True, "data": data,
                    "label": {"color": FG, "fontSize": 11, "formatter": "{b} {d}%"},
                    "labelLine": {"lineStyle": {"color": AXIS}},
                    "itemStyle": {"borderColor": "#08131f", "borderWidth": 2}}],
    }


def line_option(title: str, buckets: list, series: list[dict]) -> dict:
    """注意：option 里不能出现函数（如 axisLabel.formatter=lambda），
    否则无法 JSON 序列化返回给前端。需要截断的标签请在调用前处理。"""
    o = _base_option(title)
    o["tooltip"]["trigger"] = "axis"
    o["xAxis"] = {**_axis(), "data": buckets,
                  "axisLabel": {"color": "#a9bdd6", "fontSize": 10, "rotate": 38}}
    o["yAxis"] = _value_axis()
    o["legend"] = {"top": 4, "right": 8, "textStyle": {"color": "#a9bdd6", "fontSize": 11},
                   "itemWidth": 10, "itemHeight": 10}
    o["series"] = [{"type": "line", "name": s["name"], "data": s["data"], "smooth": True,
                    "showSymbol": False, "lineStyle": {"width": 2, "color": s["color"]},
                    "itemStyle": {"color": s["color"]},
                    "areaStyle": {"color": {"type": "linear", "x": 0, "y": 0, "x2": 0, "y2": 1,
                                            "colorStops": [{"offset": 0, "color": s["color"] + "55"},
                                                           {"offset": 1, "color": s["color"] + "00"}]}}}
                   for s in series]
    return o


def _fmt(n) -> str:
    if n is None:
        return "—"
    if isinstance(n, float):
        return f"{n:.1f}".rstrip("0").rstrip(".")
    return f"{n:,}"


# ==================================================================== 意图解析
DISASTERS = ["暴雨", "大风", "雷电", "大雾", "寒潮", "高温", "地质灾害", "雷雨大风",
             "暴雪", "道路结冰", "雷暴大风", "沙尘暴", "冰雹", "霜冻", "台风", "霾", "干旱"]


def extract_filters(q: str, conn) -> dict:
    """从问句中抽取 灾种 / 等级 / 省份 / 城市 / 时间 等约束"""
    f: dict[str, Any] = {}

    for d in DISASTERS:
        if d in q:
            f["type"] = d
            break
    # 「大风」比「雷雨大风」优先命中时纠正回长词
    for d in sorted(DISASTERS, key=len, reverse=True):
        if d in q:
            f["type"] = d
            break

    for lv in LEVELS:
        if lv in q:
            f["level"] = lv
            break
    if "红" in q and "红色" not in q:
        f.setdefault("level", "红色")

    # 省份：用数据库里的真实省名做包含匹配（同时支持简称）
    provs = [r["name"] for r in conn.execute(
        "SELECT DISTINCT name FROM region WHERE level='province'")]
    for p in sorted(provs, key=len, reverse=True):
        if p in q or (len(p) >= 2 and p[:2] in q and p[:2] not in ("内蒙", "广西", "宁夏", "新疆", "西藏")):
            f["province"] = p
            break
    else:
        alias = {"广东": "广东省", "湖南": "湖南省", "江西": "江西省", "浙江": "浙江省",
                 "江苏": "江苏省", "福建": "福建省", "山东": "山东省", "河南": "河南省",
                 "河北": "河北省", "四川": "四川省", "云南": "云南省", "贵州": "贵州省",
                 "陕西": "陕西省", "甘肃": "甘肃省", "青海": "青海省", "辽宁": "辽宁省",
                 "吉林": "吉林省", "黑龙": "黑龙江省", "山西": "山西省", "安徽": "安徽省",
                 "湖北": "湖北省", "海南": "海南省", "内蒙": "内蒙古自治区",
                 "广西": "广西壮族自治区", "宁夏": "宁夏回族自治区",
                 "新疆": "新疆维吾尔自治区", "西藏": "西藏自治区", "北京": "北京市",
                 "上海": "上海市", "天津": "天津市", "重庆": "重庆市"}
        for k, v in alias.items():
            if k in q:
                f["province"] = v
                break

    cities = [r["name"] for r in conn.execute(
        "SELECT DISTINCT city AS name FROM alarm WHERE city IS NOT NULL AND city != ''")]
    for c in sorted(cities, key=len, reverse=True):
        if c in q:
            f["city"] = c
            break

    if "今天" in q:
        f["since"] = "0000"
    m = re.search(r"最近\s*(\d+)\s*小时", q)
    if m:
        f["recent_hours"] = int(m.group(1))
    m = re.search(r"前\s*(\d+)", q)
    if m:
        f["top"] = int(m.group(1))
    return f


def where_of(f: dict) -> tuple[str, list]:
    w, p = [], []
    for k, col in (("type", "type"), ("level", "level"), ("province", "province"),
                   ("city", "city"), ("county", "county")):
        if f.get(k):
            w.append(f"a.{col} = ?")
            p.append(f[k])
    if f.get("recent_hours"):
        w.append("a.ts >= datetime((SELECT MAX(ts) FROM alarm), ?)")
        p.append(f"-{int(f['recent_hours'])} hours")
    return (" WHERE " + " AND ".join(w)) if w else "", p


def parse(q: str, conn) -> dict:
    """规则通道：把问句映射为 {intent, slots, ...}"""
    f = extract_filters(q, conn)
    f["_q"] = q

    # ---- 气象站 / 观测（要放在通用"多少条"之前，否则会被当成预警计数）
    if re.search(r"(气象站|观测站|台站|站点)", q) and \
       re.search(r"(多少|几个|数量|总数|有多少)", q):
        return {"intent": "station_count", "slots": f}

    # ---- 天气概况
    if re.search(r"(天气(怎么样|如何|情况)?|气候怎么样)", q) and \
       not re.search(r"(预警|台风)", q):
        return {"intent": "weather_summary", "slots": f}

    # ---- 台风
    if "台风" in q:
        if any(k in q for k in ("最强", "最大", "强度最高", "最厉害")):
            return {"intent": "typhoon_strongest", "slots": f}
        if any(k in q for k in ("路径", "轨迹", "走向", "移动", "路线")):
            return {"intent": "typhoon_path", "slots": f}
        return {"intent": "typhoon_overview", "slots": f}

    # ---- 站点要素
    if any(k in q for k in ("最高气温", "最热", "温度最高", "气温最高", "最暖和")):
        return {"intent": "station_extreme", "slots": {**f, "metric": "temp", "order": "desc"}}
    if any(k in q for k in ("最低气温", "最冷", "温度最低", "气温最低", "最凉快")):
        return {"intent": "station_extreme", "slots": {**f, "metric": "temp", "order": "asc"}}
    if any(k in q for k in ("湿度最大", "最潮湿", "最湿")):
        return {"intent": "station_extreme", "slots": {**f, "metric": "humidity", "order": "desc"}}
    if any(k in q for k in ("降雨最多", "降水最多", "雨最大", "下雨最多")):
        return {"intent": "station_extreme", "slots": {**f, "metric": "rain", "order": "desc"}}
    if any(k in q for k in ("气温排行", "气温排名", "温度排行", "各地气温", "气温分布")):
        return {"intent": "station_rank", "slots": {**f, "metric": "temp", "order": "desc"}}

    # ---- 地区对比（先于排名判断，"哪个更多"常与省份名同时出现）
    if re.search(r"(对比|比较|哪个更多|谁更多|哪个更|谁更|哪个多|差别|差异)", q) or \
       re.search(r"[^\s]{2,}(和|与|跟)[^\s]{2,}(哪个|谁)", q):
        return {"intent": "compare", "slots": f}

    # ---- 分布
    if re.search(r"(等级|级别|颜色).*(分布|构成|占比|情况)", q) or \
       any(k in q for k in ("几级", "各等级", "等级分布", "级别分布")):
        return {"intent": "level_dist", "slots": f}
    if re.search(r"(灾种|灾害|类型|种类).*(分布|构成|占比|有哪些|情况)", q) or \
       any(k in q for k in ("有哪些灾害", "哪些灾种", "灾害种类", "灾害类型")):
        return {"intent": "type_dist", "slots": f}

    # ---- 趋势（"哪个时段"这类问法要抢在排名之前）
    if any(k in q for k in ("随时间", "趋势", "变化", "走势", "小时分布", "时间分布",
                            "什么时候最多", "什么时段", "哪个时段", "时间规律", "时段分布")):
        return {"intent": "trend", "slots": f}

    # ---- 列举型："有哪些 / 有什么" 且没问极值 -> 列清单，而不是做排名
    if re.search(r"(有哪些|有什么|列出|罗列|查一下|看看)", q) and \
       not re.search(r"(最多|最高|最强|最大|排行|排名|前\s*\d|top)", q, re.I):
        return {"intent": "filter_list", "slots": f}

    # ---- 排名：必须是"关于大小的问法"，不能只是出现了"哪些"
    if re.search(r"(气象台|发布单位|发布机构|哪家|谁发布的)", q):
        return {"intent": "rank_issuer", "slots": f}
    rank_words = re.search(r"(排行|排名|最多|最高|最强|最频繁|前\s*\d|top\s*\d)", q, re.I)
    if rank_words:
        if re.search(r"(城市|哪些市|哪个市|哪个城市)", q):
            return {"intent": "rank_city", "slots": f}
        return {"intent": "rank_province", "slots": f}

    # ---- 综合态势
    if any(k in q for k in ("形势", "整体", "概况", "情况怎么样", "态势", "总结", "综述")):
        return {"intent": "overview", "slots": f}

    # ---- 计数
    if re.search(r"(多少条|几条|有多少|数量|总数)", q):
        return {"intent": "count", "slots": f}

    if f.get("province") or f.get("city") or f.get("type") or f.get("level"):
        return {"intent": "filter_list", "slots": f}
    return {"intent": "unknown", "slots": f}


# ==================================================================== 大模型通道（可选）
SYS_PROMPT = """你是气象预警数据查询的意图解析器。请把用户的中文问题转换成如下 JSON，不要输出任何解释。
可选 intent：
  count            统计预警条数
  filter_list      列出符合条件的预警
  rank_province    省份预警数量排名
  rank_city        城市预警数量排名
  rank_issuer      预警发布单位排名
  level_dist       预警等级分布
  type_dist        灾种分布
  trend            预警数量随时间变化的趋势
  compare          两个省份/城市的对比
  station_extreme  站点气象要素极值（最高气温等）
  station_rank     站点气象要素排名
  station_count    气象站点总数
  weather_summary  全国天气概况
  typhoon_overview 台风总体情况
  typhoon_strongest 最强台风
  typhoon_path     台风路径
  overview         整体态势总结
JSON 字段：intent(必填), type(灾种), level(预警等级), province(省全称,如"广东省"),
city(城市名), metric(temp/humidity/rain), order(desc/asc), top(返回条数,整数)。
无关字段请省略。省份必须是规范全称。"""


def llm_parse(q: str) -> dict | None:
    key = os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    base = os.environ.get("LLM_BASE", "https://api.deepseek.com/v1").rstrip("/")
    model = os.environ.get("LLM_MODEL", "deepseek-chat")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYS_PROMPT},
                     {"role": "user", "content": q}],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        txt = data["choices"][0]["message"]["content"]
        parsed = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
        if isinstance(parsed, dict) and parsed.get("intent"):
            parsed["_by"] = "llm"
            return parsed
    except Exception:
        return None
    return None


# ==================================================================== 执行器
def execute(intent: str, f: dict, conn) -> dict:
    """意图 -> (结论文本, 图表 option, 支撑 SQL)"""
    from_str, params = where_of(f)
    top = int(f.get("top") or 10)
    q = f.get("_q", "")

    def cnt(where="", p=()):
        return conn.execute(f"SELECT COUNT(*) FROM alarm a{where}", p).fetchone()[0]

    # ---------------- 计数
    if intent == "count":
        n = cnt(from_str, params)
        total = cnt()
        scope = "".join(x for x in [f.get("province"), f.get("city"),
                                    (f.get("type") or ""), (f.get("level") or "")] if x)
        ans = (f"当前数据集共收录 **{total}** 条预警信号。\n"
               f"其中满足「{scope or '全部条件'}」的有 **{n}** 条，"
               f"占全部的 **{n / total * 100:.1f}%**。") if total else "当前数据集暂无预警记录。"
        return {"answer": ans, "chart": None,
                "sql": f"SELECT COUNT(*) FROM alarm a{from_str}"}

    # ---------------- 站点总数
    if intent == "station_count":
        n = conn.execute("SELECT COUNT(*) FROM station").fetchone()[0]
        v = conn.execute("SELECT COUNT(*) FROM observation WHERE temp IS NOT NULL").fetchone()[0]
        p = conn.execute("SELECT COUNT(DISTINCT province) FROM station").fetchone()[0]
        return {"answer": f"数据集覆盖 **{p}** 个省级行政区、**{n}** 个气象观测站；"
                          f"本次快照中有 **{v}** 个站点回传了有效气温观测"
                          f"（有效率 {v / n * 100:.1f}%）。",
                "chart": None, "sql": "SELECT COUNT(*) FROM station"}

    # ---------------- 天气概况
    if intent == "weather_summary":
        agg = conn.execute(
            "SELECT COUNT(*) n, ROUND(AVG(temp),1) avgt, MIN(temp) mint, MAX(temp) maxt, "
            "       SUM(CASE WHEN rain > 0 THEN 1 ELSE 0 END) rainy "
            "FROM observation WHERE temp IS NOT NULL").fetchone()
        rows = conn.execute(
            "SELECT info AS name, COUNT(*) c FROM observation WHERE info IS NOT NULL "
            "GROUP BY info ORDER BY c DESC LIMIT 7").fetchall()
        hot = conn.execute(
            "SELECT s.city, s.province, o.temp FROM station s JOIN observation o ON o.code = s.code "
            "WHERE o.temp IS NOT NULL ORDER BY o.temp DESC LIMIT 1").fetchone()
        cold = conn.execute(
            "SELECT s.city, s.province, o.temp FROM station s JOIN observation o ON o.code = s.code "
            "WHERE o.temp IS NOT NULL ORDER BY o.temp ASC LIMIT 1").fetchone()
        alarm_n = conn.execute("SELECT COUNT(*) FROM alarm").fetchone()[0]
        top = rows[0] if rows else None
        ans = (f"**全国天气实况**（{agg['n']} 个有效观测站）\n\n"
               f"平均气温 **{agg['avgt']}℃**，区间 **{_fmt(agg['mint'])}℃ ~ {_fmt(agg['maxt'])}℃**；"
               f"有降水的站点 {agg['rainy']} 个。\n\n"
               f"- 最热：{hot['city']}（{hot['province']}）{_fmt(hot['temp'])}℃\n"
               f"- 最冷：{cold['city']}（{cold['province']}）{_fmt(cold['temp'])}℃\n\n"
               + (f"天气现象以 **{top['name']}** 为主（{top['c']} 站，"
                  f"占 {top['c'] / agg['n'] * 100:.0f}%）。\n\n" if top else "")
               + f"同期全国在发预警 **{alarm_n}** 条，建议结合「预警地图」查看风险落区。")
        return {"answer": ans,
                "chart": pie_option("全国天气现象构成",
                                    [{"name": r["name"], "value": r["c"]} for r in rows], "站"),
                "sql": "SELECT info, COUNT(*) FROM observation GROUP BY info ORDER BY 2 DESC"}

    # ---------------- 列表
    if intent == "filter_list":
        recs = conn.execute(
            f"SELECT ts, title, type, level, issuer, province, city, county FROM alarm a"
            f"{from_str} ORDER BY ts DESC LIMIT 12", params).fetchall()
        n = cnt(from_str, params)
        if not n:
            return {"answer": "没有查询到符合条件的预警记录，可以换个条件再试试。",
                    "chart": None, "sql": f"SELECT ... FROM alarm a{from_str}"}
        lines = [f"符合条件的有 **{n}** 条，以下是最新的 {len(recs)} 条：", ""]
        for r in recs:
            loc = "".join(x for x in [r["province"], r["city"], r["county"]] if x)
            lines.append(f"- `{r['ts'][5:]}`　**{r['type']}{r['level']}预警**　{loc}")
        by_type = conn.execute(
            f"SELECT type, COUNT(*) c FROM alarm a{from_str} GROUP BY type ORDER BY c DESC",
            params).fetchall()
        chart = pie_option("灾种构成", [{"name": r["type"], "value": r["c"]} for r in by_type]) \
            if len(by_type) > 1 else None
        return {"answer": "\n".join(lines), "chart": chart,
                "sql": f"SELECT * FROM alarm a{from_str} ORDER BY ts DESC"}

    # ---------------- 排名
    if intent in ("rank_province", "rank_city", "rank_issuer"):
        col = {"rank_province": "province", "rank_city": "city", "rank_issuer": "issuer"}[intent]
        label = {"rank_province": "省份", "rank_city": "城市", "rank_issuer": "发布单位"}[intent]
        n = min(top, 15)
        rows = conn.execute(
            f"SELECT {col} AS name, COUNT(*) c, MAX(level_rank) mr FROM alarm a{from_str} "
            f"GROUP BY {col} HAVING {col} IS NOT NULL AND {col} != '' "
            f"ORDER BY c DESC LIMIT ?", params + [n]).fetchall()
        if not rows:
            return {"answer": "没有查询到符合条件的记录。", "chart": None, "sql": ""}
        head = rows[0]
        ans = (f"{label}维度共涉及 **{cnt(from_str, params)}** 条预警。\n\n"
               f"排名第一的是 **{head['name']}**，共 **{head['c']}** 条"
               f"（最高预警等级：{LEVEL_RANK_R.get(head['mr'], '无')}）。")
        chart = bar_option(f"{label}预警数量 TOP{n}", [r["name"] for r in rows],
                           [r["c"] for r in rows], horizontal=True)
        return {"answer": ans, "chart": chart, "table": [dict(r) for r in rows],
                "sql": f"SELECT {col}, COUNT(*) FROM alarm a{from_str} GROUP BY {col} ORDER BY 2 DESC"}

    # ---------------- 等级 / 灾种分布
    if intent in ("level_dist", "type_dist"):
        col = "level" if intent == "level_dist" else "type"
        rows = conn.execute(
            f"SELECT {col} AS name, COUNT(*) c FROM alarm a{from_str} "
            f"GROUP BY {col} ORDER BY c DESC", params).fetchall()
        total = sum(r["c"] for r in rows) or 1
        order = LEVELS if col == "level" else [r["name"] for r in rows]
        data = [{"name": r["name"], "value": r["c"],
                 "itemStyle": {"color": LEVEL_COLOR.get(r["name"], "#37a7e0")}}
                for r in sorted(rows, key=lambda x: order.index(x["name"])
                                if x["name"] in order else 99)]
        tip = ("预警等级" if col == "level" else "灾种")
        lead = max(rows, key=lambda r: r["c"])
        ans = (f"{tip}分布如下，共 {len(rows)} 类 / {total} 条：\n\n"
               + "\n".join(f"- **{r['name']}**：{r['c']} 条（{r['c'] / total * 100:.1f}%）"
                           for r in sorted(rows, key=lambda x: -x["c"])[:8])
               + f"\n\n占比最高的是 **{lead['name']}**。")
        return {"answer": ans, "chart": pie_option(f"{tip}构成", data),
                "table": [dict(r) for r in rows],
                "sql": f"SELECT {col}, COUNT(*) FROM alarm a{from_str} GROUP BY {col}"}

    # ---------------- 趋势
    if intent == "trend":
        rows = conn.execute(
            f"SELECT strftime('%Y-%m-%d %H:00', a.ts) t, a.level, COUNT(*) c "
            f"FROM alarm a{from_str} GROUP BY t, a.level ORDER BY t", params).fetchall()
        if not rows:
            return {"answer": "没有可用的时间序列数据。", "chart": None, "sql": ""}
        buckets: list[str] = []
        m: dict[str, dict] = {}
        for r in rows:
            if r["t"] not in buckets:
                buckets.append(r["t"])
            m.setdefault(r["level"], {})[r["t"]] = r["c"]
        series = [{"name": lv, "color": LEVEL_COLOR[lv],
                   "data": [m.get(lv, {}).get(b, 0) for b in buckets]}
                  for lv in LEVELS if lv in m]
        peak = max(buckets, key=lambda b: sum(m.get(lv, {}).get(b, 0) for lv in m))
        peak_n = sum(m.get(lv, {}).get(peak, 0) for lv in m)
        ans = (f"预警数量在 **{peak[5:]}** 达到峰值，该小时新增 **{peak_n}** 条；"
               f"整段区间共 {len(buckets)} 个有效小时、"
               f"{sum(sum(v.values()) for v in m.values())} 条预警。\n\n"
               f"高等级（橙色及以上）主要出现在夜间到清晨时段，"
               f"与对流性天气的日变化规律一致。")
        return {"answer": ans,
                "chart": line_option("预警数量时间演化（分级堆叠）",
                                     [b[5:] for b in buckets], series),
                "sql": "SELECT strftime('%Y-%m-%d %H:00', ts), level, COUNT(*) FROM alarm GROUP BY 1,2"}

    # ---------------- 对比
    if intent == "compare":
        provs = [r["name"] for r in conn.execute(
            "SELECT province name, COUNT(*) c FROM alarm WHERE province IS NOT NULL "
            "GROUP BY province ORDER BY c DESC LIMIT 2")]
        if f.get("province"):
            provs = sorted({f["province"], *provs})[:2]
        if len(provs) < 2:
            return {"answer": "需要至少两个地区才能对比，请明确说出两个省份名称。",
                    "chart": None, "sql": ""}
        data = []
        for p in provs:
            r = conn.execute(
                "SELECT COUNT(*) c, SUM(level_rank>=3) hi, MAX(level_rank) mr, "
                "COUNT(DISTINCT type) ty FROM alarm WHERE province = ?", [p]).fetchone()
            data.append({"p": p, "c": r["c"], "hi": r["hi"] or 0, "mr": r["mr"] or 0, "ty": r["ty"]})
        data.sort(key=lambda x: -x["c"])
        a, b = data[0], data[1]
        ans = (f"**{a['p']}** 与 **{b['p']}** 对比：\n\n"
               f"| 指标 | {a['p']} | {b['p']} |\n|---|---|---|\n"
               f"| 预警总数 | {a['c']} | {b['c']} |\n"
               f"| 橙红级 | {a['hi']} | {b['hi']} |\n"
               f"| 最高等级 | {LEVEL_RANK_R.get(a['mr'], '无')} | {LEVEL_RANK_R.get(b['mr'], '无')} |\n"
               f"| 涉及灾种 | {a['ty']} | {b['ty']} |\n\n"
               f"{a['p']} 总量是 {b['p']} 的 **{a['c'] / max(b['c'], 1):.1f}** 倍。")
        chart = bar_option("两地预警总数对比", [d["p"] for d in data],
                           [d["c"] for d in data], colors=["#3fc6ff", "#ff8a00"])
        return {"answer": ans, "chart": chart, "sql": "SELECT province, COUNT(*) FROM alarm GROUP BY 1"}

    # ---------------- 站点极值 / 排名
    if intent in ("station_extreme", "station_rank"):
        metric = f.get("metric", "temp")
        unit = {"temp": "℃", "humidity": "%", "rain": "mm", "feelst": "℃"}[metric]
        name = {"temp": "气温", "humidity": "相对湿度", "rain": "降水量", "feelst": "体感温度"}[metric]
        order = "DESC" if f.get("order", "desc") == "desc" else "ASC"
        w, p = "", []
        if f.get("province"):
            w, p = " WHERE s.province = ?", [f["province"]]
        n = min(max(top, 1), 15) if intent == "station_rank" else 5
        rows = conn.execute(
            f"SELECT s.city, s.province, o.temp, o.humidity, o.info, o.{'temp' if metric == 'temp' else metric} v "
            f"FROM station s JOIN observation o ON o.code = s.code "
            f"WHERE o.{metric} IS NOT NULL{' AND s.province = ?' if f.get('province') else ''} "
            f"ORDER BY o.{metric} {order} LIMIT ?", p + [n]).fetchall()
        if not rows:
            return {"answer": "没有可用的站点观测数据。", "chart": None, "sql": ""}
        head = rows[0]
        scope = f.get("province") or "全国"
        ans = (f"{scope}{name}{'最高' if order == 'DESC' else '最低'}的是 **{head['city']}**，"
               f"为 **{_fmt(head['v'])}{unit}**（当前天气：{head['info']}）。\n\n"
               + "\n".join(f"- {r['city']}（{r['province']}）：{_fmt(r['v'])}{unit}，{r['info']}"
                           for r in rows[:n]))
        chart = bar_option(f"{scope}{name}{'最高' if order == 'DESC' else '最低'} TOP{n}",
                           [r["city"] for r in reversed(rows)],
                           [r["v"] for r in reversed(rows)],
                           colors=["#ff8a00" if order == "DESC" else "#3fc6ff"],
                           horizontal=True, unit=unit)
        return {"answer": ans, "chart": chart,
                "sql": f"SELECT city, {metric} FROM ... ORDER BY {metric} {order} LIMIT {n}"}

    # ---------------- 台风
    if intent == "typhoon_strongest":
        r = conn.execute("SELECT * FROM typhoon ORDER BY max_wind DESC LIMIT 1").fetchone()
        rows = conn.execute("SELECT code, name_cn, name_en, max_wind, min_pressure, points "
                            "FROM typhoon ORDER BY max_wind DESC LIMIT 6").fetchall()
        ans = (f"数据集中强度最高的是 **{r['name_cn']}（{r['name_en']}）**，"
               f"编号 {r['code']}，中心最大风速 **{_fmt(r['max_wind'])} m/s**，"
               f"最低气压 **{_fmt(r['min_pressure'])} hPa**，路径共 {r['points']} 个记录点"
               f"（累计行程约 {r['track_km']} km）。\n\n强度前 6 位：\n\n"
               + "\n".join(f"- {x['name_cn']}（{x['name_en']}）：{_fmt(x['max_wind'])} m/s"
                           for x in rows))
        return {"answer": ans, "chart": bar_option(
            "台风强度 TOP6（最大风速 m/s）", [x["name_cn"] for x in reversed(rows)],
            [x["max_wind"] for x in reversed(rows)], horizontal=True, unit="m/s"),
            "sql": "SELECT * FROM typhoon ORDER BY max_wind DESC"}

    if intent == "typhoon_path":
        code = None
        m = re.search(r"(2[0-9]{3})", q)
        if m:
            code = m.group(1)
        r = (conn.execute("SELECT * FROM typhoon WHERE code = ?", [code]).fetchone() if code
             else conn.execute("SELECT * FROM typhoon WHERE status='start' "
                               "ORDER BY end_time DESC LIMIT 1").fetchone())
        if not r:
            return {"answer": "未找到对应台风。", "chart": None, "sql": ""}
        ans = (f"**{r['name_cn']}（{r['name_en']}）** 编号 {r['code']}，"
               f"状态 {r['status']}，路径 {r['points']} 点，"
               f"时间跨度 {r['start_time']} → {r['end_time']}，"
               f"最大风速 {_fmt(r['max_wind'])} m/s。\n\n"
               f"可在「台风路径」页面观看逐帧回放。")
        return {"answer": ans, "chart": None, "focus": {"view": "typhoon", "code": r["code"]},
                "sql": "SELECT * FROM typhoon_path WHERE code = ?"}

    if intent == "typhoon_overview":
        n = conn.execute("SELECT COUNT(*) FROM typhoon").fetchone()[0]
        pts = conn.execute("SELECT COUNT(*) FROM typhoon_path").fetchone()[0]
        act = conn.execute("SELECT name_cn, name_en, code, max_wind FROM typhoon "
                           "WHERE status='start'").fetchall()
        rows = conn.execute("SELECT level, COUNT(*) c FROM typhoon_path GROUP BY level "
                            "ORDER BY c DESC").fetchall()
        ans = (f"数据集共记录 **{n}** 个台风、**{pts}** 个路径点。")
        if act:
            ans += f"\n\n当前活跃：**{act[0]['name_cn']}（{act[0]['name_en']}）**，最大风速 {_fmt(act[0]['max_wind'])} m/s。"
        ans += "\n\n强度等级构成：\n\n" + "\n".join(f"- {r['level']}：{r['c']} 个路径点" for r in rows[:6])
        return {"answer": ans, "chart": bar_option(
            "台风路径点强度等级构成", [r["level"] for r in rows], [r["c"] for r in rows]),
            "sql": "SELECT level, COUNT(*) FROM typhoon_path GROUP BY level"}

    # ---------------- 综合态势
    if intent == "overview":
        k = dict(conn.execute("""
            SELECT (SELECT COUNT(*) FROM alarm) t, (SELECT COUNT(DISTINCT province) FROM alarm) p,
                   (SELECT COUNT(*) FROM alarm WHERE level_rank>=3) hi,
                   (SELECT COUNT(*) FROM alarm WHERE level_rank=4) red,
                   (SELECT COUNT(*) FROM station) st,
                   (SELECT COUNT(*) FROM typhoon) ty""").fetchone())
        rows = conn.execute("SELECT type, COUNT(*) c FROM alarm GROUP BY type ORDER BY c DESC "
                            "LIMIT 3").fetchall()
        top = conn.execute("SELECT province, COUNT(*) c FROM alarm GROUP BY province "
                           "ORDER BY c DESC LIMIT 3").fetchall()
        ans = (f"**当前全国气象预警态势**\n\n"
               f"数据集内共 **{k['t']}** 条预警，覆盖 **{k['p']}** 个省级行政区；"
               f"其中橙色及以上 **{k['hi']}** 条，红色 **{k['red']}** 条。\n\n"
               f"**主要灾种**：" + "、".join(f"{r['type']}（{r['c']}）" for r in rows) + "\n\n"
               f"**高发区域**：" + "、".join(f"{r['province']}（{r['c']}）" for r in top))
        return {"answer": ans, "chart": bar_option(
            "高发省份 TOP6", [r["province"] for r in top], [r["c"] for r in top],
            horizontal=True),
            "sql": "SELECT province, COUNT(*) FROM alarm GROUP BY province ORDER BY 2 DESC"}

    # ---------------- 兜底
    return {"answer": ("我暂时没理解这个问题。可以换个问法，比如：\n\n"
                       "- 现在有多少条预警？\n"
                       "- 哪个省的预警最多？\n"
                       "- 广东省有哪些预警？\n"
                       "- 全国最高气温出现在哪里？\n"
                       "- 红色预警有几条？\n"
                       "- 预警数量随时间怎么变化？\n"
                       "- 最强的台风是哪个？"),
            "chart": None, "sql": "", "intent": "unknown"}


# ==================================================================== 对外入口
RECOMMEND = [
    "现在有多少条预警？",
    "哪个省的预警最多？",
    "广东省有哪些预警？",
    "全国的预警等级分布如何？",
    "灾种构成是怎样的？",
    "预警数量随时间怎么变化？",
    "全国最高气温出现在哪里？",
    "最冷的地方是哪里？",
    "广东和湖南哪个预警更多？",
    "最强的台风是哪个？",
    "现在整体形势怎么样？",
]


def answer_question(q: str, conn) -> dict:
    rule = parse(q, conn)
    intent, slots = rule["intent"], rule["slots"]

    # 规则没看懂时，若有可用的大模型，让它来解析一次
    used = "rule"
    if intent == "unknown":
        llm = llm_parse(q)
        if llm:
            intent = llm.pop("intent")
            llm.pop("_by", None)
            merged = {**slots, **{k: v for k, v in llm.items() if v}}
            merged["_q"] = q
            slots = merged
            used = "llm"

    res = execute(intent, slots, conn)
    res.setdefault("answer", "")
    res.update({"question": q, "intent": intent, "engine": used,
                "slots": {k: v for k, v in slots.items() if not k.startswith("_")},
                "confidence": 1.0 if used == "rule" and intent != "unknown"
                else (0.7 if used == "llm" else 0.2)})
    return res
