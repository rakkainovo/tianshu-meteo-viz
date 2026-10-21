# -*- coding: utf-8 -*-
"""
app.py —— 天枢平台后端服务

职责：
  1. 提供可视化应用所需的全部只读 REST 接口（查询 SQLite）
  2. 提供行政区划 GeoJSON（本地离线缓存，保证断网可演示）
  3. 承载智能问答接口（见 qa.py）
  4. 托管 web/ 下的前端静态资源

启动：
    python server/app.py            # 默认 http://127.0.0.1:5000
    python server/app.py --port 8000
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import queue
import re
import sqlite3
import sys
import threading
from collections import OrderedDict
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parents[1]
DB_PATH = BASE / "data" / "meteo.db"
GEO_DIR = BASE / "data" / "geo"
WEB_DIR = BASE / "web"

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db as dbmod       # noqa: E402
import live              # noqa: E402

app = Flask(__name__, static_folder=None)
app.config["JSON_AS_ASCII"] = False
app.json.ensure_ascii = False                 # Flask 3.x：直接输出中文

# GeoJSON 缓存（体积较大，避免每次请求都读盘解析）
_geo_cache: OrderedDict[str, dict] = OrderedDict()
_GEO_CACHE_MAX = 40


# ------------------------------------------------------------------ 基础
def db() -> sqlite3.Connection:
    return dbmod.connect(DB_PATH)


def rows_to_dicts(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def ok(payload, **extra):
    body = {"ok": True}
    body.update(payload if isinstance(payload, dict) else {"data": payload})
    body.update(extra)
    return Response(json.dumps(body, ensure_ascii=False), mimetype="application/json; charset=utf-8")


def err(msg: str, code: int = 400):
    return Response(json.dumps({"ok": False, "msg": msg}, ensure_ascii=False),
                    mimetype="application/json; charset=utf-8", status=code)


def filter_conditions(args, alias: str = "a", include_active: bool = True) -> tuple[list, list]:
    """把查询串翻译成 (条件列表, 参数列表)，供调用方自行组合。

    拆成"条件列表"而不是直接拼 WHERE 串，是为了让 /api/alarms/expired 能把
    自己的范围条件（空省集合、时间窗）与这些条件**用 AND 干净地拼在一起**，
    不必去字符串里切 " WHERE " 前缀。

    include_active=False 时不追加 active=1 条件 —— 供 /api/alarms/expired 用：
    那一层要的本来就是"已失效"的行，但其余筛选（type/level/min_rank/since/until）
    必须与地图上的生效点**共用同一套条件**，否则筛选后两者口径不一致
    （曾经就是这样：只看暴雨时生效点被筛掉、背景空心圈却纹丝不动）。
    """
    where, params = [], []
    for col, key in (("type", "type"), ("level", "level"), ("province", "province"),
                     ("city", "city"), ("county", "county"), ("issuer", "issuer")):
        v = args.get(key)
        if v:
            if key == "level":
                where.append(f"{alias}.level = ?")
            else:
                where.append(f"{alias}.{col} = ?")
            params.append(v)
    if args.get("min_rank"):
        where.append(f"{alias}.level_rank >= ?")
        params.append(int(args["min_rank"]))
    if args.get("since"):
        where.append(f"{alias}.ts >= ?")
        params.append(args["since"])
    if args.get("until"):
        where.append(f"{alias}.ts <= ?")
        params.append(args["until"])
    if args.get("ingested_since"):
        where.append(f"{alias}.ingested_at >= ?")
        params.append(args["ingested_since"])
    # 展示时间范围独立于生效标记；按北京时间裁剪，保留原始历史供回放查询。
    period = args.get("period")
    if period in ("today", "15d"):
        now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).replace(tzinfo=None)
        start = (now.replace(hour=0, minute=0, second=0, microsecond=0)
                 if period == "today" else now - datetime.timedelta(days=15))
        where.extend([f"{alias}.ts >= ?", f"{alias}.ts <= ?"])
        params.extend([start.strftime("%Y-%m-%d %H:%M"), now.strftime("%Y-%m-%d %H:%M:%S")])
    # 【生效口径】active=1：只取「最近一轮成功采集」里出现过的那批预警。
    # 上游 /rest/findAlarm 返回的本身就是当前生效清单，所以这个集合就是权威的
    # "此刻生效中"；且它是自适应的——采集断了不会整屏消失，只会停在上一次成功那一轮，
    # 由 active_info() 的 stale 标志如实告诉前端。这比拍一个 now-24h 硬窗口稳。
    # 注意：全部行都写绝对相等（同一轮采集共用一个时间戳），所以等值比较即"那一批"。
    if include_active and str(args.get("active", "")).lower() in ("1", "true", "yes"):
        where.append(f"{alias}.last_seen_at = (SELECT MAX(last_seen_at) FROM alarm)")
    if args.get("q"):
        where.append(f"({alias}.title LIKE ? OR {alias}.issuer LIKE ? "
                     f"OR {alias}.city LIKE ? OR {alias}.county LIKE ?)")
        kw = f"%{args['q']}%"
        params.extend([kw] * 4)
    return where, params


def build_filters(args, alias: str = "a", include_active: bool = True) -> tuple[str, list]:
    """filter_conditions 的便捷包装：返回 (" WHERE a AND b", [...])。"""
    where, params = filter_conditions(args, alias, include_active)
    return (" WHERE " + " AND ".join(where)) if where else "", params


# ---------------------------------------------------------------- 生效口径
# 引擎停摆多久之后就不再声称"这是当前生效"了。上游 findAlarm 的实际窗口恒 ≤ ~24h，
# 所以超过 36 小时没有过成功采集 = 采集链路断了，前端要如实降级提示。
ACTIVE_STALE_HOURS = 36


def _parse_ts(s):
    """库里的时间串有两种写法（分钟后有无秒），逐个格式尝试。"""
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.datetime.strptime(str(s), fmt)
        except ValueError:
            continue
    return None


def active_info(conn, period=None) -> dict:
    """生效口径的元信息：取自哪一轮采集、多少条、是否已停摆。

    这是给界面「自证」用的——用户点开地图就能看到"当前生效：来自 12:33 那一轮 389 条"，
    不用猜这批点是什么时候的。
    """
    row = conn.execute(
        "SELECT MAX(last_seen_at) AS scan_at, COUNT(*) AS n FROM alarm "
        "WHERE last_seen_at = (SELECT MAX(last_seen_at) FROM alarm)").fetchone()
    scan_at = row["scan_at"] if row else None
    where, params = build_filters({"active": 1, "period": period})
    # 生效口径下的派生计数：KPI 卡片要用同一套数，否则卡片写 4,600 条、地图只有 400 个点
    agg = conn.execute(
        "SELECT COUNT(*) AS n, COUNT(DISTINCT province) AS pc, COUNT(DISTINCT city) AS cc,"
        " COUNT(DISTINCT issuer) AS ic,"
        " COALESCE(SUM(CASE WHEN level_rank >= 3 THEN 1 ELSE 0 END), 0) AS severe"
        f" FROM alarm a{where}", params).fetchone()
    dt = _parse_ts(scan_at)
    age_h = round((datetime.datetime.now() - dt).total_seconds() / 3600, 1) if dt else None
    return {"scan_at": scan_at, "active_total": agg["n"], "age_hours": age_h,
            "province_count": agg["pc"] or 0, "city_count": agg["cc"] or 0,
            "issuer_count": agg["ic"] or 0, "severe": agg["severe"] or 0,
            "stale": bool(age_h is not None and age_h > ACTIVE_STALE_HOURS)}


# ------------------------------------------------------------------ 元信息
@app.get("/api/meta")
def api_meta():
    conn = db()
    kpi = dict(conn.execute("""
        SELECT (SELECT COUNT(*) FROM alarm)                                AS alarm_total,
               (SELECT COUNT(DISTINCT province) FROM alarm)                AS province_count,
               (SELECT COUNT(DISTINCT city) FROM alarm)                    AS city_count,
               (SELECT COUNT(DISTINCT issuer) FROM alarm)                  AS issuer_count,
               (SELECT COUNT(DISTINCT type) FROM alarm)                    AS type_count,
               (SELECT COUNT(*) FROM alarm WHERE level_rank >= 3)          AS red_orange,
               (SELECT COUNT(*) FROM station)                              AS station_total,
               (SELECT COUNT(*) FROM observation WHERE temp IS NOT NULL)   AS obs_valid,
               (SELECT COUNT(*) FROM typhoon)                              AS typhoon_total,
               (SELECT COUNT(*) FROM typhoon_path)                         AS typhoon_points,
               (SELECT MIN(ts) FROM alarm)                                 AS ts_from,
               (SELECT MAX(ts) FROM alarm)                                 AS ts_to
    """).fetchone())
    types = rows_to_dicts(conn.execute(
        "SELECT d.name, d.color, COUNT(a.id) AS count FROM disaster_type d "
        "LEFT JOIN alarm a ON a.type = d.name GROUP BY d.name ORDER BY count DESC, d.sort"))
    levels = rows_to_dicts(conn.execute(
        "SELECT l.name, l.color, l.rank, COUNT(a.id) AS count FROM alarm_level l "
        "LEFT JOIN alarm a ON a.level = l.name GROUP BY l.name ORDER BY l.rank"))
    provinces = rows_to_dicts(conn.execute(
        "SELECT r.adcode, r.name, r.lng, r.lat, "
        "       COALESCE(x.cnt,0) AS count, COALESCE(x.max_rank,0) AS max_rank "
        "FROM region r LEFT JOIN ("
        "  SELECT province, COUNT(*) cnt, MAX(level_rank) max_rank FROM alarm GROUP BY province"
        ") x ON x.province = r.name WHERE r.level='province' ORDER BY r.adcode"))
    # 生效口径的同款清单：**关键在于 count=0 的省也要在**。
    # 前端拿它解析省名与 adcode —— 若用"只含有预警的省"的聚合表，
    # "当前无生效预警"的省（今天有 7 个）就会被解析成裸 adcode，下钻直接归零。
    provinces_active = rows_to_dicts(conn.execute(
        "SELECT r.adcode, r.name, r.lng, r.lat, "
        "       COALESCE(x.cnt,0) AS count, COALESCE(x.max_rank,0) AS max_rank "
        "FROM region r LEFT JOIN ("
        "  SELECT province, COUNT(*) cnt, MAX(level_rank) max_rank FROM alarm "
        "  WHERE last_seen_at = (SELECT MAX(last_seen_at) FROM alarm) GROUP BY province"
        ") x ON x.province = r.name WHERE r.level='province' ORDER BY r.adcode"))
    meta = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM dataset_meta")}
    act = active_info(conn)
    conn.close()
    return ok({"kpi": kpi, "types": types, "levels": levels,
               "provinces": provinces, "provinces_active": provinces_active,
               "meta": meta, "active": act})


# ------------------------------------------------------------------ 预警
@app.get("/api/alarms/expired")
def api_alarm_expired():
    """「已失效落区」：只服务于一种展示需求 —— **当前 0 条生效的省级单位**。

    2026-10-02 与用户商定的折中：有生效预警的省保持纯净（默认口径就是"此刻生效"），
    而此刻什么都没有的省，把已失效的落区画成空心浅点当背景，
    免得整省看起来"没数据"（北京此刻 0 条生效，但窗口内有若干条）。

    2026-10-03 **收紧时间窗（hours，默认 72）**：原来不带任何时间限制，等于把库内
    保留期的全部历史都铺出来 —— 实测全国 574 个空心点（福建 311 / 浙江 97 / 海南 95 /
    安徽 52），密到糊成一片，而且把"当前生效预警"（真正要人反应的）的视觉权重压了下去。
    近 72 小时只剩十几个点，语义也更准：从"这省历史上发过"变成"这省**刚刚还在响**"。

    时间基准锚在 **MAX(ts)**（库里最新一条预警的发布时间），不用本机 wall clock：
    这与 qa.py 的相对时间查询同一惯例，且答辩现场若数据是几天前的快照，
    窗口仍然取得到内容，不会整片消失。

    本接口不做通用历史查询 —— 要看全历史请走 /api/alarms（不带 active）。
    前端把它渲染成 silent 系列：不参与悬停与点击定位，因为它不是当前风险。
    """
    limit = min(int(request.args.get("limit", 600)), 2000)
    prov = request.args.get("province")
    try:
        hours = int(request.args.get("hours", 72))
    except (TypeError, ValueError):
        hours = 72
    hours = max(1, min(hours, 24 * 30))
    aw = "last_seen_at = (SELECT MAX(last_seen_at) FROM alarm)"
    # ⚠ 别名不能省：下面要写 "NOT (a.last_seen_at = ...)"。
    # 若写成 "NOT (last_seen_at = ...)"，SQLite 会把裸列名解析到**子查询自己的**
    # alarm 表上（子查询里就是 alarm，不带别名），于是变成恒真的
    # NOT(last_seen_at = MAX(last_seen_at))→ 外层一行都不匹配，接口静默返回 0。
    aw_q = "a.last_seen_at = (SELECT MAX(last_seen_at) FROM alarm)"
    # 已失效 + 落在窗口内。锚点用 MAX(ts) 而非 now()，见 docstring
    recent = "a.ts >= datetime((SELECT MAX(ts) FROM alarm), ?)"
    conn = db()
    try:
        # 空省集合：**当前**（最近一轮采集）0 条生效的省级单位。
        # 这一步刻意不受其他筛选影响 —— 它回答的是"这个省此刻有没有生效预警"，
        # 是范围定义；筛选只作用在下面的"取哪些已失效落区"。
        if prov:
            has = conn.execute(
                f"SELECT COUNT(*) FROM alarm WHERE province = ? AND {aw}",
                (prov,)).fetchone()[0]
            if has:
                return ok({"province": prov, "empty": False, "total": 0, "returned": 0,
                           "hours": hours, "records": []})
            empty = [prov]
        else:
            empty = [r[0] for r in conn.execute(
                "SELECT r.name FROM region r WHERE r.level='province' AND NOT EXISTS ("
                f"  SELECT 1 FROM alarm a WHERE a.province = r.name AND {aw})")]
            if not empty:
                return ok({"empty": True, "total": 0, "returned": 0,
                           "hours": hours, "records": []})
        # 其余筛选（type/level/min_rank/since/until/q）与地图生效点共用同一套条件：
        # include_active=False 是必须的 —— 本层要的就是"已失效"，不能被 active=1 反向筛空。
        conds, params = filter_conditions(request.args, include_active=False)
        # 范围 = 空省集合。全国态下前端不传 province，故这里是唯一的地域约束；
        # 下钻态下前端传了 province，与空省集合是同一个值，取交集结果不变。
        conds.append("a.province IN (%s)" % ",".join("?" * len(empty)))
        params.extend(empty)
        conds.append(f"NOT ({aw_q})")
        conds.append(recent)
        # ⚠ 绑定的是 **修饰符字符串** '-72 hours'，不是整数 72。
        # datetime(X, 72) 会返回 NULL（数字不是合法的修饰符）→ 比较恒假 → 静默 0 条。
        params.append("-%d hours" % hours)
        where_sql = " WHERE " + " AND ".join(conds)
        recs = rows_to_dicts(conn.execute(
            f"SELECT id, ts, type, level, level_rank, lng, lat, province, city, county,"
            f"       title, issuer FROM alarm a {where_sql}"
            f"  AND a.lng IS NOT NULL AND a.lat IS NOT NULL"
            f" ORDER BY a.ts DESC LIMIT ?", params + [limit]))
        total = conn.execute(
            f"SELECT COUNT(*) FROM alarm a {where_sql}", params).fetchone()[0]
    finally:
        conn.close()
    return ok({"province": prov or "", "empty": False, "total": total,
               "returned": len(recs), "hours": hours, "records": recs})


@app.get("/api/alarms")
def api_alarms():
    args = request.args
    limit = min(int(args.get("limit", 500)), 3000)
    order = "DESC" if args.get("order", "desc").lower() == "desc" else "ASC"
    where, params = build_filters(args)
    conn = db()
    recs = rows_to_dicts(conn.execute(
        f"SELECT id, ts, date, hour, title, type, level, level_rank, issuer, "
        f"       province, city, county, adm_code, lng, lat, geo_level, url, ingested_at "
        f"FROM alarm a{where} ORDER BY ts {order} LIMIT ?", params + [limit]))
    total = conn.execute(f"SELECT COUNT(*) FROM alarm a{where}", params).fetchone()[0]
    payload = {"total": total, "returned": len(recs), "records": recs}
    if str(args.get("active", "")).lower() in ("1", "true", "yes"):
        payload["active"] = active_info(conn, args.get("period"))
    conn.close()
    return ok(payload)


@app.get("/api/alarms/agg")
def api_alarm_agg():
    dim = request.args.get("dim", "province")
    col = {"province": "province", "city": "city", "county": "county", "type": "type",
           "level": "level", "issuer": "issuer", "date": "date", "hour": "hour"}.get(dim)
    if not col:
        return err("dim 仅支持 province/city/county/type/level/issuer/date/hour")
    top = min(int(request.args.get("top", 30)), 400)
    where, params = build_filters(request.args)
    conn = db()
    data = rows_to_dicts(conn.execute(
        f"SELECT {col} AS name, COUNT(*) AS count, MAX(level_rank) AS max_rank, "
        f"       SUM(level_rank) AS rank_sum, GROUP_CONCAT(DISTINCT type) AS types "
        f"FROM alarm a{where} GROUP BY {col} HAVING {col} IS NOT NULL AND {col} != '' "
        f"ORDER BY count DESC LIMIT ?", params + [top]))
    # 关联坐标，便于直接在地图上打点
    if dim in ("province", "city", "county"):
        rmap = {r["name"]: r for r in conn.execute(
            "SELECT name, adcode, lng, lat, level FROM region")}
        for d in data:
            r = rmap.get(d["name"])
            d["lng"] = r["lng"] if r else None
            d["lat"] = r["lat"] if r else None
            d["adcode"] = r["adcode"] if r else None
    conn.close()
    return ok({"dim": dim, "data": data})


# ---------------------------------------------------------------- 分桶补密
# 【为什么必须补】/api/alarms/series 原来只发「有数据的钟点」，缺失的小时压根不出现
# （实测库里有 74h / 15h / 5h 的空档）。前端 x 轴是 category
# （theme.js line() 的 boundaryGap:false），于是 74 小时的空档和 1 小时占一样宽 ——
# 时间轴是「假」的，缩放 / 刷选时曲线形态会跟着漂。
#
# 【缺失记 null 不记 0】补出来的桶没有原始行，用 None 占位：
#   null = 那一小时根本没采到 → 折线断开，如实体现「采集停摆」
#   0    = 采到了、只是那小时没有该等级的预警 → 真实为零
# 两者混为一谈会把「断采」画成「零预警」，是数据口径失真（本站最忌讳的一种）。
_BUCKET_SPEC = {
    "hour": ("%Y-%m-%d %H:00", "%Y-%m-%d %H:00", 60),
    "day": ("%Y-%m-%d", "%Y-%m-%d", 1440),
}
_BUCKET_FILL_MAX = 4000        # 补密后的桶数上限，超了退回稀疏（防跨年查询把响应撑爆）


def densify_buckets(bucket: str, keys: list) -> tuple[list, set]:
    """把稀疏的桶 key 序列补成等距序列，返回 (新序列, 原始 key 集合)。

    调用方用 `值 if k in 原集合 else None` 区分「真实 0」与「没采到」。
    minute10 / 脏数据 / 跨度过大 一律原样返回（宁可不补，也不要 500）。
    """
    spec = _BUCKET_SPEC.get(bucket)
    pairs = list(keys)
    if not spec or len(pairs) < 2:
        return pairs, set(pairs)
    fmt, parse, step = spec
    try:
        lo = datetime.datetime.strptime(pairs[0], parse)
        hi = datetime.datetime.strptime(pairs[-1], parse)
    except (ValueError, TypeError):
        return pairs, set(pairs)
    span = int((hi - lo).total_seconds() // 60) // step + 1
    if span <= len(pairs) or span > _BUCKET_FILL_MAX:
        return pairs, set(pairs)
    out = [(lo + datetime.timedelta(minutes=step * i)).strftime(fmt) for i in range(span)]
    return out, set(pairs)


@app.get("/api/alarms/series")
def api_alarm_series():
    """按时间分桶的预警数量，用于折线/柱状趋势。
       dim=level（默认）分级堆叠；dim=province 按省对比（TOP N 省，其余并入「其他」）。

       桶序列会**补密到等距**：缺失的小时补成 null（不是 0），见 densify_buckets。"""
    dim = request.args.get("dim", "level")
    bucket = request.args.get("bucket", "hour")
    fmt = {"hour": "%Y-%m-%d %H:00", "day": "%Y-%m-%d", "minute10": "%Y-%m-%d %H:"}.get(bucket)
    if not fmt:
        return err("bucket 仅支持 hour/day/minute10")
    where, params = build_filters(request.args)
    conn = db()

    if dim == "province":
        top = min(int(request.args.get("top", 8)), 40)
        # 各省按预警总量取 TOP N（排除空省），其余行在前端层归并成「其他」
        top_where = (where + " AND " if where else " WHERE ") + "province IS NOT NULL AND province != ''"
        tops = [r["name"] for r in rows_to_dicts(conn.execute(
            f"SELECT province AS name FROM alarm a{top_where} "
            f"GROUP BY province ORDER BY COUNT(*) DESC LIMIT ?", params + [top]))]
        data = rows_to_dicts(conn.execute(
            f"SELECT strftime('{fmt}', ts) AS t, province AS name, COUNT(*) AS c "
            f"FROM alarm a{where} GROUP BY t, province ORDER BY t", params))

        buckets, smap = [], {}
        for r in data:
            if r["t"] not in buckets:
                buckets.append(r["t"])
            key = r["name"] if r["name"] in tops else "其他"
            smap.setdefault(key, {})[r["t"]] = r["c"]
        buckets, present = densify_buckets(bucket, buckets)

        palette = ["#3fc6ff", "#7cf6d8", "#b48bff", "#ffb648", "#5bc8ff",
                   "#8ee6a8", "#ff6b6b", "#c08b5c", "#ff8a00", "#7f9cff",
                   "#41d6c3", "#ff4d6d", "#9ad0e6", "#d9b26b", "#e0a44a"]
        series = []
        for i, name in enumerate(tops):
            if name in smap:
                series.append({"name": name, "color": palette[i % len(palette)],
                               "data": [smap[name].get(b, 0) if b in present else None
                                        for b in buckets]})
        if "其他" in smap:
            series.append({"name": "其他", "color": "#6f7c90",
                           "data": [smap["其他"].get(b, 0) if b in present else None
                                    for b in buckets]})
        conn.close()
        return ok({"dim": "province", "buckets": buckets, "series": series})

    data = rows_to_dicts(conn.execute(
        f"SELECT strftime('{fmt}', REPLACE(ts,'-','-')) AS t, level, level_rank, COUNT(*) AS c "
        f"FROM alarm a{where} GROUP BY t, level ORDER BY t", params))
    from_levels = rows_to_dicts(conn.execute("SELECT name, color, rank FROM alarm_level"))
    conn.close()

    buckets, series_map = [], {}
    for r in data:
        if r["t"] not in buckets:
            buckets.append(r["t"])
        series_map.setdefault(r["level"], {})[r["t"]] = r["c"]
    buckets, present = densify_buckets(bucket, buckets)
    order = ["红色", "橙色", "黄色", "蓝色", "未知"]
    series = []
    cmap = {r["name"]: r["color"] for r in from_levels}
    for lv in order:
        if lv in series_map:
            series.append({"name": lv, "color": cmap.get(lv, "#7a8aa0"), "rank":
                           {"红色": 4, "橙色": 3, "黄色": 2, "蓝色": 1}.get(lv, 0),
                           "data": [series_map[lv].get(b, 0) if b in present else None
                                    for b in buckets]})
    return ok({"dim": "level", "buckets": buckets, "series": series})


@app.get("/api/alarms/playback")
def api_alarm_playback():
    """时空回放帧：按时间升序返回全部预警点，前端按时间轴逐帧揭示"""
    where, params = build_filters(request.args)
    conn = db()
    recs = rows_to_dicts(conn.execute(
        f"SELECT id, ts, type, level, level_rank, lng, lat, province, city, county, title, issuer "
        f"FROM alarm a{where} ORDER BY ts ASC", params))
    conn.close()
    # 每 10 分钟一帧，形成累计曲线
    frames: dict[str, dict] = {}
    for r in recs:
        key = r["ts"][:15] + "0"          # 截到 10 分钟
        f = frames.setdefault(key, {"t": key, "total": 0, "by_level": {}, "new": []})
        f["total"] += 1
        f["by_level"][r["level"]] = f["by_level"].get(r["level"], 0) + 1
        f["new"].append(r)
    ordered = [frames[k] for k in sorted(frames)]
    return ok({"points": recs, "frames": ordered, "count": len(recs)})


# ------------------------------------------------------------------ 预警上下文
# 行政区名后缀，按"长的优先"排列，逐个尝试剥离。
# 预警表的行政区名带后缀（云浮市 / 郁南县），而气象站表的 city 字段用的是
# 不带后缀的显示名（云浮 / 郁南），直接等值比较一条都匹配不上——这也是
# 问答模块里 city_key() 干同一件事的原因。
_ADMIN_SUFFIX = ("特别行政区", "维吾尔自治区", "回族自治区", "壮族自治区", "自治区",
                 "自治州", "自治县", "自治旗", "地区", "林区", "盟", "市", "县", "区", "旗")


def name_key(name) -> str:
    """行政区名归一化：'郁南县' -> '郁南'，'云浮市' -> '云浮'。"""
    if not name:
        return ""
    s = str(name).strip()
    for suf in _ADMIN_SUFFIX:
        if s.endswith(suf) and len(s) > len(suf):
            return s[:-len(suf)]
    return s


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """两点球面距离（km）。"""
    from math import asin, cos, radians, sin, sqrt
    p1, p2 = radians(lat1), radians(lat2)
    dp = p2 - p1
    dl = radians(lon2 - lon1)
    h = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(h))


@app.get("/api/alarms/<aid>/context")
def api_alarm_context(aid: str):
    """单条预警的"落地上下文"：离落区最近的气象站实况 + 该站未来几日预报。

    预警说的是"未来会怎样"，实况说的是"现在如何"。把两者放在一起，才能
    判断这条预警有没有提前量、有没有兑现——这也是预警详情从"一段静态文本"
    变成"可以核对的现场"的关键一步。

    匹配策略（依次降级，逐级放宽）：
      1. 同县   —— 行政区名归一化后相等（'郁南县' == 站点名 '郁南'）
      2. 同市   —— 同上
      3. 同省   —— 落区坐标最近的站点
    """
    conn = db()
    al = conn.execute("SELECT * FROM alarm WHERE id = ?", [aid]).fetchone()
    if not al:
        conn.close()
        return err("预警不存在", 404)
    al = dict(al)

    prov = al.get("province")
    cand = rows_to_dicts(conn.execute(
        "SELECT s.code, s.city, s.province, s.lng, s.lat, s.geo_source,"
        "       o.temp, o.feelst, o.humidity, o.rain, o.pressure, o.info,"
        "       o.publish_time, o.updated_at, o.updates"
        " FROM station s LEFT JOIN observation o ON o.code = s.code"
        " WHERE (? IS NULL OR s.province = ?)", [prov, prov]))

    ck = name_key(al.get("county"))
    pk = name_key(al.get("city"))
    lon, lat = al.get("lng"), al.get("lat")

    ranked = []
    for s in cand:
        dist = None
        if None not in (lon, lat, s["lng"], s["lat"]):
            dist = haversine(lat, lon, s["lat"], s["lng"])
        sk = name_key(s["city"])
        if ck and sk == ck:
            rank, scope = 0, "county"
        elif pk and sk == pk:
            rank, scope = 1, "city"
        elif pk and len(sk) >= 2 and (sk.startswith(pk) or pk.startswith(sk)):
            rank, scope = 2, "city"
        else:
            rank, scope = 3, "province"
        s["_rank"] = rank
        s["scope"] = scope
        # 站点表里有 289 个站的坐标其实是"省中心兜底"（建库时按站名
        # 反查不到区划，退到了省中心）——这类坐标不能当真实位置用，
        # 同名匹配之外一律排在真实定位的站点之后。
        s["geo_approx"] = (s.pop("geo_source", None) == "province_fallback")
        s["distance_km"] = round(dist, 1) if dist is not None else None
        ranked.append(s)

    ranked.sort(key=lambda x: (x["_rank"], 1 if x["geo_approx"] else 0,
                               x["distance_km"] if x["distance_km"] is not None else 9e9))
    top = ranked[:3]

    now = datetime.datetime.now()
    for s in top:
        s.pop("_rank", None)
        age = None
        if s.get("updated_at"):
            try:
                age = int((now - datetime.datetime.strptime(
                    s["updated_at"], "%Y-%m-%d %H:%M:%S")).total_seconds())
            except ValueError:
                age = None
        s["obs_age"] = age

    best = top[0] if top else None
    today = datetime.date.today().isoformat()
    fc = []
    if best:
        fc = rows_to_dicts(conn.execute(
            "SELECT date, day_info, night_info, day_temp, night_temp, day_power, precip, fetched_at"
            " FROM forecast WHERE code = ? AND date >= ? ORDER BY date LIMIT 3", [best["code"], today]))
    conn.close()

    scope = (best or {}).get("scope", "none")
    notes = {
        "county": "落区所在县有对应气象站，实况可直接对照",
        "city": "落区所在市有对应气象站，实况可作参考",
        "province": "本条为省级预警（未细分到市县），实况取落区附近最近站点，仅供参考",
    }
    return ok({
        "alarm": al,
        "stations": top,
        "match": scope,
        "note": notes.get(scope, "未找到可用气象站"),
        "forecast": fc,
        "forecast_station": ({"code": best["code"], "city": best["city"],
                              "province": best["province"]} if best else None),
        "forecast_fetched_at": (fc[0]["fetched_at"] if fc else None),
        "server_time": now.strftime("%Y-%m-%d %H:%M:%S"),
    })


# ------------------------------------------------------------------ 全局搜索
@app.get("/api/search")
def api_search():
    """全局搜索：一个输入框定位到平台里的任何对象。

    覆盖四类目标——行政区划 / 气象观测站 / 预警信号 / 台风，外加两个筛选项
    （灾种、等级）。每一项都带好 target（去哪个页面、带什么参数），
    前端照着跳即可，不需要自己猜怎么定位。
    """
    q = (request.args.get("q") or "").strip()
    limit = max(1, min(int(request.args.get("limit", 6)), 20))
    if not q:
        return ok({"q": q, "groups": [], "total": 0})

    conn = db()
    kw = f"%{q}%"
    qk = name_key(q)
    kw2 = f"%{qk}%" if qk and qk != q else None
    groups = []

    # ① 行政区划（省级优先，其次市、县）
    sql = ("SELECT adcode, name, level, parent FROM region WHERE name LIKE ?"
           + ("  OR name = ?" if kw2 else "")
           + " ORDER BY CASE level WHEN 'province' THEN 0 WHEN 'city' THEN 1 ELSE 2 END, adcode LIMIT ?")
    params = [kw] + ([qk] if kw2 else []) + [limit]
    regs = rows_to_dicts(conn.execute(sql, params))
    if regs:
        lvcn = {"province": "省级", "city": "地市", "county": "区县"}
        groups.append({"kind": "region", "label": "行政区划", "items": [
            {"title": r["name"], "sub": lvcn.get(r["level"], r["level"]) + " · " + str(r["adcode"]),
             "badge": lvcn.get(r["level"], ""),
             "target": {"view": "alarm", "params": {"adcode": r["adcode"], "name": r["name"],
                                                    "level": r["level"]}}}
            for r in regs]})

    # ② 气象观测站（站号 / 站名 / 省名）
    if kw2:
        srows = rows_to_dicts(conn.execute(
            "SELECT s.code, s.city, s.province, o.temp, o.info FROM station s"
            " LEFT JOIN observation o ON o.code = s.code"
            " WHERE s.code LIKE ? OR s.city LIKE ? OR s.city LIKE ? OR s.province LIKE ?"
            " ORDER BY s.code LIMIT ?", [kw, kw, kw2, kw, limit]))
    else:
        srows = rows_to_dicts(conn.execute(
            "SELECT s.code, s.city, s.province, o.temp, o.info FROM station s"
            " LEFT JOIN observation o ON o.code = s.code"
            " WHERE s.code LIKE ? OR s.city LIKE ? OR s.province LIKE ?"
            " ORDER BY s.code LIMIT ?", [kw, kw, kw, limit]))
    if srows:
        groups.append({"kind": "station", "label": "气象观测站", "items": [
            {"title": r["city"], "sub": "%s · 站号 %s%s" % (
                r["province"], r["code"],
                (" · %s" % r["info"]) if r["info"] else ""),
             "badge": (("%s℃" % round(r["temp"], 1)) if r["temp"] is not None else "无实况"),
             "target": {"view": "station", "params": {"code": r["code"]}}}
            for r in srows]})

    # ③ 预警信号（标题 / 发布单位 / 地区名），默认取最新的几条
    arows = rows_to_dicts(conn.execute(
        "SELECT id, ts, title, type, level, level_rank, issuer, province, city, county"
        " FROM alarm WHERE title LIKE ? OR issuer LIKE ? OR city LIKE ? OR county LIKE ?"
        " ORDER BY ts DESC LIMIT ?", [kw, kw, kw, kw, limit]))
    if arows:
        groups.append({"kind": "alarm", "label": "预警信号", "items": [
            {"title": r["type"] + r["level"] + "预警", "sub": "%s · %s" % (
                r["ts"][5:16], " ".join(x for x in (r["province"], r["city"], r["county"]) if x)),
             "badge": r["level"], "rank": r["level_rank"],
             "target": {"view": "alarm", "params": {"focus": r["id"]}}}
            for r in arows]})

    # ④ 台风（中文名 / 英文名 / 编号）
    trows = rows_to_dicts(conn.execute(
        "SELECT code, name_cn, name_en, max_wind, max_level, status, start_time FROM typhoon"
        " WHERE name_cn LIKE ? OR name_en LIKE ? OR code LIKE ?"
        " ORDER BY (status='start') DESC, start_time DESC LIMIT ?", [kw, kw, kw, limit]))
    if trows:
        groups.append({"kind": "typhoon", "label": "台风", "items": [
            {"title": (r["name_cn"] if r["name_cn"] and r["name_cn"] != "nameless"
                       else (r["name_en"] or "未命名")),
             "sub": "%s · %s · 最大风速 %s m/s" % (
                 r["code"], "活跃中" if r["status"] == "start" else "已停编", r["max_wind"]),
             "badge": "台风",
             "target": {"view": "typhoon", "params": {"code": r["code"]}}}
            for r in trows]})

    # ⑤ 筛选项：灾种 + 等级（"暴雨"、"红色" 这类词直接给出过滤入口）
    dtypes = rows_to_dicts(conn.execute(
        "SELECT name, COUNT(a.id) c FROM disaster_type d LEFT JOIN alarm a ON a.type = d.name"
        " WHERE d.name LIKE ? GROUP BY d.name HAVING c > 0 ORDER BY c DESC LIMIT ?", [kw, limit]))
    if dtypes:
        groups.append({"kind": "type", "label": "按灾种筛选", "items": [
            {"title": r["name"] + "预警", "sub": "全区共 %d 条" % r["c"], "badge": "灾种",
             "target": {"view": "alarm", "params": {"type": r["name"]}}}
            for r in dtypes]})

    lvrows = rows_to_dicts(conn.execute(
        "SELECT l.name, COUNT(a.id) c FROM alarm_level l LEFT JOIN alarm a ON a.level = l.name"
        " WHERE l.name LIKE ? GROUP BY l.name HAVING c > 0 ORDER BY l.rank DESC LIMIT ?", [kw, limit]))
    if lvrows:
        groups.append({"kind": "level", "label": "按等级筛选", "items": [
            {"title": r["name"] + "预警", "sub": "全区共 %d 条" % r["c"], "badge": "等级",
             "target": {"view": "alarm", "params": {"level": r["name"]}}}
            for r in lvrows]})

    conn.close()
    return ok({"q": q, "groups": groups, "total": sum(len(g["items"]) for g in groups)})


# ------------------------------------------------------------------ 站点
@app.get("/api/stations")
def api_stations():
    metric = request.args.get("metric", "temp")
    col = {"temp": "o.temp", "humidity": "o.humidity", "rain": "o.rain",
           "feelst": "o.feelst", "pressure": "o.pressure"}.get(metric)
    if not col:
        return err("metric 仅支持 temp/humidity/rain/feelst/pressure")
    where, params = [], []
    if request.args.get("province"):
        where.append("s.province = ?")
        params.append(request.args["province"])
    if request.args.get("info"):
        where.append("o.info = ?")
        params.append(request.args["info"])
    if request.args.get("valid_only", "1") == "1":
        where.append(f"{col} IS NOT NULL")
    w = (" WHERE " + " AND ".join(where)) if where else ""
    conn = db()
    data = rows_to_dicts(conn.execute(
        f"SELECT s.code, s.province, s.city, s.lng, s.lat, s.geo_source, {col} AS value, "
        f"       o.info, o.temp, o.humidity, o.rain, o.feelst, o.publish_time "
        f"FROM station s JOIN observation o ON o.code = s.code{w} ORDER BY s.province, s.city",
        params))
    conn.close()
    vals = [d["value"] for d in data if d["value"] is not None]
    return ok({"metric": metric, "count": len(data), "stations": data,
               "range": [min(vals), max(vals)] if vals else None})


@app.get("/api/stations/rank")
def api_station_rank():
    metric = request.args.get("metric", "temp")
    col = {"temp": "o.temp", "humidity": "o.humidity", "rain": "o.rain",
           "feelst": "o.feelst"}.get(metric)
    if not col:
        return err("metric 仅支持 temp/humidity/rain/feelst")
    order = "DESC" if request.args.get("order", "desc").lower() == "desc" else "ASC"
    limit = min(int(request.args.get("limit", 12)), 50)
    where, params = [f"{col} IS NOT NULL"], []
    if request.args.get("province"):
        where.append("s.province = ?")
        params.append(request.args["province"])
    if request.args.get("info"):
        where.append("o.info = ?")
        params.append(request.args["info"])
    w = " WHERE " + " AND ".join(where)
    conn = db()
    data = rows_to_dicts(conn.execute(
        f"SELECT s.code, s.province, s.city, {col} AS value, o.info, o.temp, o.humidity "
        f"FROM station s JOIN observation o ON o.code = s.code{w} "
        f"ORDER BY {col} {order} LIMIT ?", params + [limit]))
    conn.close()
    return ok({"metric": metric, "order": order, "data": data})


@app.get("/api/station/<code>")
def api_station_detail(code: str):
    conn = db()
    st = conn.execute(
        "SELECT s.*, o.temp, o.feelst, o.humidity, o.rain, o.pressure, o.info,"
        "       o.rcomfort, o.icomfort, o.publish_time, o.collected_at, o.updated_at,"
        "       o.updates, o.prev_temp, o.prev_ts"
        " FROM station s LEFT JOIN observation o ON o.code = s.code WHERE s.code = ?",
        [code]).fetchone()
    if not st:
        conn.close()
        return err("站点不存在", 404)
    # 预报只返回"今天及以后"：forecast 表按 (code,date) 覆盖写，历史日期不会再更新，
    # 若不过滤就会把一周前的预报当成"未来预报"渲染出来。
    today = datetime.date.today().isoformat()
    limit = max(1, min(int(request.args.get("days", 10)), 16))
    fc = rows_to_dicts(conn.execute(
        "SELECT * FROM forecast WHERE code = ? AND date >= ? ORDER BY date LIMIT ?",
        [code, today, limit]))
    # 同省站点数，用于详情页给一点上下文
    peer = conn.execute("SELECT COUNT(*) FROM station WHERE province = ?", [st["province"]]).fetchone()[0]
    conn.close()
    age = None
    if st["updated_at"]:
        try:
            age = int((datetime.datetime.now() - datetime.datetime.strptime(
                st["updated_at"], "%Y-%m-%d %H:%M:%S")).total_seconds())
        except ValueError:
            age = None
    return ok({"station": dict(st), "forecast": fc, "peer_count": peer,
               "forecast_fetched_at": (fc[0]["fetched_at"] if fc else None),
               "forecast_days": len(fc), "obs_age": age,
               "server_time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")})


@app.post("/api/station/<code>/refresh")
@app.get("/api/station/<code>/refresh")
def api_station_refresh(code: str):
    """按需补采单个站点（前端打开详情时调用）。

    轮转任务约 7 分钟覆盖全国一遍，用户点开的站可能刚好属于最旧的一批。
    这里做一次同步单站采集，让"当前时间的具体天气"不需要等轮转。
    默认 300 秒内的数据视为已足够新；?force=1 可强制刷新。
    """
    eng = live.get_engine()
    if not eng or not eng.enabled:
        return ok({"ok": True, "refreshed": False, "offline": True,
                   "msg": "实时引擎未启用，当前为静态数据集"})
    force = str(request.args.get("force", "")).lower() in ("1", "true", "yes")
    try:
        max_age = max(30, min(int(request.args.get("max_age", 300)), 86400))
    except ValueError:
        max_age = 300
    res = eng.refresh_station(code, force=force, max_age=max_age)
    return ok(res) if res.get("ok") else err(res.get("msg") or "补采失败", 502)


@app.get("/api/stations/weather-types")
def api_weather_types():
    where, params = ["o.info IS NOT NULL"], []
    if request.args.get("province"):
        where.append("s.province = ?")
        params.append(request.args["province"])
    w = " WHERE " + " AND ".join(where)
    conn = db()
    data = rows_to_dicts(conn.execute(
        f"SELECT o.info AS name, COUNT(*) AS count FROM observation o "
        f"JOIN station s ON s.code = o.code{w} GROUP BY o.info ORDER BY count DESC",
        params))
    conn.close()
    return ok({"data": data})


# ------------------------------------------------------------------ 台风
@app.get("/api/typhoons")
def api_typhoons():
    conn = db()
    data = rows_to_dicts(conn.execute(
        "SELECT * FROM typhoon ORDER BY (status='start') DESC, end_time DESC"))
    conn.close()
    return ok({"data": data, "count": len(data)})


@app.get("/api/typhoon/<code>")
def api_typhoon_detail(code: str):
    conn = db()
    ty = conn.execute("SELECT * FROM typhoon WHERE code = ?", [code]).fetchone()
    if not ty:
        conn.close()
        return err("台风不存在", 404)
    pts = rows_to_dicts(conn.execute(
        "SELECT * FROM typhoon_path WHERE code = ? ORDER BY seq", [code]))
    conn.close()
    return ok({"typhoon": dict(ty), "path": pts})


@app.get("/api/typhoons/tracks")
def api_typhoon_tracks():
    """全部台风的简化路径（只保留经纬度与强度），用于地图上一次性画出所有轨迹。
    1536 个点原始体积约 90KB，这里只取必需字段，压到 30KB 以内。"""
    conn = db()
    meta = {r["code"]: dict(r) for r in conn.execute("SELECT * FROM typhoon")}
    out: dict[str, dict] = {}
    for r in conn.execute("SELECT code, lon, lat, level, wind_speed, pressure, time "
                          "FROM typhoon_path ORDER BY code, seq"):
        t = out.setdefault(r["code"], {"code": r["code"], "coords": [], "levels": []})
        t["coords"].append([r["lon"], r["lat"]])
        t["levels"].append(r["level"])
    conn.close()
    data = []
    for code, t in out.items():
        m = meta.get(code, {})
        t.update({"name_cn": m.get("name_cn"), "name_en": m.get("name_en"),
                  "status": m.get("status"), "max_wind": m.get("max_wind"),
                  "max_level": m.get("max_level")})
        data.append(t)
    return ok({"data": data, "count": len(data)})


@app.get("/api/typhoons/overview")
def api_typhoon_overview():
    """年度台风概览：按强度分级统计 + 生成月份"""
    conn = db()
    by_level = rows_to_dicts(conn.execute(
        "SELECT level, COUNT(*) AS count FROM typhoon_path GROUP BY level ORDER BY count DESC"))
    by_month = rows_to_dicts(conn.execute(
        "SELECT substr(start_time,5,2) AS month, COUNT(*) AS count, MAX(max_wind) AS max_wind "
        "FROM typhoon GROUP BY month ORDER BY month"))
    strongest = rows_to_dicts(conn.execute(
        "SELECT code, name_cn, name_en, max_wind, min_pressure, points, track_km, status "
        "FROM typhoon ORDER BY max_wind DESC LIMIT 8"))
    conn.close()
    return ok({"by_level": by_level, "by_month": by_month, "strongest": strongest})


# ------------------------------------------------------------------ 区划 / 地图
@app.get("/api/geo/<adcode>")
def api_geo(adcode: str):
    adcode = "".join(ch for ch in adcode if ch.isdigit())
    if not adcode or len(adcode) not in (6, 7):
        return err("adcode 非法")
    key = adcode if len(adcode) == 6 else adcode[1:]
    candidates = [GEO_DIR / f"{key}.json", GEO_DIR / f"c{key}.json",
                  GEO_DIR / f"{adcode}.json", GEO_DIR / f"c{adcode}.json"]
    for p in candidates:
        if p.exists():
            if key in _geo_cache:
                _geo_cache.move_to_end(key)
                return Response(_geo_cache[key]["body"],
                                mimetype="application/json; charset=utf-8")
            body = p.read_text(encoding="utf-8")
            _geo_cache[key] = {"body": body}
            if len(_geo_cache) > _GEO_CACHE_MAX:
                _geo_cache.popitem(last=False)
            return Response(body, mimetype="application/json; charset=utf-8")
    return err(f"暂无 {adcode} 的地图数据", 404)


@app.get("/api/terrain/<adcode>")
def api_terrain(adcode: str):
    """提供地形高程数据"""
    adcode = "".join(ch for ch in adcode if ch.isdigit())
    if not adcode or len(adcode) not in (6, 7):
        return err("adcode 非法")
    key = adcode if len(adcode) == 6 else adcode[1:]

    terrain_dir = BASE / "data" / "terrain"
    candidates = [terrain_dir / f"{key}.json", terrain_dir / f"{adcode}.json"]

    for p in candidates:
        if p.exists():
            body = p.read_text(encoding="utf-8")
            return Response(body, mimetype="application/json; charset=utf-8")

    return err(f"暂无 {adcode} 的地形数据", 404)


@app.get("/api/regions")
def api_regions():
    """省 -> 市 -> 县 三级联动下拉所需"""
    level = request.args.get("level", "province")
    parent = request.args.get("parent")
    conn = db()
    if level == "province":
        data = rows_to_dicts(conn.execute(
            "SELECT adcode, name, lng, lat FROM region WHERE level='province' ORDER BY adcode"))
    else:
        if not parent:
            conn.close()
            return err("查询下级区划需要 parent 参数")
        data = rows_to_dicts(conn.execute(
            "SELECT adcode, name, lng, lat FROM region WHERE parent = ? ORDER BY adcode", [parent]))
    conn.close()
    return ok({"level": level, "parent": parent, "data": data})


@app.get("/api/regions/lookup")
def api_region_lookup():
    """查行政区划，供地图下钻与跨页跳转使用。

    两种用法：
      ?name=广东省      按名称查（含下级）
      ?adcode=445381    按编码查，并顺带返回 **祖先链**（省 -> 市 -> 县）
                        跨页跳转只需要一个 adcode 就能重建完整下钻栈
    """
    name = request.args.get("name", "")
    adcode = "".join(ch for ch in request.args.get("adcode", "") if ch.isdigit())
    conn = db()
    if adcode:
        r = conn.execute("SELECT * FROM region WHERE adcode = ?", [adcode]).fetchone()
    else:
        r = conn.execute("SELECT * FROM region WHERE name = ?", [name]).fetchone()
    if not r:
        conn.close()
        return err("未找到该区划", 404)
    children = rows_to_dicts(conn.execute(
        "SELECT adcode, name, lng, lat FROM region WHERE parent = ? ORDER BY adcode",
        [r["adcode"]]))
    # 祖先链：省 -> 市 -> 县，最外层在前
    chain, cur, guard = [], r, 0
    while cur is not None and guard < 6:
        chain.insert(0, {"adcode": cur["adcode"], "name": cur["name"],
                         "level": cur["level"], "lng": cur["lng"], "lat": cur["lat"]})
        if not cur["parent"]:
            break
        cur = conn.execute("SELECT * FROM region WHERE adcode = ?", [cur["parent"]]).fetchone()
        guard += 1
    conn.close()
    return ok({"region": dict(r), "children": children, "chain": chain})


# ------------------------------------------------------------------ 问答
@app.get("/api/qa/capability")
def api_qa_capability():
    """问答引擎的通道状态：本地规则通道永远可用，大模型通道视 Key 配置而定。

    前端用它告诉用户"这句话是谁生成的"。只回主机名与模型名，**绝不回 Key**。
    """
    import os
    from qa import llm_available, _llm_conf
    conf = _llm_conf()
    ready = llm_available()
    return ok({
        "rule_ready": True,
        "station_queries": True, "conversation": True, "weather_tools": True,
        "history_retention_days": 30,
        "llm_ready": ready,
        "llm_model": (os.environ.get("LLM_MODEL") or conf.get("model")
                      or "deepseek-chat") if ready else None,
        "llm_host": ((os.environ.get("LLM_BASE") or conf.get("base")
                      or "https://api.deepseek.com/v1").split("//")[-1].split("/")[0]
                     if ready else None),
    })


@app.post("/api/qa")
@app.get("/api/qa")
def api_qa():
    from qa import answer_question
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return err("请求内容必须是JSON对象")
    q = body.get("q") or request.args.get("q", "")
    if not isinstance(q, str) or len(q) > 2000:
        return err("问题必须是文本且不超过2000字")
    if not q.strip():
        return err("请提供问题内容 q")
    context = body.get("context") or {}
    page_context = body.get("page_context") or {}
    messages = body.get("messages") or []
    selection = body.get("selection")
    if selection is not None and (not isinstance(selection, str) or len(selection) > 64):
        return err("站点选择格式不正确")
    if not isinstance(context, dict) or not isinstance(page_context, dict) or not isinstance(messages, list):
        return err("上下文格式不正确")
    if len(json.dumps(context, ensure_ascii=False)) > 16000 or len(messages) > 12:
        return err("上下文过长，请开始新对话")
    conn = db()
    try:
        return ok(answer_question(q.strip(), conn, context, page_context, selection, messages))
    except Exception as exc:                                   # noqa: BLE001
        app.logger.exception("问答查询失败")
        return ok({"question": q, "answer": f"抱歉，解析这个问题时出错了：{exc}",
                   "chart": None, "intent": "error", "confidence": 0})
    finally:
        conn.close()


# ------------------------------------------------------------------ 实时引擎
@app.get("/api/live/status")
def api_live_status():
    """实时引擎运行状态：任务节奏、最近一次结果、覆盖率、事件流、实时曲线。"""
    eng = live.get_engine()
    if not eng:
        return ok({"enabled": False, "reason": "实时引擎未启动（启动服务时加了 --no-live）",
                   "jobs": [], "freshness": {}})
    return ok(eng.status())


@app.get("/api/live/events")
def api_live_events():
    limit = min(int(request.args.get("limit", 40)), 300)
    conn = db()
    data = rows_to_dicts(conn.execute(
        "SELECT ts, kind, text, count FROM live_event ORDER BY id DESC LIMIT ?", [limit]))
    conn.close()
    return ok({"data": data})


@app.get("/api/live/obs-series")
def api_live_obs_series():
    """全国实况观测的时间序列（每分钟一个快照），用于"实时曲线"。"""
    limit = min(int(request.args.get("limit", 120)), 1440)
    conn = db()
    data = rows_to_dicts(conn.execute(
        "SELECT * FROM obs_stat ORDER BY ts DESC LIMIT ?", [limit]))
    conn.close()
    return ok({"data": data[::-1], "count": len(data)})


@app.post("/api/live/run")
@app.get("/api/live/run")
def api_live_run():
    """手动触发一次任务（不阻塞 HTTP，结果通过 SSE 推送）。"""
    eng = live.get_engine()
    if not eng or not eng.enabled:
        return err("实时引擎未启用")
    job = (request.get_json(silent=True) or {}).get("job") or request.args.get("job")
    if job not in live.JOB_META:
        return err("job 仅支持 " + "/".join(live.JOB_META))
    if eng._busy.get(job):
        return ok({"started": False, "msg": f"{job} 正在运行中"})
    threading.Thread(target=eng.run_job, args=(job,), daemon=True).start()
    return ok({"started": True, "job": job})


@app.get("/api/live/stream")
def api_live_stream():
    """SSE 推送：心跳（每 5 秒）+ 数据变更事件。前端据此自动刷新当前页面。"""
    eng = live.get_engine()
    if not eng or not eng.enabled:
        return err("实时引擎未启用", 503)
    q = eng.subscribe()

    def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    payload = q.get(timeout=20)
                    yield "event: %s\ndata: %s\n\n" % (
                        payload.get("type", "message"),
                        json.dumps(payload, ensure_ascii=False))
                except queue.Empty:
                    yield ": keepalive\n\n"
        except GeneratorExit:                 # 客户端断开
            return
        finally:
            eng.unsubscribe(q)

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


# ------------------------------------------------------------------ 静态
# 给 js/css 引用打上 ?v=<最新 mtime>：Flask 静态文件走 Last-Modified / ETag
# 协商缓存，而 mtime 只有**秒级**精度 —— 改完 JS 立刻刷新，浏览器带
# If-Modified-Since 过来，服务端比对后回 304，浏览器就继续跑**改之前**的脚本，
# 表现是"改了没生效"。实测把人和探针都骗过一轮（新写的防连跳守卫看起来没生效，
# 其实是浏览器还在用旧文件）。拼一个随 mtime 变化的查询串就必然重新拉；
# 没改则照旧命中缓存，不影响性能。vendor/ 从不改，不参与打戳。
_ASSET_RE = re.compile(r'(src|href)="(/(?:js|css)/[^"]+)"')


def _asset_version() -> str:
    newest = 0.0
    for sub in ("js", "css"):
        for p in (WEB_DIR / sub).rglob("*"):
            if p.is_file() and p.suffix in (".js", ".css"):
                try:
                    newest = max(newest, p.stat().st_mtime)
                except OSError:
                    pass
    return str(int(newest))


def _index_response() -> Response:
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    v = _asset_version()
    html = _ASSET_RE.sub(lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), v), html)
    return Response(html, mimetype="text/html",
                    headers={"Cache-Control": "no-store, must-revalidate"})


@app.get("/")
def index():
    return _index_response()


@app.get("/<path:path>")
def static_files(path: str):
    target = WEB_DIR / path
    if target.exists() and target.is_file():
        return send_from_directory(WEB_DIR, path)
    return _index_response()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--no-live", action="store_true", help="关闭实时更新，只提供静态数据服务")
    ap.add_argument("--alarm-interval", type=int, default=60, help="预警轮询间隔（秒）")
    ap.add_argument("--weather-interval", type=int, default=30, help="实况轮转间隔（秒）")
    ap.add_argument("--weather-batch", type=int, default=320, help="每轮刷新的站点数")
    ap.add_argument("--typhoon-interval", type=int, default=1800, help="台风更新间隔（秒）")
    ap.add_argument("--request-rate", type=float, default=5.0,
                    help="采集限速（请求/秒）；被目标站点限流时引擎会自动降到 --min-rate")
    ap.add_argument("--min-rate", type=float, default=1.5, help="自适应限速的下限（请求/秒）")
    a = ap.parse_args()

    if not DB_PATH.exists():
        print("未找到数据库，正在构建 ...")
        dbmod.build(DB_PATH)
    else:
        changed = dbmod.migrate(DB_PATH)          # 老库原地升级，保留已积累的预警历史
        if changed:
            print("数据库结构已升级: %s" % ", ".join(changed))

    enabled = not a.no_live and os.environ.get("TIANSHU_LIVE", "1") != "0"
    engine = live.start_engine(
        db_path=DB_PATH, enabled=enabled,
        alarm_interval=a.alarm_interval, weather_interval=a.weather_interval,
        weather_batch=a.weather_batch, typhoon_interval=a.typhoon_interval,
        request_rate=a.request_rate, min_rate=a.min_rate)

    print("=" * 62)
    print("  天枢 · 全国气象监测与灾害预警时空可视化平台")
    print(f"  服务地址: http://{a.host}:{a.port}")
    print(f"  实时引擎: {'已启动（预警 %ds / 实况 %ds×%d 站 / 台风 %ds）' % (a.alarm_interval, a.weather_interval, a.weather_batch, a.typhoon_interval) if enabled else '已关闭'}")
    print("=" * 62)
    try:
        app.run(host=a.host, port=a.port, debug=a.debug, threaded=True)
    finally:
        engine.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
