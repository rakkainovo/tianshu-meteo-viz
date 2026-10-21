# -*- coding: utf-8 -*-
"""
qa.py —— 智能问答引擎（自然语言 -> 数据查询 -> 结论 + 图表）

为什么这么设计
--------------
直接把数据丢给大模型让它"看图说话"，在课程作业场景下有两个硬伤：
一是答案不可复现、可能编造数字；二是没网/没 Key 时整个功能就废了。

所以这里采用**多通道**架构，把"算数"和"说话"彻底分开：

    通道 A（默认，零依赖）  规则解析器：正则 + 词典匹配，把问句映射成结构化意图，
                            再由本地 SQL 把数字算准 —— 断网可用、结果可复现
    通道 B-1（增强，可选）  大模型意图解析：口语太绕时，让 LLM 把它翻译成意图 JSON
    通道 B-2（增强，可选）  大模型解读：规则已算好事实，模型只负责把它讲明白，
                            并用"反幻觉闸门"校验（凭空出现的数字占比过高就丢弃）
    通道 B-3（增强，可选）  自由问答：规则完全没命中时，以聚合数据摘要为上下文回答
    通道 C（增强，可选）  受控工具查询：复杂气象问题由模型选择站点、实况、预报、
                            历史或预警工具；参数和查询对象由后端验证。

单站、指标、时间与多轮上下文由 qa_data.py 统一处理。模型只读取工具返回的有限结果，
不能直接访问数据库或生成 SQL；计算和事实表格由后端提供，查询语句与参数随回答返回。

本地通道覆盖的能力（断网也可用）：
    · 统计类：计数 / 排名 / 分布 / 极值 / 趋势 / 对比 / 台风 / 态势
    · 实时类：某地此刻天气（"上海现在多少度"）
    · 跨表推理：预警地区的实时雨况（"暴雨预警的地方现在在下雨吗"）
    · 生活语义：带伞 / 穿衣 / 出行 / 晾晒 / 防晒（实况 + 预报 + 预警三表联判）
    · 日历时钟：今天星期几 / 几号 / 现在几点（取系统时钟，不查库；也故意不交给大模型
      —— 模型报日期是出了名的会错，系统时钟不会错）

边界说明：这是**数据问答引擎**，不是通用助手。数据集之外的问题（闲聊、常识、写代码）
一律明确回答"答不了"，不硬编答案；开启大模型通道后由自由问答兜底。

配置大模型（可选，不配也能完整使用），两种方式二选一：

  1) 环境变量（临时/CI 用）
       set LLM_API_KEY=sk-xxxx
       set LLM_BASE=https://api.deepseek.com/v1     # 任何 OpenAI 兼容接口均可
       set LLM_MODEL=deepseek-chat

  2) 本地配置文件 server/llm.local.json（推荐，双击 start.bat 也能生效）
       {"api_key": "sk-xxxx",
        "base": "https://api.deepseek.com/v1",
        "model": "deepseek-chat"}
     该文件已在 .gitignore 中排除 —— **仓库是公开的，Key 绝不能提交上去**。

环境变量优先级高于配置文件；两者都没有时，通道 A（规则解析）独立完成全部工作。
"""
from __future__ import annotations

import datetime
import json
import os
import re
import urllib.request
from pathlib import Path
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


# ==================================================================== 地名归一
_ADMIN_SUFFIX = ("特别行政区", "自治州", "自治县", "自治旗", "地区", "盟", "市", "县", "区")


def city_key(name: str) -> str:
    """城市名归一化：去掉行政级别后缀。

    预警表存的是"赣州市"，站点表存的是"赣州"，两边直接 JOIN 只有 2 条能对上；
    归一化后能对上 181 条 —— 跨表推理必须先过这一关。
    """
    s = (name or "").strip()
    for suf in _ADMIN_SUFFIX:
        if s.endswith(suf) and len(s) > len(suf):
            return s[: -len(suf)]
    return s


# 地名误伤保护词：这些高频词本身就可能"包含"真实地名（见 locate_city 注释）。
# 实测坑：「今天全国」包含真实县名「天全」（四川雅安）。
# 原则：只放**确定会与地名粘连**的高频词，放太多会互相误伤
# （比如「全县」会把「天全县」先挖掉，反而丢掉真地名）。
_PROTECT_WORDS = ("今天", "明日", "明天", "昨天", "昨日", "前天", "后天",
                  "全国", "各省", "各地", "各市", "各区", "各县")


def station_city_index(conn) -> dict[str, tuple[str, str]]:
    """{归一化城市名: (station 里的规范城市名, 省名)}"""
    idx: dict[str, tuple[str, str]] = {}
    for r in conn.execute(
            "SELECT DISTINCT city, province FROM station WHERE city IS NOT NULL AND city != ''"):
        k = city_key(r["city"])
        if k and k not in idx:
            idx[k] = (r["city"], r["province"])
    return idx


def locate_city(q: str, f: dict, conn) -> tuple[str | None, str | None]:
    """把问句里的地名落到站点表上，返回 (城市, 省份)。

    最长匹配优先（否则"上海市"会被"上海"或更短的地名抢走）；问句里只有省名时
    城市返回 None，由调用方按省聚合。

    匹配前先"挖掉"高频常用词（_PROTECT_WORDS）：站点表里有真实存在的
    「天全」县（四川雅安），"今天全国天气怎么样" 里的"今天全国"恰好包含
    "天全"二字 —— 不挖掉就会把全国性问题当成四川天全的实况（实测踩到过）。
    """
    q2 = q
    for w in _PROTECT_WORDS:
        q2 = q2.replace(w, "□" * len(w))
    idx = station_city_index(conn)
    hit = ""
    for k in idx:
        if k and len(k) >= 2 and k in q2 and len(k) > len(hit):
            hit = k
    if hit:
        city, prov = idx[hit]
        return city, prov
    return None, f.get("province")


# ==================================================================== 实况/预报/预警取数
def live_of(conn, city: str | None = None, province: str | None = None) -> dict:
    """某地当前实况聚合。city 优先，其次 province，都没有则全国。

    注意站点表里 city 基本是"每市一个代表站"，而直辖市（上海/北京/天津/重庆）的
    区级站都挂在 province 上 —— 所以 city 与 province 同名时改用 province 口径，
    否则问"上海现在多少度"只会得到 1 个站的答案。
    """
    if city and province and city_key(city) == city_key(province):
        n_city = conn.execute("SELECT COUNT(*) FROM station WHERE city = ?", [city]).fetchone()[0]
        if n_city <= 2:
            city = None
    where = ["o.temp IS NOT NULL"]
    p: list = []
    label = "全国"
    if city:
        where.append("s.city = ?")
        p.append(city)
        label = city
    elif province:
        where.append("s.province = ?")
        p.append(province)
        label = province
    w = " WHERE " + " AND ".join(where)
    row = conn.execute(
        "SELECT COUNT(*) n, ROUND(AVG(o.temp),1) temp, ROUND(AVG(o.humidity),0) hum,"
        "       ROUND(MAX(o.temp),1) tmax, ROUND(MIN(o.temp),1) tmin,"
        "       SUM(CASE WHEN o.rain > 0 THEN 1 ELSE 0 END) rainy,"
        "       ROUND(SUM(CASE WHEN o.rain > 0 THEN o.rain ELSE 0 END),1) rain_sum,"
        "       ROUND(MAX(o.rain),1) rain_max, MAX(o.updated_at) updated_at"
        " FROM station s JOIN observation o ON o.code = s.code" + w, p).fetchone()
    infos = conn.execute(
        "SELECT o.info, COUNT(*) c FROM station s JOIN observation o ON o.code = s.code"
        + w + " AND o.info IS NOT NULL GROUP BY o.info ORDER BY c DESC LIMIT 5", p).fetchall()
    hot = conn.execute(
        "SELECT s.city, o.temp FROM station s JOIN observation o ON o.code = s.code" + w +
        " ORDER BY o.temp DESC LIMIT 1", p).fetchone()
    cold = conn.execute(
        "SELECT s.city, o.temp FROM station s JOIN observation o ON o.code = s.code" + w +
        " ORDER BY o.temp ASC LIMIT 1", p).fetchone()
    return {"label": label, "n": row["n"], "temp": row["temp"], "hum": row["hum"],
            "tmax": row["tmax"], "tmin": row["tmin"], "rainy": row["rainy"] or 0,
            "rain_sum": row["rain_sum"] or 0, "rain_max": row["rain_max"] or 0,
            "updated_at": row["updated_at"],
            "infos": [(r["info"], r["c"]) for r in infos],
            "hot": (hot["city"], hot["temp"]) if hot else None,
            "cold": (cold["city"], cold["temp"]) if cold else None,
            "sql": "SELECT ... FROM station s JOIN observation o ON o.code = s.code" + w}


def forecast_of(conn, city: str | None = None, province: str | None = None,
                days: int = 3) -> list[dict]:
    """某地未来几天的预报（按天聚合：多少站点报了雨、平均最高/最低温）。"""
    where = ["f.date >= date('now','localtime')"]
    p: list = []
    if city:
        where.append("s.city = ?")
        p.append(city)
    elif province:
        where.append("s.province = ?")
        p.append(province)
    p.append(days)
    rows = conn.execute(
        "SELECT f.date, COUNT(*) n,"
        "       SUM(CASE WHEN f.day_info LIKE '%雨%' OR f.night_info LIKE '%雨%'"
        "                THEN 1 ELSE 0 END) rain_n,"
        "       SUM(CASE WHEN f.day_info LIKE '%雪%' OR f.night_info LIKE '%雪%'"
        "                THEN 1 ELSE 0 END) snow_n,"
        "       ROUND(AVG(f.day_temp),1) day_temp, ROUND(AVG(f.night_temp),1) night_temp,"
        "       MAX(f.fetched_at) fetched_at"
        " FROM forecast f JOIN station s ON s.code = f.code WHERE "
        + " AND ".join(where) + " GROUP BY f.date ORDER BY f.date LIMIT ?", p).fetchall()
    return [dict(r) for r in rows]


def alarms_of(conn, city: str | None = None, province: str | None = None,
              hours: int = 24, types: tuple[str, ...] | None = None,
              active: bool = False) -> list[dict]:
    """某地近期预警（城市名走归一化比对，兼容"市/州"后缀差异）。

    active=True 走"当前生效"口径（最近一轮采集里仍在生效的），
    默认仍是"最近 N 小时发布过"的历史窗口 —— 调用方要自己想清楚问的是哪种。
    """
    if active:
        where, p = [active_where()], []
    else:
        where = ["a.ts >= datetime((SELECT MAX(ts) FROM alarm), ?)"]
        p = ["-%d hours" % int(hours)]
    if province:
        where.append("a.province = ?")
        p.append(province)
    if types:
        where.append("a.type IN (%s)" % ",".join("?" * len(types)))
        p.extend(types)
    rows = conn.execute(
        "SELECT a.ts, a.city, a.county, a.province, a.type, a.level, a.title, a.issuer"
        " FROM alarm a WHERE " + " AND ".join(where) + " ORDER BY a.ts DESC LIMIT 200", p)
    out = [dict(r) for r in rows]
    if city:
        k = city_key(city)
        out = [r for r in out if city_key(r["city"]) == k]
    return out


# ==================================================================== 生活语义
ADVICE_TOPICS = [
    ("umbrella", "带伞", r"(带伞|打伞|雨伞|要伞|下雨吗|会下雨|有雨吗|要下雨|降水吗)"),
    ("clothing", "穿衣", r"(穿什么|穿多少|穿多厚|穿几件|冷吗|热吗|着装|穿衣|加衣|减衣|保暖|凉不凉)"),
    ("outdoor", "出行", r"(适合出门|能出门|出门吗|适合出行|出行合适|适合户外|适合运动|适合跑步|"
                         r"适合游玩|出去玩|爬山|露营|骑车|适合旅游)"),
    ("drying", "晾晒", r"(晾晒|晒衣|晒被|晒东西|洗车|适合晒)"),
    ("sunscreen", "防晒", r"(防晒|紫外线|晒黑|晒伤|太阳大|太阳毒)"),
]


def advice_topic(q: str) -> tuple[str, str] | None:
    for key, label, pat in ADVICE_TOPICS:
        if re.search(pat, q):
            return key, label
    return None


# ==================================================================== 日历 / 时钟
# 这类问题**不需要查库**：服务端系统时钟就是权威答案。
#
# 为什么之前答不了：问答引擎把自己定位成"气象数据集查询器"，19 个意图全是查表的，
# 没有任何日历/时钟意图 -> "今天星期几" 落到 unknown。而兜底本应由大模型自由问答
# 接住，未配置 Key 时也走不通。结果就是：一个天天在页面上显示"数据截至 14:57"的系统，
# 被问"今天星期几"却答不上来。
#
# 顺带一提：这类问题**故意不交给大模型**。模型报日期/星期是出了名的会错，
# 而系统时钟不会错 —— 让擅长的事归擅长的人。
WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"]
REL_DAY = {"前天": -2, "昨天": -1, "昨日": -1, "今天": 0, "今日": 0, "本日": 0,
           "明天": 1, "明日": 1, "后天": 2}

_CLOCK_WEEKDAY = re.compile(r"(星期几|礼拜几|周几|星期[一二三四五六日天]|"
                            r"礼拜[一二三四五六日天]|周[一二三四五六日天])")
_CLOCK_DATE = re.compile(r"(几月几[号日]|几号|几日|哪天)")
_CLOCK_TIME = re.compile(r"(几点|几时|几时几分|报时)")


def clock_query(q: str) -> dict | None:
    """日历/时钟类问句 -> {"part": ..., "day_offset": n}；不属于此类返回 None。

    part: weekday（星期几）/ date（几号）/ time（几点）/ full（都要）

    刻意收得很紧，避免抢走数据类问题：
      · "今天上海多少度"   -> 无日历词，不受影响，仍走 station_now
      · "预报日期是什么"   -> 没有"几号/哪天"，也不会被"日期"二字误伤
      · "预警发布时间"     -> 必须"现在/当前/此刻"与"时间"同现才认
    """
    part = None
    if _CLOCK_WEEKDAY.search(q):
        part = "weekday"
    elif _CLOCK_DATE.search(q):
        part = "date"
    elif _CLOCK_TIME.search(q) or re.search(r"(现在|当前|此刻|这会儿)[^。？?]{0,4}时间", q):
        part = "time"
    elif re.search(r"(日期|星期|时间|几月)", q) and re.search(r"(今天|明天|昨天|现在|当前|此刻)", q):
        part = "full"
    if part is None:
        return None

    off = 0
    for word, delta in REL_DAY.items():          # 取最先出现的相对日
        if word in q:
            off = delta
            break
    return {"part": part, "day_offset": off}


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
    PROV_ALIAS = {"广东": "广东省", "湖南": "湖南省", "江西": "江西省", "浙江": "浙江省",
                  "江苏": "江苏省", "福建": "福建省", "山东": "山东省", "河南": "河南省",
                  "河北": "河北省", "四川": "四川省", "云南": "云南省", "贵州": "贵州省",
                  "陕西": "陕西省", "甘肃": "甘肃省", "青海": "青海省", "辽宁": "辽宁省",
                  "吉林": "吉林省", "黑龙": "黑龙江省", "山西": "山西省", "安徽": "安徽省",
                  "湖北": "湖北省", "海南": "海南省", "内蒙": "内蒙古自治区",
                  "广西": "广西壮族自治区", "宁夏": "宁夏回族自治区",
                  "新疆": "新疆维吾尔自治区", "西藏": "西藏自治区", "北京": "北京市",
                  "上海": "上海市", "天津": "天津市", "重庆": "重庆市"}
    for p in sorted(provs, key=len, reverse=True):
        if p in q or (len(p) >= 2 and p[:2] in q and p[:2] not in ("内蒙", "广西", "宁夏", "新疆", "西藏")):
            f["province"] = p
            break
    else:
        for k, v in PROV_ALIAS.items():
            if k in q:
                f["province"] = v
                break

    # 问句里可能提到**两个**省份（"广东和湖南哪个预警更多？"）。上面只留了第一个，
    # compare 分支只好用"全国总量前两名"补第二个 —— 结果是问 A 和 B 却拿 C 跟 A 比
    # （实测：问"广东和湖南"答的是"河北 vs 广东"）。这里按出现位置把命中的省都收起来。
    _mentions: list[tuple[int, str]] = []
    for name in provs:
        pos = q.find(name)
        if pos < 0 and len(name) >= 2 and name[:2] in q and \
           name[:2] not in ("内蒙", "广西", "宁夏", "新疆", "西藏"):
            pos = q.find(name[:2])
        if pos >= 0:
            _mentions.append((pos, name))
    for k, v in PROV_ALIAS.items():
        pos = q.find(k)
        if pos >= 0 and not any(v == m[1] for m in _mentions):
            _mentions.append((pos, v))
    if len(_mentions) > 1:                      # 只有多省同现时才需要（单省会走 f["province"]）
        f["_provinces"] = [m[1] for m in sorted(_mentions)]

    cities = [r["name"] for r in conn.execute(
        "SELECT DISTINCT city AS name FROM alarm WHERE city IS NOT NULL AND city != ''")]
    for c in sorted(cities, key=len, reverse=True):
        if c in q:
            f["city"] = c
            break

    m = re.search(r"最近\s*(\d+)\s*小时", q)
    if m:
        f["recent_hours"] = int(m.group(1))
    m = re.search(r"前\s*(\d+)", q)
    if m:
        f["top"] = int(m.group(1))
    return f


REL_ALARM_DAY = {"今天": 0, "今日": 0, "昨天": -1, "昨日": -1, "前天": -2}


def alarm_day_sql(q: str, alias: str = "a") -> str | None:
    """问句里的相对日 -> 预警时间(alarm.ts)的日过滤片段；没有则返回 None。

    这里补的是个真 bug：`extract_filters` 里原本有一句
        if "今天" in q: f["since"] = "0000"
    但这个 `since` 槽位**从来没被任何地方消费过**（`where_of` 根本不引用它），
    于是"今天有多少条预警"回答的是全量历史 —— 实测 **1845** 条，
    而当天实际只有 **382** 条。这属于"看着给了答案、其实是错的"，比答不出来更糟。

    作用范围：where_of 的调用方（count / filter_list / rank_* / *_dist / trend）
    以及 compare 分支。站点类意图不走这里（它们不查 alarm 表）。
    """
    for word, delta in REL_ALARM_DAY.items():
        if word == "前天" and "之前" in q:           # "之前天气"别被当成"前天"
            continue
        if word in q:
            if delta == 0:
                return f"date({alias}.ts) = date('now','localtime')"
            return f"date({alias}.ts) = date('now','localtime','{delta} day')"
    m = re.search(r"最近\s*(\d+)\s*天", q)
    if m:
        return (f"{alias}.ts >= datetime((SELECT MAX(ts) FROM alarm), "
                f"'-{int(m.group(1))} days')")
    return None


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
    day = alarm_day_sql(f.get("_q") or "")
    if day:
        w.append(day)
    # 生效口径（见下方 use_active）：只取"最近一轮成功采集里出现过"的那批
    if f.get("_active"):
        w.append(active_where())
    return (" WHERE " + " AND ".join(w)) if w else "", p


# ==================================================================== 生效口径
# 2026-10-02：地图 / 清单 / KPI 都改成了"当前生效"口径（只画最近一轮采集里
# 仍在生效的预警，见 TECH-NOTES A-2），问答这边原来是"相对最新发布时刻的
# 24 小时窗"—— 于是问"现在有多少条预警"答 490，地图上却只有 401，
# 同一个系统两套数。这里把口径统一过来。
def active_where(alias: str = "a") -> str:
    """只取「最近一轮成功采集里出现过」的预警 —— 即当前生效。

    与 server/app.py 的 build_filters(active=1) 完全同口径：上游 /rest/findAlarm
    返回的本来就是当前生效清单，所以"最近一轮采集"那一批就是权威的此刻生效集合，
    不必拍 now-24h 硬窗口（采集断了也不会整屏消失，只会停在上一次成功那一轮）。
    """
    return f"{alias}.last_seen_at = (SELECT MAX(last_seen_at) FROM alarm)"


def active_stat(conn) -> dict:
    """生效口径的元信息：取自哪一轮采集、此刻多少条。

    注意别名：这里的 FROM 是**不带别名**的 `alarm`，所以拼进去的子句必须用
    `alarm.` 而不是默认的 `a.` —— 否则 SQLite 报 "no such column: a.last_seen_at"，
    而这个错误会在所有走到这里的意图上同时爆出来（一轮回归 15 条全挂）。
    """
    r = conn.execute("SELECT MAX(last_seen_at) AS scan_at, COUNT(*) AS n FROM alarm "
                     "WHERE " + active_where("alarm")).fetchone()
    return {"scan_at": (r["scan_at"] if r else None), "n": ((r["n"] or 0) if r else 0)}


# 问句里出现这些词 = 在问"此刻"，与显式时间范围互斥（后者优先）
NOW_WORDS = re.compile(r"现在|当前|此刻|实时|目前|眼下|此时")

# 这些意图在**没有明确时间范围**时一律按生效口径回答 —— 它们问的都是"现在怎么样"。
# trend 故意不在列：时间序列天生是历史视角（与前端趋势图一致），限制在生效集合里
# 会退化成只剩最近一天的一两根柱子。
DEFAULT_ACTIVE_INTENTS = {
    "count", "filter_list", "rank_province", "rank_city", "rank_issuer",
    "level_dist", "type_dist", "compare", "alarm_live_check", "weather_summary",
    "overview",
}
# 会去查预警表的意图（用于在"条件"里交底口径，含 trend 这种历史视角的）
ALARM_INTENTS = DEFAULT_ACTIVE_INTENTS | {"trend"}


def rel_day_of(q: str) -> str | None:
    """问句里的相对日（今天/昨天/前天），没有则 None。"""
    for word in REL_ALARM_DAY:
        if word in q and not (word == "前天" and "之前" in q):
            return word
    return None


def has_time_window(f: dict) -> bool:
    """问句里是否给了明确的时间范围（今天/昨天/最近N天/最近N小时）。"""
    if f.get("recent_hours"):
        return True
    q = f.get("_q") or ""
    return bool(rel_day_of(q)) or bool(re.search(r"最近\s*\d+\s*天", q))


def use_active(intent: str, f: dict) -> bool:
    """这个问句该不该按"当前生效"口径回答。

    规则：① 时间序列类永不用（历史视角）；② 有明确时间范围的用那个范围，
    不叠加（"今天"+生效 求交集会得到一个谁也解释不清的数）；
    ③ 其余"现在怎么样"的意图默认生效。
    """
    if intent == "trend":
        return False
    if has_time_window(f):
        return False
    return intent in DEFAULT_ACTIVE_INTENTS or bool(NOW_WORDS.search(f.get("_q") or ""))


def scope_note(f: dict) -> str:
    """把"这批数据是什么口径"说成人话 —— 用户才不会拿它和地图对比时发懵。"""
    if f.get("_active"):
        return "当前生效"
    q = f.get("_q") or ""
    day = rel_day_of(q)
    if day:
        return f"{day}已发布（含已失效）"
    m = re.search(r"最近\s*(\d+)\s*(天|小时)", q)
    if m:
        return f"最近 {m.group(1)} {m.group(2)}累计（含已失效）"
    return "全部历史（含已失效）"


# 气象语义守卫：规则通道只认领"确实在问气象"的问句。
# 没有这道闸，"上海有哪些好吃的"会因为句中出现地名而落进 filter_list，
# 答出一句与问题毫不相干的"未查到符合条件的预警"—— 实测踩到过。
# 命中不了的问句交出去（有大模型时由它解析，没有时走自由问答/兜底说明）。
METEOR_WORDS = re.compile(
    r"预警|警报|台风|气温|温度|天气|降雨|降水|下雨|雨量|雨情|湿度|风力|风速|"
    r"站点|台站|实况|灾种|气象|多少度|几度|高温|暴雨|雷电|大风|冰雹|寒潮|"
    r"大雾|雷暴|强对流|干旱|洪涝|汛情|热|冷|湿|暖|伞|穿|晾晒|防晒|出行|"
    r"形势|态势|整体情况|概况")

# 「逐个站点」类问句的三件套判定（见 parse 里的 station_list 分支）：
#   _LIST_WORDS     列举语气（各个 / 每个 / 各区 / 各省 / 逐一 …）
#   _STATION_SCOPE  问的是"一片站点/行政区"而不是单个城市
#   _WEATHER_SCOPE  问的是天气要素而不是预警
# 注意顺序：必须抢在 station_now 与 weather_summary 之前，否则
# "今日重庆各个站点的天气" 会被"天气概况"接走，答出一句全国概况。
_LIST_WORDS = re.compile(
    r"各个|各站|每个|每一|逐一|分别|依次|所有站|全部站|各区|各县|各市|各省|列表|清单")
_STATION_SCOPE = re.compile(r"站点|气象站|观测站|台站|各站|各区|各区县|各县|各市")
_WEATHER_SCOPE = re.compile(r"天气|气温|温度|多少度|几度|实况|下雨|降水|湿度|风力")


def parse(q: str, conn) -> dict:
    """规则通道：把问句映射为 {intent, slots, ...}"""
    f = extract_filters(q, conn)
    f["_q"] = q

    # ---- 日历 / 时钟（"今天星期几""今天几号""现在几点"）
    # 最先判断：这类问法字面最独特（带"星期/周几/几号/几点"），不会有歧义，
    # 而且不需要查库 —— 服务端时钟就是答案，答得比任何一条 SQL 都准。
    clock = clock_query(q)
    if clock:
        # 槽位加下划线前缀：answer_question 会过滤掉 "_" 开头的键，
        # 避免 clock_part/day_offset 这种实现细节出现在界面的"条件"里
        return {"intent": "clock", "slots": {**f, "_clock_part": clock["part"],
                                             "_day_offset": clock["day_offset"]}}

    # ---- 气象语义守卫（放在 clock 之后：时钟类问句本就无气象词，不能误伤）
    if not METEOR_WORDS.search(q):
        return {"intent": "unknown", "slots": f}

    # ---- 跨表推理：预警地区的实时雨况（"暴雨预警的地方现在在下雨吗"）
    # 必须排在生活语义之前，否则会被"下雨吗"误判成带伞建议
    if re.search(r"(预警|警报)[^。？?]{0,10}(下雨|降雨|降水|雨量|实况)|"
                 r"(下雨|降雨|降水)[^。？?]{0,10}(预警|警报)", q):
        return {"intent": "alarm_live_check", "slots": f}

    # ---- 生活语义（这类问法最口语化，要抢在后面的统计意图之前接住）
    topic = advice_topic(q)
    if topic:
        city, prov = locate_city(q, f, conn)
        return {"intent": "advice", "slots": {**f, "topic": topic[0], "topic_label": topic[1],
                                              "_city": city, "province": prov}}

    # ---- 某地此刻天气（"上海现在多少度"）——必须带地名，否则让它走后面的大盘口径
    # "现在"要用负向后顾排除「出/显/体/呈/发/实/表 + 现在」这类词：
    # 否则"全国最高气温出现在哪里" 会被"出现在"里的"现在"骗成"某地此刻天气"，
    # 于是这条本该走极值排行的问句就查不到答案了。
    if re.search(r"(?:(?<![出显体呈发实表])现在|此刻|当前|实时|这会儿|今天|今日|本日)", q) and \
       re.search(r"(几度|多少度|气温|温度|天气|下雨|湿度|风力|风大|"
                 r"热不热|冷不冷|凉不凉|潮不潮|湿不湿|热吗|冷吗|暖和吗)", q) and \
       not _LIST_WORDS.search(q):
        city, prov = locate_city(q, f, conn)
        if city or prov:
            return {"intent": "station_now", "slots": {**f, "_city": city, "province": prov}}

    # ---- 某地各站点实况清单（"今日重庆各个站点的天气"）
    # 这类问句要的是**逐个站点**的清单，而不是一句"平均 24 ℃"的聚合，
    # 更不是全国概况 —— 必须在 station_now / weather_summary 之前接住，
    # 否则"今日重庆各个站点的天气"会落进 weather_summary，答出一句与
    # 问题毫不相干的全国天气（实测踩到过）。
    if _STATION_SCOPE.search(q) and _LIST_WORDS.search(q) and \
            _WEATHER_SCOPE.search(q) and "预警" not in q and "台风" not in q:
        city, prov = locate_city(q, f, conn)
        return {"intent": "station_list", "slots": {**f, "_city": city, "province": prov}}

    # ---- 气象站 / 观测（要放在通用"多少条"之前，否则会被当成预警计数）
    if re.search(r"(气象站|观测站|台站|站点)", q) and \
       re.search(r"(多少|几个|数量|总数|有多少)", q):
        return {"intent": "station_count", "slots": f}

    # ---- 天气概况（带上地名：'重庆天气怎么样'应答重庆，而不是全国）
    if re.search(r"(天气(怎么样|如何|情况)?|气候怎么样)", q) and \
       not re.search(r"(预警|台风)", q):
        city, prov = locate_city(q, f, conn)
        return {"intent": "weather_summary", "slots": {**f, "_city": city, "province": prov}}

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
  station_now      某个城市/省份此刻的天气（只答一句聚合）
  station_list     某个地区**逐个站点**的实况清单（问题里出现"各个/每个/各区/各省站点"这类逐一语气时用它）
  advice           生活建议（带伞/穿衣/出行/晾晒/防晒）
  alarm_live_check 预警地区此刻的真实雨况（预警与实际观测对照）
  weather_summary  天气概况（带地名 = 该地，不带 = 全国）
  typhoon_overview 台风总体情况
  typhoon_strongest 最强台风
  typhoon_path     台风路径
  overview         整体态势总结
  clock            日历/时钟类问题（今天星期几、今天几号、现在几点）
  unknown          与上表全部无关的问题（闲聊、常识、笑话、美食、其他领域话题等）
JSON 字段：intent(必填), type(灾种), level(预警等级), province(省全称,如"广东省"),
city(城市名), metric(temp/humidity/rain), order(desc/asc), top(返回条数,整数),
part(仅 clock 用: weekday/date/time/full)。
无关字段请省略。省份必须是规范全称。

判断原则：只有当问题**确实是在查询上表中的气象数据**时才选对应 intent。
如果必须"硬凑"才能套上某个 intent（例如"上海有哪些好吃的"只是提到了地名，
"讲个笑话"完全与气象无关），必须返回 {"intent": "unknown"}，
不要为了给出答案而选一个勉强沾边的意图。"""


def llm_available() -> bool:
    return bool(_llm_key())


LLM_CONF_PATH = Path(__file__).with_name("llm.local.json")


def _llm_conf() -> dict:
    """本地大模型配置（server/llm.local.json）。

    Key 是私密信息而仓库公开，所以只从「环境变量」或「这个本地文件」读；
    文件缺失/损坏都静默降级为空配置，绝不让问答因为这个文件报错。
    """
    try:
        if LLM_CONF_PATH.exists():
            raw = json.loads(LLM_CONF_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return raw
    except Exception:                            # noqa: BLE001
        pass
    return {}


def _llm_key() -> str | None:
    return (os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY")
            or os.environ.get("OPENAI_API_KEY") or _llm_conf().get("api_key") or None)


def _llm_chat(messages: list[dict], temperature: float = 0.2,
              json_mode: bool = False, timeout: int = 25,
              tools: list[dict] | None = None) -> str | dict | None:
    """调用 OpenAI 兼容接口。未配置 Key 或调用失败都返回 None（调用方回退规则结论）。"""
    key = _llm_key()
    if not key:
        return None
    conf = _llm_conf()
    base = (os.environ.get("LLM_BASE") or conf.get("base")
            or "https://api.deepseek.com/v1").rstrip("/")
    model = os.environ.get("LLM_MODEL") or conf.get("model") or "deepseek-chat"
    body: dict = {"model": model, "messages": messages, "temperature": temperature}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    req = urllib.request.Request(
        f"{base}/chat/completions", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        message = data["choices"][0]["message"]
        if tools:
            return message
        return (message.get("content") or "").strip() or None
    except Exception:                            # noqa: BLE001
        return None


def llm_parse(q: str) -> dict | None:
    """通道 B-1：让大模型把口语问句翻译成意图 JSON（不接触原始数据）。"""
    txt = _llm_chat([{"role": "system", "content": SYS_PROMPT},
                     {"role": "user", "content": q}], temperature=0, json_mode=True)
    if not txt:
        return None
    try:
        parsed = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
    except Exception:                            # noqa: BLE001
        return None
    if isinstance(parsed, dict) and parsed.get("intent"):
        parsed["_by"] = "llm"
        return parsed
    return None


# ---------------------------------------------------------------- 生成式回答
# 规则通道负责"把数字查准"，大模型负责"把数字讲明白"。
# 分工的关键在于：模型拿到的是一段**已经算好的事实**，它只做语言组织，
# 不接触原始表、不做算术 —— 这样即使模型说错话，也不会污染数据本身。
EXPLAIN_PROMPT = """你是"天枢"气象可视化平台的分析助手。下面是平台从本地数据库中查到的**真实结果**，
请基于它回答用户的问题，用简洁专业的中文，2~4 句话。

硬性约束：
1. 只使用给定数据，不得引入外部知识；**不得做任何计算**（倍数、增减、占比、平均都不行），
   只能原样引用给定数据里已经出现的数字；给定数据里没有的数字，一个都不许写；
2. 「查询结论」**已经**按用户问题施加过全部筛选条件（时间范围、地区、灾种、等级等），
   所以其中的数字就是该条件下的答案。即使结论的措辞里没有重复出现"今天""广东省"等词，
   也绝不能说"数据未覆盖该范围"—— 按用户问的范围如实陈述即可；
3. 必须原样保留关键数字，不得改动它们的值或单位；
4. 直接给结论。不要复述问题，不要输出 JSON，不要以"根据数据"这类套话开头；
5. 不要复述筛选过程的元信息（"满足条件的有 N 条""占全部的 100%"这类），
   用户要的是结论，不是查询日志。"""

FREE_PROMPT = """你是"天枢"气象可视化平台的分析助手 —— 一个只处理气象数据的专用问答引擎，
不是通用聊天助手。下面是平台数据库的**实时数据摘要**，请仅依据摘要回答用户的问题。

硬性约束：
1. 摘要里没有的信息，直接说"当前数据集未覆盖该信息"，绝对不要编造；
2. 若问题与气象完全无关（闲聊、常识、笑话、美食等），用一到两句话说明你的定位与边界
   （只做气象数据问答），并简要告诉对方你能答什么，不要硬答；
3. 不给出医疗、投资、法律等专业建议；
4. 不要输出 JSON，不要罗列字段名。"""


def _numbers(text: str) -> set[str]:
    """提取文本里的所有数字（含小数），用于交叉核验。

    同一个数值常有多种写法（"09" vs "9"、"100.0" vs "100"），而事实串里
    往往还夹着日期（"2026-09-24"）和 SQL。所以每个数字同时收录「原样」与
    「去零归一化」两种形式，只做等值宽松匹配 —— 避免把「9 月 24 日」这种
    等价写法误判成凭空编造，同时不影响拦截数量级不同的伪造数字。
    """
    out: set[str] = set()
    for m in re.findall(r"\d+(?:\.\d+)?", text or ""):
        out.add(m)
        out.add(m.lstrip("0") or "0")              # 去前导零：09 -> 9
        if "." in m:
            out.add(m.rstrip("0").rstrip("."))     # 去尾随零：100.0 -> 100
    return out


def hallucination_ratio(answer: str, facts: str) -> float:
    """大模型回答中"凭空出现"的数字占比。

    这是生成式通道的保险绳：模型只被允许在给定事实上做语言组织，
    一旦它输出了事实里不存在的数字，比例就会升高，超过阈值直接丢弃它的话术、
    回退到规则结论 —— 宁可回答朴素，也不能编数据。
    """
    a, f = _numbers(answer), _numbers(facts)
    if not a:
        return 0.0
    return len(a - f) / len(a)


def data_digest(conn) -> dict:
    """给大模型看的紧凑事实摘要（全部是聚合结果，不含原始明细）。"""
    aw = active_where("alarm")
    act = active_stat(conn)
    kpi = conn.execute(f"""
        SELECT (SELECT COUNT(*) FROM alarm)                              AS alarm_n,
               (SELECT COUNT(*) FROM alarm WHERE level_rank >= 3)        AS severe_n,
               (SELECT COUNT(*) FROM alarm WHERE level_rank >= 3 AND {aw}) AS severe_active,
               (SELECT COUNT(*) FROM alarm
                 WHERE ts >= datetime((SELECT MAX(ts) FROM alarm), '-24 hours')) AS alarm_24h,
               (SELECT MAX(ts) FROM alarm)                               AS alarm_latest,
               (SELECT COUNT(*) FROM station)                            AS station_n,
               (SELECT COUNT(*) FROM observation WHERE temp IS NOT NULL) AS obs_n,
               (SELECT ROUND(AVG(temp),1) FROM observation WHERE temp IS NOT NULL) AS temp_avg,
               (SELECT COUNT(*) FROM observation WHERE rain > 0)         AS rainy_n,
               (SELECT COUNT(*) FROM forecast)                           AS forecast_n,
               (SELECT COUNT(*) FROM typhoon)                            AS typhoon_n,
               (SELECT COUNT(*) FROM typhoon WHERE status='start')       AS typhoon_active
    """).fetchone()
    # 分级/灾种分布也用生效口径 —— 自由问答通道拿这份摘要说话，
    # 口径不一致它就会答出和地图对不上的数字
    levels = conn.execute(
        f"SELECT level, COUNT(*) c FROM alarm WHERE {aw} GROUP BY level ORDER BY c DESC").fetchall()
    types = conn.execute(
        f"SELECT type, COUNT(*) c FROM alarm WHERE {aw} GROUP BY type ORDER BY c DESC LIMIT 6"
    ).fetchall()
    hot = conn.execute(
        "SELECT s.city, o.temp FROM station s JOIN observation o ON o.code = s.code"
        " WHERE o.temp IS NOT NULL ORDER BY o.temp DESC LIMIT 3").fetchall()
    cold = conn.execute(
        "SELECT s.city, o.temp FROM station s JOIN observation o ON o.code = s.code"
        " WHERE o.temp IS NOT NULL ORDER BY o.temp ASC LIMIT 3").fetchall()
    obs_updated = conn.execute("SELECT MAX(updated_at) FROM observation").fetchone()[0]
    return {
        "数据来源": "中国气象局公开观测与预警数据（www.nmc.cn / 中央气象台）",
        "预警": {"当前生效": act["n"], "生效快照时刻": act["scan_at"],
                 "当前生效·橙色及以上": kpi["severe_active"],
                 "近15天累计收录": kpi["alarm_n"], "近24小时发布": kpi["alarm_24h"],
                 "最新发布": kpi["alarm_latest"],
                 "当前生效等级分布": {r["level"]: r["c"] for r in levels},
                 "当前生效主要灾种": {r["type"]: r["c"] for r in types},
                 "口径说明": "地图 / 清单 / KPI 默认只显示「当前生效」= 最近一轮采集里"
                             "仍生效的预警；「近15天累计」含已经失效的预警，仅供历史对照。"},
        "站点实况": {"站点总数": kpi["station_n"], "有效观测": kpi["obs_n"],
                     "全国均温": kpi["temp_avg"], "正在下雨的站点": kpi["rainy_n"],
                     "最热站点": [f"{r['city']} {r['temp']}℃" for r in hot],
                     "最冷站点": [f"{r['city']} {r['temp']}℃" for r in cold],
                     "数据截止": obs_updated},
        "预报": {"预报记录数": kpi["forecast_n"], "说明": "逐日预报，窗口为今天及未来若干天"},
        "台风": {"收录总数": kpi["typhoon_n"], "当前活跃": kpi["typhoon_active"]},
        "能力边界": "本摘要只覆盖气象观测、预报与预警三类数据；"
                    "不含经济、人口、健康等外部信息。",
    }


_SLOT_CN = (("type", "灾种"), ("level", "预警等级"), ("province", "省份"),
            ("city", "城市"), ("county", "区县"), ("recent_hours", "最近N小时"),
            ("top", "返回条数"))


def slots_cn(f: dict) -> str:
    """把内部槽位翻成人话，交给模型做上下文。

    规则通道把"今天"这类相对日做成了 SQL 条件（见 alarm_day_sql），结论文本里
    并不会出现"今天"二字。模型只看到字面，就会以为条件没生效 —— 实测它把
    "今天有多少条预警"答成了"数据未覆盖今日预警"。所以这里把条件显式交底。
    """
    parts = [f"{label}={f[k]}" for k, label in _SLOT_CN if f.get(k)]
    # 口径必须交底：规则通道把"现在/今天"做成了 SQL 条件，结论文本里的数字
    # 与地图默认口径（当前生效）是一回事，模型看不到这一点就会说"数据未覆盖"
    if f.get("口径"):
        parts.append(f"口径={f['口径']}")
    q = f.get("_q") or ""
    for word in REL_ALARM_DAY:                   # 相对日优先（今天/昨天/前天）
        if word in q:
            parts.append(f"时间范围={word}")
            break
    else:
        m = re.search(r"最近\s*\d+\s*(?:天|小时)", q)
        if m:
            parts.append(f"时间范围={m.group(0)}")
    return "，".join(parts)


def llm_explain(q: str, res: dict, digest_hint: dict | None = None,
                slots: dict | None = None) -> str | None:
    """通道 B-2：把规则通道查好的结论交给大模型做语言组织与解读。"""
    facts = (res.get("answer") or "").strip()
    if not facts:
        return None
    # 「说明」不是客套话，是修一个实测踩到的坑：规则通道把"今天"做成了 SQL 条件，
    # 结论措辞里就没有"今天"二字，模型便误判成"数据未覆盖今日预警"。
    # 明确告诉它"条件已经施加过"，并让它知道本次生效了哪些槽位。
    ctx = {"用户问题": q, "查询结论": facts, "支撑SQL": res.get("sql") or "",
           "说明": "以上「查询结论」已经按用户问题施加了全部筛选条件（时间范围、地区、"
                   "灾种、等级等），其中的数字就是该条件下的答案。结论措辞里没重复出现"
                   "问题中的时间/地区词，只是因为条件体现在查询过程里，不代表数据缺失。"}
    conds = slots_cn(slots or res.get("slots") or {})
    if conds:
        ctx["本次生效的筛选条件"] = conds
    if digest_hint:
        ctx["补充事实"] = digest_hint
    out = _llm_chat([{"role": "system", "content": EXPLAIN_PROMPT},
                     {"role": "user", "content": json.dumps(ctx, ensure_ascii=False)}],
                    temperature=0.3)
    if not out:
        return None
    # 反幻觉闸门：凭空出现的数字太多就直接不用它
    if hallucination_ratio(out, facts) != 0:
        return None
    return out


def llm_free_answer(q: str, digest: dict) -> str | None:
    """通道 B-3：规则完全没命中时的自由问答（上下文是聚合摘要，不是原始表）。"""
    out = _llm_chat([{"role": "system", "content": FREE_PROMPT},
                     {"role": "user", "content": json.dumps(
                         {"问题": q, "数据摘要": digest}, ensure_ascii=False)}],
                    temperature=0.3)
    if not out:
        return None
    if hallucination_ratio(out, json.dumps(digest, ensure_ascii=False)) != 0:
        return None
    return out


# ==================================================================== 执行器
def execute(intent: str, f: dict, conn) -> dict:
    """意图 -> (结论文本, 图表 option, 支撑 SQL)"""
    from_str, params = where_of(f)
    top = int(f.get("top") or 10)
    q = f.get("_q", "")

    def cnt(where="", p=()):
        return conn.execute(f"SELECT COUNT(*) FROM alarm a{where}", p).fetchone()[0]

    # ---------------- 日历 / 时钟（不查库，服务端时钟即权威）
    if intent == "clock":
        now = datetime.datetime.now()
        off = int(f.get("_day_offset") or 0)
        d = (now + datetime.timedelta(days=off)).date()
        week = WEEK_CN[d.weekday()]
        label = {0: "今天", 1: "明天", 2: "后天", -1: "昨天", -2: "前天"}.get(off, "那天")
        ymd = f"{d.year} 年 {d.month} 月 {d.day} 日"
        part = f.get("_clock_part") or f.get("part") or "weekday"   # 后者兼容大模型返回的 part
        if part == "weekday":
            ans = f"{label}是 **星期{week}**（{d.isoformat()}）。"
        elif part == "date":
            ans = f"{label}是 **{ymd}**，星期{week}。"
        elif part == "time":
            ans = (f"服务端现在是 **{now.strftime('%H:%M:%S')}**"
                   f"（{d.isoformat()} 星期{week}）。")
        else:
            ans = (f"{label}是 **{ymd} 星期{week}**，"
                   f"当前时间 **{now.strftime('%H:%M:%S')}**。")
        return {"answer": ans, "chart": None, "sql": "", "intent": "clock",
                # 这类回答不需要数据证据链，只说明依据是系统时钟
                "evidence_only": {"回答依据": "服务端系统时钟（不查数据库）",
                                  "服务端时间": now.strftime("%Y-%m-%d %H:%M:%S")}}

    # ---------------- 计数
    if intent == "count":
        n = cnt(from_str, params)
        total = cnt()
        act = active_stat(conn)
        scope = "".join(x for x in [f.get("province"), f.get("city"),
                                    (f.get("type") or ""), (f.get("level") or "")] if x)
        if f.get("_active"):
            # 生效口径：把"同一条件下近 15 天累计"一起给出来，两个数各有出处，
            # 用户拿它和地图上的数字对比时也不会觉得对不上
            fh = {k: v for k, v in f.items() if k != "_active"}
            hs, hp = where_of(fh)
            nh = cnt(hs, hp)
            ans = (f"**当前生效 {n} 条**预警信号"
                   + (f"（{scope}）" if scope else "")
                   + f"，取自 {act['scan_at']} 那一轮采集（与地图 / 清单同一口径）。\n\n"
                   f"同一条件下近 15 天累计发布过 **{nh}** 条，其中 **{max(nh - n, 0)}** 条"
                   f"已经失效 —— 地图默认不画这些，免得把过期预警当成正在发生的风险。")
        elif rel_day_of(q):
            day = rel_day_of(q)
            fa = {**f, "_active": True}
            as_, ap_ = where_of(fa)
            na = cnt(as_, ap_)
            ans = (f"**{day}累计发布 {n} 条**预警信号，其中 **{na} 条此刻仍在生效**"
                   f"（取自 {act['scan_at']} 那一轮采集），"
                   f"{max(n - na, 0)} 条已经失效。")
        else:
            ans = (f"{scope_note(f)}：满足「{scope or '全部条件'}」的有 **{n}** 条"
                   f"（数据集近 15 天共收录 {total} 条，占 {n / total * 100:.1f}%）。"
                   ) if total else "当前数据集暂无预警记录。"
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

    # ---------------- 跨表：预警地区此刻的真实雨况
    if intent == "alarm_live_check":
        heavy = ("暴雨", "雷电", "雷雨大风", "雷暴大风", "地质灾害", "冰雹")
        # 口径：问的是"此刻在下雨吗"，所以取**当前生效**的降雨类预警，
        # 而不是"近 24 小时发布过"（后者会把早上下完、已经解除的也算进来）
        rows = conn.execute(
            "SELECT a.city, a.province, a.type, a.level, a.county, a.title, a.ts"
            " FROM alarm a WHERE a.type IN (%s) AND " % ",".join("?" * len(heavy))
            + active_where()
            + " ORDER BY a.level_rank DESC, a.ts DESC LIMIT 120",
            list(heavy)).fetchall()
        idx = station_city_index(conn)
        pairs, hit_cities = [], set()
        for r in rows:
            k = city_key(r["city"])
            if not k or k not in idx or k in hit_cities:
                continue
            hit_cities.add(k)
            city = idx[k][0]
            s = conn.execute(
                "SELECT COUNT(*) n, SUM(CASE WHEN o.rain > 0 THEN 1 ELSE 0 END) rn,"
                "       ROUND(SUM(CASE WHEN o.rain > 0 THEN o.rain ELSE 0 END),1) sr,"
                "       ROUND(MAX(o.rain),1) mx FROM station s"
                " JOIN observation o ON o.code = s.code WHERE s.city = ?"
                "   AND o.rain IS NOT NULL", [city]).fetchone()
            if s and s["n"]:
                pairs.append((dict(r), city, dict(s)))
            if len(pairs) >= 12:
                break
        if not pairs:
            return {"answer": "当前没有生效中的降雨类预警能关联到观测站点（已失效的历史预警不再参与对照）。",
                    "chart": None, "sql": "SELECT ... FROM alarm a JOIN station s"}
        wet = [p for p in pairs if p[2]["rn"]]
        lines = [f"当前生效的降雨类预警里，有 **{len(pairs)}** 个城市能对上观测站，"
                 f"其中 **{len(wet)}** 个城市的站点确实观测到了降水：", ""]
        for r, city, s in pairs[:6]:
            if s["rn"]:
                lines.append(f"- **{city}**（{r['province']}）{r['type']}{r['level']}预警："
                             f"{s['n']} 站中 **{s['rn']}** 站在下雨，累计 {s['sr']} mm，"
                             f"最大 {s['mx']} mm")
            else:
                lines.append(f"- {city}（{r['province']}）{r['type']}{r['level']}预警："
                             f"{s['n']} 站当前均未观测到降水")
        lines += ["", "> 说明：预警按行政区域发布，观测按站点采集，两者口径不同 —— "
                      "预警未命中降水是正常现象（预警具有提前量）。"]
        # 只有确实观测到降水时才画对比图；全为 0 的柱状图没有信息量
        chart = None
        if wet:
            idxw = [i for i, p in enumerate(pairs) if p[2]["rn"]][:12]
            chart = bar_option(
                "预警城市·当前累计雨量",
                [pairs[i][1] for i in idxw],
                [pairs[i][2]["sr"] or 0 for i in idxw],
                [LEVEL_COLOR.get(pairs[i][0]["level"], "#7a8aa0") for i in idxw],
                unit="mm")
        return {"answer": "\n".join(lines), "chart": chart,
                "sql": "SELECT a.city, a.type, a.level, SUM(o.rain) FROM alarm a"
                       " JOIN station s ON s.city = REPLACE(a.city,'市','')"
                       " JOIN observation o ON o.code = s.code GROUP BY a.city"}

    # ---------------- 某地此刻天气
    if intent == "station_now":
        city, prov = f.get("_city"), f.get("province")
        lv = live_of(conn, city, prov)
        if not lv["n"]:
            return {"answer": f"没有找到「{city or prov}」对应的有效观测数据。",
                    "chart": None, "sql": lv["sql"]}
        info_txt = "、".join(f"{k}（{v} 站）" for k, v in lv["infos"][:3]) or "—"
        ans = (f"**{lv['label']}** 当前有 **{lv['n']}** 个站点回传有效观测，"
               f"平均气温 **{lv['temp']} ℃**（{lv['tmin']} ~ {lv['tmax']} ℃），"
               f"平均相对湿度 {lv['hum']}%，天气现象以 {info_txt} 为主。")
        if lv["rainy"]:
            ans += (f"\n其中 **{lv['rainy']}** 个站点正在下雨，累计雨量 {lv['rain_sum']} mm"
                    f"（单站最大 {lv['rain_max']} mm）。")
        else:
            ans += "\n当前没有站点观测到降水。"
        if lv["hot"] and lv["cold"] and lv["hot"][0] != lv["cold"][0]:
            ans += f"\n全省（市）内最热在 **{lv['hot'][0]}** {lv['hot'][1]} ℃，" \
                   f"最凉在 **{lv['cold'][0]}** {lv['cold'][1]} ℃。"
        ans += f"\n\n> 数据截止 {lv['updated_at'] or '—'}（站点实况由实时引擎轮转采集）"
        pie = pie_option(f"{lv['label']}·天气现象构成",
                         [{"name": k, "value": v} for k, v in lv["infos"]], unit="站") \
            if lv["infos"] else None
        return {"answer": ans, "chart": pie, "sql": lv["sql"]}

    # ---------------- 生活语义建议（实况 + 预报 + 预警 三表联查）
    if intent == "advice":
        topic = f.get("topic") or "outdoor"
        tlabel = f.get("topic_label") or "出行"
        city, prov = f.get("_city"), f.get("province")
        lv = live_of(conn, city, prov)
        fc = forecast_of(conn, city, prov, days=3)
        # 建议类问题只认**当前生效**的预警：两天前那场已经解除的暴雨预警
        # 不该成为"今天要不要带伞"的依据（原来用近 24 小时窗，会算进来）
        al = alarms_of(conn, city, prov, active=True)
        if not lv["n"]:
            return {"answer": f"没有找到「{city or prov or '该地区'}」的观测数据，无法给出建议。",
                    "chart": None, "sql": lv["sql"]}
        place = lv["label"]
        # 有雨：看当前降水 + 未来预报里"报雨站点占比"
        rainy_now = lv["rainy"] > 0
        wet_days = [d for d in fc if d["rain_n"] and d["rain_n"] >= max(1, d["n"] * 0.3)]
        sev = [a for a in al if a["type"] in ("暴雨", "雷电", "雷雨大风", "雷暴大风", "冰雹",
                                              "台风", "大风", "暴雪", "道路结冰")]
        t = lv["temp"] or 0
        verdict, reasons, tips = "", [], []

        if topic == "umbrella":
            if rainy_now:
                verdict = "**建议带伞**"
                reasons.append(f"{lv['label']} 当前有 {lv['rainy']} 个站点正在下雨"
                               f"（累计 {lv['rain_sum']} mm）")
            if wet_days:
                d = wet_days[0]
                reasons.append(f"预报 {d['date']} 有雨（{d['n']} 个站点中 {d['rain_n']} 个报雨）")
                if not rainy_now:
                    verdict = "**建议带伞**"
            if any(a["type"] == "暴雨" for a in sev):
                reasons.append("该地区有暴雨预警生效")
                verdict = "**务必带伞**"
            if not verdict:
                verdict = "**暂时不用带伞**"
                reasons.append("当前无降水，未来 3 天预报也没有明显降雨")
            tips.append("夏季雷阵雨局地性强，出门前可再刷一次实时实况")

        elif topic == "clothing":
            if t >= 30:
                verdict = "**短袖薄衫**（炎热）"
            elif t >= 24:
                verdict = "**短袖或薄长袖**（舒适偏暖）"
            elif t >= 16:
                verdict = "**薄外套 / 长袖**（微凉）"
            elif t >= 8:
                verdict = "**外套加毛衣**（较冷）"
            else:
                verdict = "**棉服或厚外套**（寒冷）"
            reasons.append(f"当前平均气温 {lv['temp']} ℃，区间 {lv['tmin']} ~ {lv['tmax']} ℃")
            if lv["tmax"] is not None and lv["tmin"] is not None and \
                    lv["tmax"] - lv["tmin"] >= 10:
                tips.append(f"昼夜温差达 {round(lv['tmax'] - lv['tmin'], 1)} ℃，建议洋葱式穿法")
            if rainy_now or wet_days:
                tips.append("有降水，注意衣物防潮、备一件防水外层")

        elif topic == "outdoor":
            bad = [a for a in sev if a["level"] in ("橙色", "红色")]
            if bad:
                verdict = "**不建议外出**"
                reasons.append("、".join(sorted({f"{a['type']}{a['level']}预警" for a in bad})))
            elif t >= 37 or t <= -5:
                verdict = "**谨慎外出**"
                reasons.append(f"气温 {lv['temp']} ℃ 处于极端区间")
            elif rainy_now and lv["rain_sum"] and lv["rain_sum"] > 20:
                verdict = "**不建议长时间户外**"
                reasons.append(f"累计雨量 {lv['rain_sum']} mm，局地降水较强")
            else:
                verdict = "**适合外出**"
                reasons.append(f"气温 {lv['temp']} ℃、湿度 {lv['hum']}%"
                               + ("，有零星降水" if rainy_now else "，无明显降水"))
            if sev:
                tips.append("该地区仍有 " + "、".join(sorted({f"{a['type']}{a['level']}"
                                                          for a in sev})) + "，出行留意官方更新")

        elif topic == "drying":
            if rainy_now or wet_days or (lv["hum"] or 0) >= 85:
                verdict = "**不太适合晾晒**"
                if rainy_now:
                    reasons.append("当前有站点观测到降水")
                if wet_days:
                    reasons.append(f"{wet_days[0]['date']} 预报有雨")
                if (lv["hum"] or 0) >= 85:
                    reasons.append(f"平均相对湿度高达 {lv['hum']}%")
            else:
                verdict = "**适合晾晒**"
                reasons.append(f"无降水，平均相对湿度 {lv['hum']}%")
                if lv["infos"] and lv["infos"][0][0] in ("晴", "多云"):
                    reasons.append(f"天气以{lv['infos'][0][0]}为主")

        elif topic == "sunscreen":
            sunny = any(k in (lv["infos"][0][0] if lv["infos"] else "")
                        for k in ("晴", "多云"))
            if sunny and t >= 28:
                verdict = "**需要认真防晒**"
                reasons.append(f"天气晴好、气温 {lv['temp']} ℃，紫外线较强")
            elif sunny:
                verdict = "**建议基础防晒**"
                reasons.append(f"天气以{lv['infos'][0][0]}为主，日照较足")
            else:
                verdict = "**防晒需求不高**"
                reasons.append("云量较多或天气不佳，日照不强")

        lines = [f"### {place} · {tlabel}建议：{verdict}", ""]
        lines += [f"- {x}" for x in reasons]
        if tips:
            lines += [""] + [f"> 提示：{x}" for x in tips]
        lines += ["", f"> 依据：{lv['n']} 个站点的实时观测（截止 {lv['updated_at'] or '—'}）"
                      f"+ 未来 3 天预报 + 当前生效预警"]
        chart = None
        if fc:
            chart = line_option(
                f"{place}·未来预报气温",
                [d["date"][5:] for d in fc],
                [{"name": "白天最高", "data": [d["day_temp"] for d in fc], "color": "#ff8a00"},
                 {"name": "夜间最低", "data": [d["night_temp"] for d in fc], "color": "#3fc6ff"}])
        return {"answer": "\n".join(lines), "chart": chart, "sql": lv["sql"]}

    # ---------------- 某地各站点实况清单（"今日重庆各个站点的天气"）
    # 与 station_now 的区别：它要的是**逐个站点**的清单，不是一句聚合。
    # 清单的意义在于"点名要明细" —— 这类问题给聚合就是答非所问。
    if intent == "station_list":
        city, prov = f.get("_city"), f.get("province")
        # 直辖市口径：city 与 province 同名时站点挂在 province 上（见 live_of 注释）
        if city and prov and city_key(city) == city_key(prov):
            n_city = conn.execute("SELECT COUNT(*) FROM station WHERE city = ?",
                                  [city]).fetchone()[0]
            if n_city <= 2:
                city = None
        where, p, label = [], [], "全国"
        if city:
            where.append("s.city = ?")
            p.append(city)
            label = city
        elif prov:
            where.append("s.province = ?")
            p.append(prov)
            label = prov
        w = (" WHERE " + " AND ".join(where)) if where else ""
        rows = conn.execute(
            "SELECT s.code, s.city, s.province, o.temp, o.humidity, o.rain, o.info,"
            "       o.updated_at FROM station s JOIN observation o ON o.code = s.code" + w +
            " ORDER BY o.temp IS NULL, o.temp DESC LIMIT 400", p).fetchall()
        if not rows:
            return {"answer": f"没有找到「{label}」范围内的站点观测数据。",
                    "chart": None,
                    "sql": f"SELECT ... FROM station s JOIN observation o{s}"}
        valid = [r for r in rows if r["temp"] is not None]
        if not valid:
            return {"answer": f"「{label}」共 {len(rows)} 个站点，本轮暂无有效气温观测。",
                    "chart": None, "sql": f"SELECT ... FROM station s JOIN observation o{s}"}
        n = len(valid)
        hot = max(valid, key=lambda r: r["temp"])
        cold = min(valid, key=lambda r: r["temp"])
        avg = round(sum(r["temp"] for r in valid) / n, 1)
        rainy = [r for r in valid if (r["rain"] or 0) > 0]
        head = (f"**{label} · 各站点实况**（共 {len(rows)} 站，{n} 站有有效观测）\n\n"
                f"- 气温区间 **{_fmt(cold['temp'])} ℃**（{cold['city']}）"
                f"~ **{_fmt(hot['temp'])} ℃**（{hot['city']}），平均 **{avg} ℃**\n"
                f"- 正在下雨 **{len(rainy)}** 站"
                + (f"，单站最大 {max(r['rain'] for r in rainy)} mm" if rainy else ""))
        cnt: dict[str, int] = {}
        for r in valid:
            if r["info"]:
                cnt[r["info"]] = cnt.get(r["info"], 0) + 1
        if cnt:
            top3 = sorted(cnt.items(), key=lambda x: -x[1])[:3]
            head += "\n- 天气现象：" + "、".join(f"{k}（{v} 站）" for k, v in top3)
        lines = ["", "| 站点 | 气温 | 湿度 | 天气 | 降水 |", "|---|---|---|---|---|"]
        show = valid[:14]
        for r in show:
            rain = (_fmt(r["rain"]) + " mm") if r["rain"] else "—"
            lines.append(f"| {r['city']} | {_fmt(r['temp'])} ℃ | {_fmt(r['humidity'])}% "
                         f"| {r['info'] or '—'} | {rain} |")
        rest_n = len(valid) - len(show)
        if rest_n > 0:
            lines.append(f"\n（其余 {rest_n} 站未列出，可在「站点实况」页按地区查看完整清单）")
        lines += ["", f"> 站点按气温从高到低排列；数据截止 {valid[0]['updated_at'] or '—'}，"
                      "由实时引擎轮转采集。"]
        chart_rows = valid[:15]
        chart = bar_option(
            f"{label}·站点气温 TOP{len(chart_rows)}",
            [r["city"] for r in reversed(chart_rows)],
            [r["temp"] for r in reversed(chart_rows)],
            horizontal=True, unit="℃")
        return {"answer": "\n".join([head] + lines), "chart": chart,
                "sql": ("SELECT s.city, o.temp, o.humidity, o.rain, o.info FROM station s"
                        " JOIN observation o ON o.code = s.code" + w + " ORDER BY o.temp DESC")}

    # ---------------- 天气概况（带地名 = 该地口径；不带 = 全国）
    if intent == "weather_summary":
        city, prov = f.get("_city"), f.get("province")
        if city or prov:
            lv = live_of(conn, city, prov)
            al = alarms_of(conn, city, prov, active=True)
            if not lv["n"]:
                return {"answer": f"没有找到「{city or prov}」对应的有效观测数据。",
                        "chart": None, "sql": lv["sql"]}
            info_txt = "、".join(f"{k}（{v} 站）" for k, v in lv["infos"][:3]) or "—"
            ans = (f"**{lv['label']}天气实况**（{lv['n']} 个有效观测站）\n\n"
                   f"平均气温 **{lv['temp']} ℃**（{lv['tmin']} ~ {lv['tmax']} ℃），"
                   f"平均相对湿度 {lv['hum']}%，天气现象以 {info_txt} 为主。")
            ans += (f"\n其中 **{lv['rainy']}** 个站点正在下雨，累计 {lv['rain_sum']} mm。"
                    if lv["rainy"] else "\n当前没有站点观测到降水。")
            if lv["hot"] and lv["cold"] and lv["hot"][0] != lv["cold"][0]:
                ans += (f"\n本地最热 **{lv['hot'][0]}** {lv['hot'][1]} ℃，"
                        f"最凉 **{lv['cold'][0]}** {lv['cold'][1]} ℃。")
            ans += (f"\n\n当前该地区生效中的预警 **{len(al)}** 条。" if al
                    else "\n\n该地区当前没有生效中的预警。")
            ans += (f"\n\n> 数据截止 {lv['updated_at'] or '—'}")
            pie = pie_option(f"{lv['label']}·天气现象构成",
                             [{"name": k, "value": v} for k, v in lv["infos"]], unit="站") \
                if lv["infos"] else None
            return {"answer": ans, "chart": pie, "sql": lv["sql"]}
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
        act = active_stat(conn)
        top = rows[0] if rows else None
        ans = (f"**全国天气实况**（{agg['n']} 个有效观测站）\n\n"
               f"平均气温 **{agg['avgt']}℃**，区间 **{_fmt(agg['mint'])}℃ ~ {_fmt(agg['maxt'])}℃**；"
               f"有降水的站点 {agg['rainy']} 个。\n\n"
               f"- 最热：{hot['city']}（{hot['province']}）{_fmt(hot['temp'])}℃\n"
               f"- 最冷：{cold['city']}（{cold['province']}）{_fmt(cold['temp'])}℃\n\n"
               + (f"天气现象以 **{top['name']}** 为主（{top['c']} 站，"
                  f"占 {top['c'] / agg['n'] * 100:.0f}%）。\n\n" if top else "")
               + f"当前全国生效预警 **{act['n']}** 条（近 15 天累计收录 {alarm_n} 条），"
                 f"建议结合「预警地图」查看风险落区。")
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
        lines = [f"{scope_note(f)}：共 **{n}** 条，以下是最新的 {len(recs)} 条：", ""]
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
        ans = (f"{scope_note(f)}口径下，{label}维度共涉及 **{cnt(from_str, params)}** 条预警。\n\n"
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
        ans = (f"{scope_note(f)}口径下，{tip}分布如下，共 {len(rows)} 类 / {total} 条：\n\n"
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
        day = alarm_day_sql(q)
        extra = f" AND {day}" if day else ""      # "今天广东和湖南哪个预警更多"也要按当天算
        # 生效口径也要带上：这个分支不走 where_of 的 from_str，自己拼条件 ——
        # 漏了它就会出现"条件标着当前生效、数字却是 15 天累计"
        if f.get("_active"):
            extra += f" AND {active_where()}"
        provs = list(f.get("_provinces") or [])   # 优先用问句里点名的省（可能两个都在）
        if len(provs) < 2:                        # 没点名两个省时，退回"总量前两名"
            provs = [r["name"] for r in conn.execute(
                "SELECT a.province name, COUNT(*) c FROM alarm a WHERE a.province IS NOT NULL"
                + extra + " GROUP BY a.province ORDER BY c DESC LIMIT 2")]
        if f.get("province") and f["province"] not in provs:
            provs = [f["province"], *provs]
        provs = provs[:2]
        if len(provs) < 2:
            return {"answer": "需要至少两个地区才能对比，请明确说出两个省份名称。",
                    "chart": None, "sql": ""}
        data = []
        for p in provs:
            r = conn.execute(
                "SELECT COUNT(*) c, SUM(level_rank>=3) hi, MAX(level_rank) mr, "
                "COUNT(DISTINCT type) ty FROM alarm a WHERE a.province = ?" + extra,
                [p]).fetchone()
            data.append({"p": p, "c": r["c"], "hi": r["hi"] or 0, "mr": r["mr"] or 0, "ty": r["ty"]})
        data.sort(key=lambda x: -x["c"])
        a, b = data[0], data[1]
        ans = (f"**{a['p']}** 与 **{b['p']}** 对比（{scope_note(f)}口径）：\n\n"
               f"| 指标 | {a['p']} | {b['p']} |\n|---|---|---|\n"
               f"| 预警总数 | {a['c']} | {b['c']} |\n"
               f"| 橙红级 | {a['hi']} | {b['hi']} |\n"
               f"| 最高等级 | {LEVEL_RANK_R.get(a['mr'], '无')} | {LEVEL_RANK_R.get(b['mr'], '无')} |\n"
               f"| 涉及灾种 | {a['ty']} | {b['ty']} |\n\n"
               f"{a['p']} 总量是 {b['p']} 的 **{a['c'] / max(b['c'], 1):.1f}** 倍。")
        chart = bar_option("两地预警总数对比", [d["p"] for d in data],
                           [d["c"] for d in data], colors=["#3fc6ff", "#ff8a00"])
        return {"answer": ans, "chart": chart,
                "sql": ("SELECT province, COUNT(*) FROM alarm a "
                        + (f"WHERE {day} " if day else "") + "GROUP BY 1")}

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
        # 口径：问的是"现在整体形势"，所以统计**当前生效**的那批
        # （原来这里答的是全量历史 4,705 条，而地图只有 401 —— 而且
        #  "现在整体形势怎么样"正是页面上的推荐问法，矛盾最刺眼）
        aw = active_where("alarm")
        k = dict(conn.execute(f"""
            SELECT (SELECT COUNT(*) FROM alarm WHERE {aw}) t,
                   (SELECT COUNT(DISTINCT province) FROM alarm WHERE {aw}) p,
                   (SELECT COUNT(*) FROM alarm WHERE level_rank>=3 AND {aw}) hi,
                   (SELECT COUNT(*) FROM alarm WHERE level_rank=4 AND {aw}) red,
                   (SELECT COUNT(*) FROM alarm) all_t,
                   (SELECT COUNT(*) FROM station) st,
                   (SELECT COUNT(*) FROM typhoon) ty""").fetchone())
        rows = conn.execute(f"SELECT type, COUNT(*) c FROM alarm WHERE {aw} "
                            f"GROUP BY type ORDER BY c DESC LIMIT 3").fetchall()
        top = conn.execute(f"SELECT province, COUNT(*) c FROM alarm WHERE {aw} "
                           f"GROUP BY province ORDER BY c DESC LIMIT 3").fetchall()
        scan = active_stat(conn)["scan_at"]
        ans = (f"**当前全国气象预警态势**（当前生效口径 · 取自 {scan} 那一轮采集）\n\n"
               f"此刻生效 **{k['t']}** 条，覆盖 **{k['p']}** 个省级行政区；"
               f"其中橙色及以上 **{k['hi']}** 条，红色 **{k['red']}** 条。\n\n"
               f"**主要灾种**：" + "、".join(f"{r['type']}（{r['c']}）" for r in rows) + "\n\n"
               f"**高发区域**：" + "、".join(f"{r['province']}（{r['c']}）" for r in top)
               + f"\n\n> 近 15 天累计收录 {k['all_t']} 条，其余均已失效，默认不再画进地图。")
        return {"answer": ans, "chart": bar_option(
            "生效预警高发省份 TOP6", [r["province"] for r in top], [r["c"] for r in top],
            horizontal=True),
            "sql": f"SELECT province, COUNT(*) FROM alarm WHERE {aw} GROUP BY province ORDER BY 2 DESC"}

    # ---------------- 兜底
    return {"answer": (
        "这个问题我答不了 —— **我是气象数据问答引擎，不是通用助手**。\n\n"
        "我给出的每个数字都来自本地那份 SQLite 数据集（观测站实况 / 预警 / 台风 / 预报），"
        "并且能追溯到一条可复现的 SQL（见下方「数据依据」）。数据集里没有的东西，"
        "我不会硬编一个答案。\n\n"
        + ("> 通用问答（闲聊、常识、写代码之类）需要**大模型通道**，当前**未配置 Key**，"
           "所以这条路也走不通。\n\n" if not llm_available() else
           "> 通用问答通道是开着的，但这次模型没能给出可靠回答，"
           "所以我宁可直说不会，也不给你一个编的。\n\n")
        + "我能答的，可以试试：\n\n"
        "- 现在有多少条预警？\n"
        "- 哪个省的预警最多？\n"
        "- 广东省有哪些预警？\n"
        "- 上海现在多少度？\n"
        "- 明天上海要带伞吗？\n"
        "- 暴雨预警的地方现在在下雨吗？\n"
        "- 今天星期几 / 现在几点？\n"
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
    "今日重庆各个站点的天气",
    "全国最高气温出现在哪里？",
    "最冷的地方是哪里？",
    "广东和湖南哪个预警更多？",
    "最强的台风是哪个？",
    "现在整体形势怎么样？",
    "今天星期几？",
    "现在几点？",
]


def answer_question(q: str, conn, context: dict | None = None,
                    page_context: dict | None = None, selection: str | None = None,
                    messages: list | None = None) -> dict:
    from qa_data import answer_weather, answer_with_tools, WEATHER
    if llm_available() and WEATHER.search(q) and re.search(r"结合|顺便|综合分析|分别.*(?:再|并)|同时", q):
        tool_result = answer_with_tools(q, conn, context, messages)
        if tool_result:
            return tool_result
    weather_result = answer_weather(q, conn, context, page_context, selection, messages)
    if weather_result:
        return weather_result
    rule = parse(q, conn)
    intent, slots = rule["intent"], rule["slots"]

    # 规则没看懂时，若有可用的大模型，让它来解析一次
    used = "rule"
    if intent == "unknown":
        tool_result = answer_with_tools(q, conn, context, messages)
        if tool_result:
            return tool_result
        llm = llm_parse(q)
        if llm:
            intent = llm.pop("intent")
            llm.pop("_by", None)
            merged = {**slots, **{k: v for k, v in llm.items() if v}}
            merged["_q"] = q
            slots = merged
            used = "llm"

    # 仍然没看懂 -> 自由问答通道：模型只拿到聚合摘要，不接触原始表
    if intent == "unknown":
        digest = data_digest(conn)
        free = llm_free_answer(q, digest)
        if free:
            return {"question": q, "intent": "free_llm", "engine": "llm", "answer": free,
                    "chart": None, "slots": {}, "context": {}, "confidence": None,
                    "sql": "（自由问答：以聚合数据摘要为上下文，不构造 SQL）",
                    "evidence": {"数据截止": (digest.get("站点实况") or {}).get("数据截止"),
                                 "数据来源": digest.get("数据来源")}}

    # 口径统一：没有明确时间范围时，"现在怎么样"类问题一律按**当前生效**回答，
    # 与地图 / 清单 / KPI 完全一致（原来这里用"相对最新发布时刻的 24 小时窗"，
    # 于是问"现在有多少条预警"答 490、地图上只有 401，同一系统两套数）。
    if intent in ALARM_INTENTS:
        if use_active(intent, slots):
            slots["_active"] = True
        slots["口径"] = scope_note(slots)

    res = execute(intent, slots, conn)
    res.setdefault("answer", "")

    # 生成式通道：规则已经把数字查准，大模型只负责把它讲明白。
    # 任何失败（无 Key / 超时 / 反幻觉闸门拦截）都静默保留规则结论。
    if intent != "unknown" and res["answer"] and llm_available():
        polished = llm_explain(q, res, slots=slots)
        if polished:
            res["answer_rule"] = res["answer"]        # 保留规则原文，前端可"查看依据"
            res["answer"] = polished
            used = used + "+llm"

    res.update({"question": q, "intent": intent, "engine": used,
                "slots": {k: v for k, v in slots.items() if not k.startswith("_")},
                "evidence": evidence_of(conn, res),
                "context": {}, "confidence": None})
    return res


def evidence_of(conn, res: dict) -> dict:
    """回答的"证据链"：数据截止时刻 + 支撑 SQL。

    问答页把这段一并展示，让每个结论都能自己证明不是编的。
    """
    if res.get("evidence_only"):                   # 时钟类回答不查库，不套数据证据链
        return dict(res["evidence_only"])
    ev: dict = {}
    try:
        r = conn.execute("SELECT MAX(updated_at) FROM observation").fetchone()
        ev["站点实况截止"] = r[0] if r else None
        r = conn.execute("SELECT MAX(ts) FROM alarm").fetchone()
        ev["最新预警时间"] = r[0] if r else None
        r = conn.execute("SELECT MIN(date), MAX(date) FROM forecast "
                         "WHERE date >= date('now','localtime')").fetchone()
        if r and r[0]:
            ev["预报窗口"] = "%s ~ %s" % (r[0], r[1])
    except Exception:                              # noqa: BLE001
        pass
    if res.get("sql"):
        ev["支撑 SQL"] = res["sql"]
    return ev
