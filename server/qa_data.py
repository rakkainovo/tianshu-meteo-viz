# -*- coding: utf-8 -*-
"""Grounded weather queries shared by the local parser and bounded LLM tools."""
from __future__ import annotations

import datetime as dt
import json
import re

METRICS = {
    "temp": ("气温", "℃"), "feelst": ("体感温度", "℃"),
    "humidity": ("相对湿度", "%"), "rain": ("观测降水量", "mm"),
    "pressure": ("气压", "hPa"), "weather": ("天气", ""),
}
WEATHER = re.compile(r"气温|温度|几度|多少度|天气|湿度|降水|雨量|气压|体感|更热|更冷|最热|最冷|热不热|冷不冷|风速|风力|风向")
FOLLOW = re.compile(r"它|该站|这个站|这里|那里|这边|那边|呢|明天|后天|昨天|未来|最近|继续|相比|比较|对比")
SUFFIXES = ("特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "自治州", "地区", "省", "市", "县", "区")
PROTECT = ("今天", "明天", "后天", "昨天", "前天", "全国", "当前", "实时", "天气", "气温", "温度", "湿度", "气压", "降水", "体感", "最高", "最低", "平均")


def now():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).replace(tzinfo=None)


def key(name):
    for suffix in SUFFIXES:
        if name.endswith(suffix) and len(name) > len(suffix):
            return name[:-len(suffix)]
    return name


def fmt(value):
    return "缺测" if value is None else f"{value:g}" if isinstance(value, (float, int)) else str(value)


def station_scope(row):
    return {"kind": "station", "code": row["code"], "name": row["city"], "province": row["province"]}


def label(scope):
    return f"{scope['province']}·{scope['name']}站（{scope['code']}）" if scope["kind"] == "station" else scope["name"]


class WeatherQuery:
    def __init__(self, conn):
        self.conn = conn
        self.trace = []
        self.cache = {}
        self.evidence = {"数据来源": "中央气象台公开气象数据", "查询时间": now().isoformat(sep=" ", timespec="seconds")}
        self.stations = [dict(r) for r in conn.execute("SELECT code,city,province FROM station ORDER BY province,city,code")]
        self.provinces = sorted({r["province"] for r in self.stations if r["province"]}, key=len, reverse=True)

    def rows(self, sql, params=()):
        cache_key = (sql, tuple(params))
        if cache_key in self.cache:
            return self.cache[cache_key]
        self.trace.append({"sql": sql, "params": list(params)})
        rows = [dict(r) for r in self.conn.execute(sql, params)]
        self.cache[cache_key] = rows
        return rows

    def validate_scope(self, scope):
        if not isinstance(scope, dict):
            raise ValueError("查询对象必须是已确认的站点或地区")
        if scope.get("kind") == "station":
            found = next((r for r in self.stations if r["code"] == scope.get("code")), None)
            if found:
                return station_scope(found)
        if scope.get("kind") == "province" and scope.get("name") in self.provinces:
            return {"kind": "province", "name": scope["name"]}
        if scope.get("kind") == "national":
            return {"kind": "national", "name": "全国"}
        raise ValueError("没有找到该查询对象，请提供平台内的站名或站点编码")

    def search(self, query, province=None):
        if not isinstance(query, str) or not query.strip():
            return []
        query = re.sub(r"(?:气象站|观测站|站点|站)$", "", query.strip())
        exact = [r for r in self.stations if query == r["code"] or query in (r["city"], key(r["city"] or ""))]
        if province:
            exact = [r for r in exact if province in (r["province"], key(r["province"] or ""))]
        return [station_scope(r) for r in exact[:20]]

    def resolve(self, question):
        # Match full codes first. Short place aliases must never match inside weather words.
        code_hits = []
        for r in self.stations:
            m = re.search(r"(?<![A-Za-z0-9])" + re.escape(r["code"]) + r"(?![A-Za-z0-9])", question)
            if m:
                code_hits.append((m.start(), station_scope(r)))
        if code_hits:
            return [s for _, s in sorted(code_hits, key=lambda x: x[0])], []
        explicit_code = re.search(r"(?:站号|站点编码|站点代码|编码)\s*[:：]?\s*([A-Za-z0-9]+)|([A-Za-z0-9]{4,})\s*站", question)
        if explicit_code:
            raise ValueError("未找到该站点编码。平台编码与国家气象站号可能不同，请使用站点详情中的编码或站名。")
        masked = question
        for word in PROTECT:
            masked = masked.replace(word, " " * len(word))
        prov_hits = [(question.find(p if p in question else key(p)), p) for p in self.provinces
                     if p in question or key(p) in masked]
        prov_names = [p for _, p in prov_hits]
        hits = []
        for r in self.stations:
            city = r["city"] or ""
            for name in sorted({city, key(city)}, key=len, reverse=True):
                if not name or (len(name) < 2 and name != city):
                    continue
                pos = masked.find(name)
                if pos >= 0:
                    hits.append((pos, pos + len(name), r))
                    break
        hits.sort(key=lambda x: (x[0], -(x[1] - x[0])))
        selected, occupied = [], []
        for start, end, row in hits:
            if any(start < b and end > a for a, b in occupied):
                continue
            group = [r for a, b, r in hits if a == start and b == end]
            if len(prov_names) == 1:
                group = [r for r in group if r["province"] == prov_names[0]]
            if not group:
                continue
            occupied.append((start, end))
            if not re.search(r"气象站|观测站|站点|\S站", question) and any(key(r["city"]) == key(r["province"]) for r in group):
                continue
            if len(group) > 1:
                return [], [station_scope(r) for r in group[:20]]
            selected.append((start, station_scope(group[0])))
        for pos, province in prov_hits:
            if not any(s.get("province") == province for _, s in selected):
                selected.append((pos, {"kind": "province", "name": province}))
        if "全国" in question:
            return [{"kind": "national", "name": "全国"}], []
        return [s for _, s in sorted(selected, key=lambda x: x[0])][:4], []

    @staticmethod
    def where(scope, alias="s"):
        if scope["kind"] == "station":
            return f"{alias}.code = ?", [scope["code"]]
        if scope["kind"] == "province":
            return f"{alias}.province = ?", [scope["name"]]
        return "1=1", []

    def observation(self, scopes, metric="weather", order=None, top=10):
        if metric not in METRICS:
            raise ValueError("该气象指标未接入")
        result = []
        for raw in scopes[:4]:
            scope = self.validate_scope(raw)
            where, params = self.where(scope)
            if order:
                column = "temp" if metric == "weather" else metric
                direction = "ASC" if order == "asc" else "DESC"
                sql = (f"SELECT s.code,s.city,s.province,o.{column} value,o.publish_time,o.updated_at "
                       f"FROM station s JOIN observation o ON o.code=s.code WHERE {where} "
                       f"AND o.{column} IS NOT NULL ORDER BY o.{column} {direction},s.code LIMIT ?")
                rows = self.rows(sql, params + [max(1, min(int(top), 30))])
                result.append({"scope": scope, "ranking": rows, "metric": column, "order": direction})
            elif scope["kind"] == "station":
                rows = self.rows("SELECT s.code,s.city,s.province,o.temp,o.feelst,o.humidity,o.rain,o.pressure,o.info,"
                                 "o.publish_time,o.updated_at FROM station s LEFT JOIN observation o ON o.code=s.code "
                                 "WHERE " + where, params)
                result.append({"scope": scope, "station": rows[0] if rows else {}, "metric": metric})
            else:
                rows = self.rows("SELECT COUNT(*) stations,COUNT(o.temp) valid,COUNT(o.humidity) humidity_n,"
                                 "COUNT(o.rain) rain_n,COUNT(o.pressure) pressure_n,COUNT(o.feelst) feelst_n,"
                                 "ROUND(AVG(o.temp),1) temp,ROUND(AVG(o.feelst),1) feelst,"
                                 "ROUND(AVG(o.humidity),1) humidity,ROUND(AVG(o.rain),1) rain,"
                                 "ROUND(AVG(o.pressure),1) pressure,MIN(o.temp) tmin,MAX(o.temp) tmax,"
                                 "MIN(o.publish_time) time_from,MAX(o.publish_time) time_to,"
                                 "MIN(o.updated_at) fetched_from,MAX(o.updated_at) fetched_to "
                                 "FROM station s LEFT JOIN observation o ON o.code=s.code WHERE " + where, params)
                result.append({"scope": scope, "aggregate": rows[0], "metric": metric})
        return {"tool": "get_weather", "results": result}

    def forecast(self, scopes, start, end=None, metric="weather"):
        start_date = dt.date.fromisoformat(start)
        end_date = dt.date.fromisoformat(end or start)
        if not now().date() <= start_date <= end_date <= now().date() + dt.timedelta(days=15):
            raise ValueError("逐日预报仅支持今天起未来15天内的日期，请查询历史实况或缩小预报范围")
        result = []
        for raw in scopes[:4]:
            scope = self.validate_scope(raw)
            where, params = self.where(scope)
            if scope["kind"] == "station":
                rows = self.rows("SELECT f.* FROM forecast f JOIN station s ON s.code=f.code WHERE "
                                 + where + " AND f.date BETWEEN ? AND ? ORDER BY f.date", params + [start, end or start])
            else:
                rows = self.rows("SELECT f.date,COUNT(*) n,ROUND(AVG(f.day_temp),1) day_temp,"
                                 "ROUND(AVG(f.night_temp),1) night_temp,"
                                 "SUM(CASE WHEN f.day_info LIKE '%雨%' OR f.night_info LIKE '%雨%' THEN 1 ELSE 0 END) rain_n,"
                                 "MIN(f.fetched_at) fetched_from,MAX(f.fetched_at) fetched_at "
                                 "FROM forecast f JOIN station s ON s.code=f.code WHERE " + where
                                 + " AND f.date BETWEEN ? AND ? GROUP BY f.date ORDER BY f.date", params + [start, end or start])
            result.append({"scope": scope, "days": rows, "metric": metric, "start": start, "end": end or start})
        return {"tool": "get_forecast", "results": result}

    def history(self, scopes, start, end, metric="temp"):
        if metric not in METRICS or metric == "weather":
            metric = "temp"
        lo, hi = dt.datetime.fromisoformat(start), dt.datetime.fromisoformat(end)
        if lo.tzinfo or hi.tzinfo or lo >= hi or (hi - lo).total_seconds() > 30 * 86400:
            raise ValueError("历史查询需提供有效时间范围，最长30天")
        result = []
        table = self.conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='observation_history'").fetchone()
        for raw in scopes[:4]:
            scope = self.validate_scope(raw)
            if scope["kind"] != "station":
                raise ValueError("历史趋势需要指定具体站点，请提供站名或站点编码")
            points = self.rows(f"SELECT ts,{metric} value FROM observation_history WHERE code=? "
                               f"AND ts>=? AND ts<? AND {metric} IS NOT NULL ORDER BY ts LIMIT 10000",
                               [scope["code"], start, end]) if table else []
            result.append({"scope": scope, "points": points, "metric": metric, "start": start, "end": end})
        return {"tool": "get_history", "results": result}

    def alarms(self, scopes):
        from qa import active_where
        result = []
        for raw in scopes[:4]:
            scope = self.validate_scope(raw)
            where, params = [active_where()], []
            if scope["kind"] == "province":
                where.append("a.province=?")
                params.append(scope["name"])
            elif scope["kind"] == "station":
                where.append("a.province=?")
                params.append(scope["province"])
                name = scope["name"]
                variants = list({name, key(name), key(name) + "市", key(name) + "县", key(name) + "区"})
                placeholders = ",".join("?" for _ in variants)
                where.append(f"(a.city IN ({placeholders}) OR a.county IN ({placeholders}))")
                params.extend(variants + variants)
            rows = self.rows("SELECT a.id,a.title,a.type,a.level,a.ts,a.province,a.city,a.county FROM alarm a WHERE "
                             + " AND ".join(where) + " ORDER BY a.level_rank DESC,a.ts DESC LIMIT 100", params)
            scan = self.conn.execute("SELECT MAX(ts) FROM alarm_scan WHERE ok=1").fetchone()
            self.evidence["预警采集时刻"] = scan[0] if scan else None
            result.append({"scope": scope, "alarms": rows})
        return {"tool": "get_alarms", "results": result}

    def dispatch(self, name, args):
        if not isinstance(args, dict):
            raise ValueError("工具参数必须是对象")
        if name == "search_stations":
            return {"candidates": self.search(args.get("query", ""), args.get("province"))}
        funcs = {"get_weather": self.observation, "get_forecast": self.forecast,
                 "get_history": self.history, "get_alarms": self.alarms}
        if name not in funcs:
            raise ValueError("不支持该查询工具")
        if not isinstance(args.get("scopes"), list) or not 1 <= len(args["scopes"]) <= 4:
            raise ValueError("每次查询需要1至4个明确对象")
        allowed = {"get_weather": {"scopes", "metric", "order", "top"},
                   "get_forecast": {"scopes", "start", "end", "metric"},
                   "get_history": {"scopes", "start", "end", "metric"}, "get_alarms": {"scopes"}}
        if set(args) - allowed[name]:
            raise ValueError("包含未支持的查询参数")
        return funcs[name](**args)


def time_plan(q, previous):
    today = now().date()
    mode, start, end = "observation", None, None
    absolute = re.findall(r"\d{4}-\d{2}-\d{2}", q)
    day_offset = next((offset for word, offset in (("大后天", 3), ("后天", 2), ("明天", 1), ("前天", -2), ("昨天", -1), ("今天", 0), ("今日", 0)) if word in q), None)
    month_day = re.search(r"(\d{1,2})月(\d{1,2})[日号]?", q)
    if absolute or month_day or day_offset is not None:
        date = dt.date.fromisoformat(absolute[0]) if absolute else dt.date(today.year, int(month_day[1]), int(month_day[2])) if month_day else today + dt.timedelta(days=day_offset)
        last = dt.date.fromisoformat(absolute[1]) if len(absolute) > 1 else date
        if date < today:
            mode, start, end = "history", str(date) + " 00:00:00", str(last + dt.timedelta(days=1)) + " 00:00:00"
        elif date > today or "预报" in q or "最高" in q or "最低" in q:
            mode, start, end = "forecast", str(date), str(last)
    future = re.search(r"(?:未来|接下来|今后)\s*(\d+|一|二|两|三|七)\s*天", q)
    recent = re.search(r"(?:最近|近|过去)\s*(\d+|一|二|两|三|七)\s*(小时|天)", q)
    numbers = {"一": 1, "二": 2, "两": 2, "三": 3, "七": 7}
    if future:
        n = numbers.get(future[1]) or int(future[1])
        if not 1 <= n <= 16:
            raise ValueError("预报范围最多包含今天起16个日期")
        mode, start, end = "forecast", str(today), str(today + dt.timedelta(days=n - 1))
    if recent:
        n = numbers.get(recent[1]) or int(recent[1])
        hours = n * (24 if recent[2] == "天" else 1)
        if not 0 < hours <= 720:
            raise ValueError("历史查询最长30天")
        mode = "history"
        end = now().isoformat(sep=" ", timespec="seconds")
        start = (now() - dt.timedelta(hours=hours)).isoformat(sep=" ", timespec="seconds")
    elif re.search(r"趋势|变化|走势", q) and not future and day_offset is None and not absolute:
        mode, start, end = "history", (now() - dt.timedelta(hours=24)).isoformat(sep=" ", timespec="seconds"), now().isoformat(sep=" ", timespec="seconds")
    elif re.search(r"预报|未来", q) and start is None:
        mode, start, end = "forecast", str(today), str(today + dt.timedelta(days=2))
    elif not re.search(r"现在|当前|此刻|实时|今天|今日", q) and start is None and previous.get("mode") in ("forecast", "history"):
        mode, start, end = previous["mode"], previous.get("start"), previous.get("end")
    return {"mode": mode, "start": start, "end": end}


def metric_of(q):
    for words, metric in ((r"体感", "feelst"), (r"湿度|潮湿|更湿", "humidity"), (r"降水|降雨|雨量|雨最大|下雨最多", "rain"),
                          (r"气压", "pressure"), (r"气温|温度|几度|多少度|更热|更冷|最热|最冷|热不热|冷不冷", "temp"), (r"天气", "weather")):
        if re.search(words, q):
            return metric
    return None


def render(query, outputs, question):
    from qa import bar_option, line_option
    parts, chart, suggestions = [], None, []
    colors = ["#3fc6ff", "#7cf6d8", "#ff8a00", "#b48bff"]
    comparisons, forecasts, histories = [], [], []
    for output in outputs:
        for i, result in enumerate(output.get("results", [])):
            scope, metric = result["scope"], result.get("metric", "weather")
            title, unit = METRICS.get(metric, METRICS["weather"])
            heading = f"**{label(scope)}**"
            if "station" in result:
                r = result["station"]
                obs_time = r.get("publish_time")
                parts.append(heading + (f"：{title} **{fmt(r.get(metric))}{unit}**。" if metric != "weather" else f"：{r.get('info') or '天气现象缺测'}。"))
                parts.append("| 气温 | 体感温度 | 相对湿度 | 观测降水量 | 气压 |\n|---|---|---|---|---|\n"
                             + "| " + " | ".join(fmt(r.get(k)) + (u if r.get(k) is not None else "") for k, u in (("temp", "℃"), ("feelst", "℃"), ("humidity", "%"), ("rain", "mm"), ("pressure", "hPa"))) + " |")
                parts.append(f"观测发布：{obs_time or '未知'}；采集更新：{r.get('updated_at') or '未知'}。")
                query.evidence[label(scope) + "观测时刻"] = obs_time or "未知"
                query.evidence[label(scope) + "采集时刻"] = r.get("updated_at") or "未知"
                if not obs_time:
                    parts.append("缺少观测发布时间，无法确认这条数据是否代表当前实况。")
                else:
                    try:
                        age = (now() - dt.datetime.fromisoformat(obs_time)).total_seconds()
                        if age > 7200:
                            parts.append("该站观测已超过2小时，以上为最近一次实况，请刷新站点后核对。")
                    except ValueError:
                        parts.append("观测时间格式不完整，无法确认数据新鲜度。")
                comparisons.append((scope, r.get(metric), obs_time, metric))
                suggestions = [f"{scope['name']}站明天天气怎么样？", f"{scope['name']}站最近24小时气温变化如何？", f"{scope['name']}站有哪些生效预警？"]
            elif "aggregate" in result:
                r = result["aggregate"]
                parts.append(heading + f"：{r['stations']} 个站点，{r['valid']} 个站有气温观测。")
                if metric == "weather":
                    parts.append(f"平均气温 **{fmt(r['temp'])}℃**，站间范围 {fmt(r['tmin'])}～{fmt(r['tmax'])}℃；平均相对湿度 {fmt(r['humidity'])}%。")
                else:
                    n = r["valid"] if metric == "temp" else r.get(metric + "_n", 0)
                    parts.append(f"{n} 个站有{title}观测，站点平均{title} **{fmt(r[metric])}{unit}**。")
                parts.append(f"观测发布时间范围：{r['time_from'] or '未知'}～{r['time_to'] or '未知'}。")
                query.evidence[label(scope) + "观测范围"] = f"{r['time_from'] or '未知'}～{r['time_to'] or '未知'}"
                comparisons.append((scope, r.get("temp" if metric == "weather" else metric), r["time_to"], "temp" if metric == "weather" else metric))
            elif "ranking" in result:
                rows = result["ranking"]
                parts.append(heading + f"·{title}排名：\n" + ("\n".join(f"- {r['province']}·{r['city']}站（{r['code']}）：**{fmt(r['value'])}{unit}**，观测 {r['publish_time'] or '未知'}" for r in rows) or "没有有效观测。"))
                if rows:
                    chart = bar_option(title + "排名", [r["city"] for r in rows], [r["value"] for r in rows], horizontal=True, unit=unit)
            elif "days" in result:
                rows = result["days"]
                forecasts.append(result)
                parts.append(heading + f"·{result['start']} 至 {result['end']}逐日预报")
                if not rows:
                    parts.append("该站或地区在所问日期没有可用预报，不能用当前实况替代。")
                else:
                    if metric in ("humidity", "pressure", "feelst", "rain"):
                        parts.append(f"当前逐日预报没有可靠的{title}预测，以下提供天气现象和白天最高／夜间最低气温。")
                    parts.append("| 日期 | 白天最高 | 夜间最低 | 天气／覆盖 | 风向风力 | 更新 |\n|---|---|---|---|---|---|\n" + "\n".join(
                        f"| {r['date']} | {fmt(r['day_temp'])}℃ | {fmt(r['night_temp'])}℃ | "
                        + (f"{r.get('day_info') or '缺测'}／{r.get('night_info') or '缺测'}" if scope["kind"] == "station" else f"{r['n']}站，{r['rain_n']}站预报有雨")
                        + f" | {r.get('day_wind') or '未提供'} {r.get('day_power') or ''} | {r.get('fetched_at') or '未知'} |" for r in rows))
                    query.evidence[label(scope) + "预报更新"] = min((r.get("fetched_from") or r.get("fetched_at") or "未知") for r in rows)
                    present = {r['date'] for r in rows}
                    expected = (dt.date.fromisoformat(result['end']) - dt.date.fromisoformat(result['start'])).days + 1
                    if len(present) < expected:
                        parts.append("部分所问日期缺少预报，表格仅列出有记录的日期。")
                    if len(rows) > 1:
                        chart = line_option("逐日气温预报", [r["date"] for r in rows], [{"name": "白天最高", "data": [r["day_temp"] for r in rows], "color": colors[0]}, {"name": "夜间最低", "data": [r["night_temp"] for r in rows], "color": colors[1]}])
                    if re.search(r"带伞|下雨吗|会下雨|有雨吗", question):
                        rainy = any("雨" in (r.get("day_info", "") or "") + (r.get("night_info", "") or "") or r.get("rain_n", 0) for r in rows)
                        parts.append("预报包含降雨，建议带伞。" if rainy else "已查预报未出现降雨描述，出门前仍需核对最新预报。")
            elif "points" in result:
                rows = result["points"]
                parts.append(heading + f"·{title}历史（{result['start']} 至 {result['end']}）")
                if len(rows) < 2:
                    parts.append(f"当前只有 {len(rows)} 条有效历史观测，尚不足以分析变化。历史从实际采集开始积累，无法补造过去记录。")
                else:
                    values = [r["value"] for r in rows]
                    histories.append(result)
                    delta = values[-1] - values[0]
                    parts.append(f"共 {len(rows)} 条观测，实际覆盖 {rows[0]['ts']}～{rows[-1]['ts']}；最低 **{fmt(min(values))}{unit}**，最高 **{fmt(max(values))}{unit}**；首尾变化 **{delta:+.1f}{unit}**。")
                    chart = line_option(title + "历史观测", [r["ts"] for r in rows], [{"name": label(scope), "data": values, "color": colors[i % 4]}])
                    query.evidence[label(scope) + "历史覆盖"] = f"{rows[0]['ts']}～{rows[-1]['ts']}"
                    if (dt.datetime.fromisoformat(rows[0]["ts"]) - dt.datetime.fromisoformat(result["start"])).total_seconds() > 3600:
                        parts.append("历史记录未覆盖所问时段的起点，以上结论仅适用于实际覆盖范围。")
                    if (dt.datetime.fromisoformat(result["end"]) - dt.datetime.fromisoformat(rows[-1]["ts"])).total_seconds() > 3600:
                        parts.append("历史记录未覆盖所问时段的末尾，无法判断之后的变化。")
            elif "alarms" in result:
                rows = result["alarms"]
                parts.append(heading + "·所在地生效预警：\n" + ("\n".join(f"- {r['title']}（{r['ts']}）" for r in rows[:12]) or "未匹配到覆盖该站所在地的生效预警。"))
                parts.append("预警按行政区匹配，并非站点直接发布；结果取自最近一次成功采集。")
    if len(forecasts) == 2 and forecasts[0]['scope'] != forecasts[1]['scope']:
        a, b = forecasts
        shared = sorted({r['date'] for r in a['days']} & {r['date'] for r in b['days']})
        for date in shared:
            ar = next(r for r in a['days'] if r['date'] == date)
            br = next(r for r in b['days'] if r['date'] == date)
            if ar['day_temp'] is not None and br['day_temp'] is not None:
                difference = ar['day_temp'] - br['day_temp']
                parts.append(f"**{date}对比**：{label(a['scope'])}预报白天最高温比{label(b['scope'])}" +
                             (f"高 {fmt(difference)}℃。" if difference > 0 else f"低 {fmt(-difference)}℃。" if difference < 0 else "相同。"))
        if not shared:
            parts.append("两个查询对象没有共同日期的预报，无法比较。")
    if len(histories) > 1:
        times = sorted({r['ts'] for item in histories for r in item['points']})
        series = []
        for i, item in enumerate(histories):
            values = {r['ts']: r['value'] for r in item['points']}
            series.append({"name": label(item['scope']), "data": [values.get(t) for t in times], "color": colors[i % 4]})
        chart = line_option("单站历史观测对比", times, series)
    if len(comparisons) == 2 and comparisons[0][0] != comparisons[1][0] and comparisons[0][3] == comparisons[1][3] and comparisons[0][3] != 'weather':
        a, b = comparisons
        m = comparisons[0][3]
        if a[1] is not None and b[1] is not None:
            delta = a[1] - b[1]
            parts.append(f"**对比结论**：{label(a[0])}的{METRICS[m][0]}比{label(b[0])}" + (f"高 {fmt(delta)}{METRICS[m][1]}。" if delta > 0 else f"低 {fmt(-delta)}{METRICS[m][1]}。" if delta < 0 else "相同。") + "不同站点可能有发布时间差异；地区查询使用站点均值。")
            chart = bar_option(METRICS[m][0] + "对比", [s[0]["name"] for s in comparisons], [s[1] for s in comparisons], unit=METRICS[m][1])
        else:
            parts.append("至少一个查询对象缺少所问指标，无法给出有效对比。")
    if any(re.search(r"降水|雨量", p) for p in parts):
        parts.append("降水数值沿用上游观测字段，统计时段未注明；不能据此认定当前正在下雨，也不能相加当作24小时雨量。")
    if re.search(r"穿什么|穿衣|冷吗|热吗", question):
        temps = [r['station'].get('temp') for o in outputs for r in o.get('results', []) if 'station' in r]
        temps += [d.get('night_temp') for item in forecasts for d in item['days']]
        temps = [t for t in temps if t is not None]
        if temps:
            low = min(temps)
            parts.append("穿衣建议：" + ("注意保暖，准备厚外套。" if low < 10 else "建议长袖并备外套。" if low < 20 else "可选轻薄衣物，早晚按个人体感增减。") + "建议仅依据已查气温，不含个体健康判断。")
    if re.search(r"紫外线|防晒", question):
        parts.append("未接入紫外线指数，无法评估具体防晒等级。")
    if re.search(r"出行|户外|晾晒", question):
        rainy = any('雨' in (d.get('day_info') or '') + (d.get('night_info') or '') or d.get('rain_n', 0) for item in forecasts for d in item['days'])
        parts.append("预报存在降雨，户外活动或晾晒需留意天气变化。" if rainy else "现有数据不足以保证出行或晾晒条件，需结合风力和最新预警判断。")
    if re.search(r"明天|未来|预报|后天", question) and re.search(r"几点|上午|下午|晚上|小时", question):
        parts.append("当前只有逐日预报，无法判断具体小时的天气。")
    return {"answer": "\n\n".join(parts), "chart": chart, "suggestions": suggestions}


def unique_outputs(outputs):
    """A station frame already contains every metric; render it only once."""
    grouped, seen = [], set()
    for output in outputs:
        results = []
        for result in output.get('results', []):
            scope = result['scope']
            identity = (output['tool'], scope['kind'], scope.get('code') or scope['name'],
                        result.get('start'), result.get('end'),
                        result.get('metric') if 'ranking' in result or 'points' in result else None,
                        result.get('order'))
            if identity not in seen:
                seen.add(identity)
                results.append(result)
        if results:
            grouped.append({**output, 'results': results})
    return grouped


def result_for(query, q, outputs, plan, engine="data", explanation=None):
    outputs = unique_outputs(outputs)
    result = render(query, outputs, q)
    if explanation:
        result["answer_rule"] = result["answer"]
        result["answer"] += "\n\n" + explanation
    scopes = plan.get("scopes", [])
    intent = {"observation": "station_detail", "forecast": "station_forecast", "history": "station_history", "alarms": "station_alarms"}.get(plan.get("mode"), "weather_tools")
    if any('ranking' in r for o in outputs for r in o.get('results', [])):
        intent = 'station_extreme' if sum(len(r.get('ranking', [])) for o in outputs for r in o.get('results', [])) <= 1 else 'station_rank'
    elif plan.get('mode') == 'observation' and len(scopes) > 1:
        intent = 'station_compare'
    elif plan.get('mode') == 'observation' and plan.get('metric') == 'weather' and all(s['kind'] != 'station' for s in scopes):
        intent = 'weather_summary'
    if len({o['tool'] for o in outputs}) > 1:
        intent = 'weather_tools'
    result.update({"question": q, "intent": intent,
                   "engine": engine, "slots": {"对象": "、".join(label(s) for s in scopes), "指标": METRICS.get(plan.get("metric"), METRICS["weather"])[0], "时间": (plan.get("start") or "最近实况") + (" 至 " + plan["end"] if plan.get("end") else "")},
                   "context": plan, "evidence": query.evidence, "queries": query.trace,
                   "sql": "\n\n".join(r["sql"] + "\n参数: " + json.dumps(r["params"], ensure_ascii=False) for r in query.trace),
                   "confidence": None})
    if len(scopes) == 1 and scopes[0]["kind"] == "station":
        result["focus"] = {"view": "station", "params": {"code": scopes[0]["code"]}}
        station = scopes[0]
        prefix = station['province'] + station['name'] + '站'
        result['suggestions'] = [prefix + '现在气温多少？', prefix + '明天天气怎么样？', prefix + '最近24小时气温变化如何？', prefix + '有哪些生效预警？']
    return result


def tool_plan(question, outputs, previous):
    plan = time_plan(question, previous)
    scopes = []
    for output in outputs:
        for result in output.get('results', []):
            if result['scope'] not in scopes:
                scopes.append(result['scope'])
    plan.update({'scopes': scopes[:4], 'metric': metric_of(question) or previous.get('metric', 'weather')})
    kinds = {o['tool'] for o in outputs}
    if plan['mode'] == 'observation' and kinds == {'get_alarms'}:
        plan['mode'] = 'alarms'
    return plan


def clarification(q, context, candidates=None, message=None):
    return {"question": q, "intent": "clarify", "engine": "data", "answer": message or "找到多个同名站点，请选择具体站点。",
            "chart": None, "slots": {}, "context": {**context, "pending_question": q}, "candidates": candidates or [], "confidence": None}


def answer_weather(q, conn, context=None, page_context=None, selection=None, messages=None):
    """Return None only when the legacy alarm/typhoon/clock engine owns the question."""
    context = context if isinstance(context, dict) else {}
    previous = context
    if selection:
        q = context.get("pending_question") or q
    has_context = bool(context.get("scopes"))
    is_alarm = bool(re.search(r"预警|警报|台风", q))
    advice = bool(re.search(r"带伞|下雨吗|会下雨|有雨吗|穿什么|穿衣|冷吗|热吗|适合出行|户外|防晒|晾晒", q))
    if re.search(r"星期|周几|几点|几号|日期", q) and not WEATHER.search(q):
        return None
    if re.search(r"气象站|站点|观测站", q) and re.search(r"多少个|几个|数量|总数|有多少", q):
        return None
    relevant = bool(WEATHER.search(q) or advice or re.search(r"站号|站点编码|气象站|观测站|\S站", q) or (has_context and FOLLOW.search(q)))
    if not relevant:
        return None
    query = WeatherQuery(conn)
    try:
        scopes, candidates = query.resolve(q)
        if candidates:
            if selection:
                selected = query.validate_scope({"kind": "station", "code": selection})
                if selected["code"] not in {s["code"] for s in candidates}:
                    raise ValueError("所选站点不在本次候选列表中")
                scopes = [selected]
            else:
                return clarification(q, context, candidates)
        station_alarm = is_alarm and "台风" not in q and not WEATHER.search(q) and not advice and ((scopes and all(s["kind"] == "station" for s in scopes)) or (has_context and not scopes and FOLLOW.search(q)))
        if '台风' in q or (is_alarm and not station_alarm and (not scopes or not (WEATHER.search(q) or advice))):
            return None
        if re.search(r"各个|每个|各站|站点清单|各区", q) and not station_alarm and not re.search(r"明天|后天|未来|预报|昨天|历史", q):
            return None
        compare = bool(re.search(r"比|相比|比较|对比|哪个更|谁更", q))
        if len(scopes) == 1 and has_context and compare and FOLLOW.search(q):
            old = query.validate_scope(context['scopes'][0])
            if old != scopes[0]:
                scopes = [old, scopes[0]]
        if not scopes and re.search(r"(?:气象站|观测站|站点|[\u4e00-\u9fff]{2,}站)", q) and not re.search(r"它|该站|这个站|当前站", q):
            return clarification(q, context, message="没有找到这个站点，请核对站名或使用站点详情中的平台编码。")
        followup = bool(re.search(r"它|该站|这个站|这里|那里|这边|那边|呢[？?]?$|^(?:明天|后天|昨天|最近|未来|继续)", q))
        bare_metric = bool(re.fullmatch(r"(?:现在|当前|此刻|今日|今天)?(?:的)?(?:气温|湿度|天气|温度|气压|降水|体感|多少度|几度)(?:多少|如何|怎么样|是多少|多少度)?[？?]?", q))
        if not scopes and has_context and (followup or bare_metric):
            scopes = [query.validate_scope(s) for s in context["scopes"][:4]]
        if not scopes and isinstance(page_context, dict) and page_context.get("station_code") and (followup or bare_metric):
            scopes = [query.validate_scope({"kind": "station", "code": page_context["station_code"]})]
        rank = bool(re.search(r"最高|最低|最热|最冷|排名|排行|最潮湿|湿度最大|降水最多|降雨最多|下雨最多", q))
        if not scopes:
            if rank or q in ("今天天气怎么样？", "今天天气怎么样", "全国天气怎么样？"):
                scopes = [{"kind": "national", "name": "全国"}]
            else:
                return clarification(q, context, message="请指定站点或地区，例如“沙坪坝站现在气温多少”。也可以在站点页面选择一个站，再询问“它明天呢”。")
        if scopes and not FOLLOW.search(q):
            previous = {}
        metric = metric_of(q) or previous.get("metric", "weather")
        if metric not in METRICS:
            metric = "weather"
        plan = {**time_plan(q, previous), "scopes": scopes, "metric": metric}
        if all(s['kind'] == 'station' for s in scopes) and re.search(r'今天|今日', q) and re.search(r'最高|最低', q) and not re.search(r'预报|预计|预测', q):
            plan.update({'mode': 'history', 'start': str(now().date()) + ' 00:00:00', 'end': now().isoformat(sep=' ', timespec='seconds')})
        if re.search(r"风速|风力|风向", q) and plan["mode"] != "forecast":
            return clarification(q, plan, message="当前实况没有接入可靠的风速、风向字段。可查询该站逐日预报中的风向与风力描述。")
        if station_alarm:
            if re.search(r"昨天|前天|历史|最近|过去|未来|明天|后天", q):
                return clarification(q, context, message="本站所在地预警目前仅提供最近采集的生效快照，不能作为历史预警或未来预警。可按地区查询预警发布时间范围。")
            plan["mode"] = "alarms"
            plan['start'] = plan['end'] = None
            outputs = [query.alarms(scopes)]
        elif plan["mode"] == "forecast":
            outputs = [query.forecast(scopes, plan["start"], plan["end"], metric)]
            if re.search(r"现在|当前|实时|实况", q):
                outputs.insert(0, query.observation(scopes, metric))
        elif plan["mode"] == "history":
            outputs = [query.history(scopes, plan["start"], plan["end"], metric)]
        else:
            order = None
            if rank:
                order = "asc" if re.search(r"最低|最冷", q) else "desc"
                metric = metric if metric != "weather" else "temp"
                plan["metric"] = metric
            top = re.search(r"前\s*(\d+)|top\s*(\d+)", q, re.I)
            outputs = [query.observation(scopes, metric, order, int(top[1] or top[2]) if top else (10 if re.search(r"排名|排行", q) else 1))]
        if advice and plan["mode"] == "observation":
            # Keep the existing regional advice; single stations use their own facts.
            if not any(s["kind"] == "station" for s in scopes):
                return None
            outputs.append(query.forecast(scopes, str(now().date()), str(now().date()), metric))
            outputs.append(query.alarms(scopes))
        if re.search(r"预警|警报", q) and not station_alarm:
            outputs.append(query.alarms(scopes))
        return result_for(query, q, outputs, plan)
    except (ValueError, TypeError, KeyError) as exc:
        return clarification(q, context, message=str(exc))


def tool_schemas():
    scope = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["station", "province", "national"]}, "code": {"type": "string"}, "name": {"type": "string"}}, "required": ["kind"]}
    common = {"scopes": {"type": "array", "items": scope, "minItems": 1, "maxItems": 4}, "metric": {"type": "string", "enum": list(METRICS)}}
    specs = [
        ("search_stations", "按确切站名或平台编码查找站点。多个同名结果必须先向用户澄清。", {"query": {"type": "string"}, "province": {"type": "string"}}, ["query"]),
        ("get_weather", "读取指定站点或地区的最新实况，可比较多个对象。", {**common, "order": {"type": "string", "enum": ["asc", "desc"]}, "top": {"type": "integer", "minimum": 1, "maximum": 30}}, ["scopes"]),
        ("get_forecast", "按日期查询逐日预报，不能用实况代替。日期格式YYYY-MM-DD。", {**common, "start": {"type": "string"}, "end": {"type": "string"}}, ["scopes", "start"]),
        ("get_history", "指定单站的历史实况。起止时间格式YYYY-MM-DD HH:MM:SS，最长30天。", {**common, "start": {"type": "string"}, "end": {"type": "string"}}, ["scopes", "start", "end"]),
        ("get_alarms", "按所在地匹配生效预警。", {"scopes": common["scopes"]}, ["scopes"]),
    ]
    return [{"type": "function", "function": {"name": name, "description": desc, "parameters": {"type": "object", "properties": props, "required": required, "additionalProperties": False}}} for name, desc, props, required in specs]


def answer_with_tools(q, conn, context=None, messages=None):
    from qa import _llm_chat, hallucination_ratio, llm_available
    if not llm_available():
        return None
    query, outputs = WeatherQuery(conn), []
    context = context if isinstance(context, dict) else {}
    try:
        requested, candidates = query.resolve(q)
        if candidates:
            return clarification(q, context, candidates)
    except ValueError:
        return None
    conversation = [{"role": "system", "content": "你是气象数据助手。先通过工具取得具体数据后回答，禁止自行写SQL或编造事实。"
                     "工具只查询本地数据库。站点需先search_stations解析，同名站必须澄清；地区可直接使用省全称。"
                     "最新实况、未来预报、历史观测必须区分。最终用简短中文解释，不计算数值。当前北京时间："
                     + now().isoformat(sep=" ", timespec="seconds") + "。已确认查询上下文：" + json.dumps(context, ensure_ascii=False)}]
    for message in (messages or [])[-6:]:
        if isinstance(message, dict) and message.get("role") in ("user", "assistant") and isinstance(message.get("content"), str):
            conversation.append({"role": message["role"], "content": message["content"][:1500]})
    conversation.append({"role": "user", "content": q})
    plan = dict(context)
    for _ in range(3):
        response = _llm_chat(conversation, temperature=0, timeout=12, tools=tool_schemas())
        if not isinstance(response, dict):
            break
        calls = response.get("tool_calls") or []
        if not isinstance(calls, list) or len(calls) > 6 or any(not isinstance(c, dict) or not isinstance(c.get('function'), dict) for c in calls):
            break
        if not calls:
            if outputs:
                explanation = response.get("content") or ""
                facts = json.dumps(outputs, ensure_ascii=False)
                if hallucination_ratio(explanation, facts) != 0:
                    explanation = None
                return result_for(query, q, outputs, tool_plan(q, outputs, context), "tools+llm", explanation)
            return None
        conversation.append({"role": "assistant", "content": response.get("content"), "tool_calls": calls})
        for call in calls[:6]:
            try:
                name = call["function"]["name"]
                args = json.loads(call["function"]["arguments"])
                if name != 'search_stations' and requested and isinstance(args, dict):
                    for scope in args.get('scopes', []):
                        resolved = query.validate_scope(scope)
                        if not any(resolved == s or (s['kind'] == 'province' and resolved.get('province') == s['name']) for s in requested):
                            raise ValueError('工具查询对象与用户指定的站点或地区不一致')
                value = query.dispatch(name, args)
                if name == "search_stations" and len(value["candidates"]) > 1:
                    return clarification(q, context, value["candidates"])
                if value.get("results"):
                    outputs.append(value)
                    plan.update({"scopes": [r["scope"] for r in value["results"]], "metric": args.get("metric", "weather"), "mode": {"get_weather": "observation", "get_forecast": "forecast", "get_history": "history", "get_alarms": "alarms"}[name], "start": args.get("start"), "end": args.get("end")})
            except (ValueError, KeyError, TypeError) as exc:
                value = {"error": str(exc)}
            conversation.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(value, ensure_ascii=False)})
    return result_for(query, q, outputs, tool_plan(q, outputs, context), "tools") if outputs else None
