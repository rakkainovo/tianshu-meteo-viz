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
import json
import os
import queue
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
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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


def build_filters(args, alias: str = "a") -> tuple[str, list]:
    """把查询串翻译成 WHERE 子句（全部参数化，避免注入）"""
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
    if args.get("q"):
        where.append(f"({alias}.title LIKE ? OR {alias}.issuer LIKE ? "
                     f"OR {alias}.city LIKE ? OR {alias}.county LIKE ?)")
        kw = f"%{args['q']}%"
        params.extend([kw] * 4)
    return (" WHERE " + " AND ".join(where)) if where else "", params


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
    meta = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM dataset_meta")}
    conn.close()
    return ok({"kpi": kpi, "types": types, "levels": levels,
               "provinces": provinces, "meta": meta})


# ------------------------------------------------------------------ 预警
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
    conn.close()
    return ok({"total": total, "returned": len(recs), "records": recs})


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


@app.get("/api/alarms/series")
def api_alarm_series():
    """按时间分桶的预警数量（分级堆叠），用于折线/柱状趋势"""
    bucket = request.args.get("bucket", "hour")
    fmt = {"hour": "%Y-%m-%d %H:00", "day": "%Y-%m-%d", "minute10": "%Y-%m-%d %H:"}.get(bucket)
    if not fmt:
        return err("bucket 仅支持 hour/day/minute10")
    where, params = build_filters(request.args)
    conn = db()
    data = rows_to_dicts(conn.execute(
        f"SELECT strftime('{fmt}', REPLACE(ts,'-','-')) AS t, level, level_rank, COUNT(*) AS c "
        f"FROM alarm a{where} GROUP BY t, level ORDER BY t", params))
    conn.close()

    buckets, series_map = [], {}
    for r in data:
        if r["t"] not in buckets:
            buckets.append(r["t"])
        series_map.setdefault(r["level"], {})[r["t"]] = r["c"]
    order = ["红色", "橙色", "黄色", "蓝色", "未知"]
    series = []
    from_levels = rows_to_dicts(db().execute("SELECT name, color, rank FROM alarm_level"))
    cmap = {r["name"]: r["color"] for r in from_levels}
    for lv in order:
        if lv in series_map:
            series.append({"name": lv, "color": cmap.get(lv, "#7a8aa0"), "rank":
                           {"红色": 4, "橙色": 3, "黄色": 2, "蓝色": 1}.get(lv, 0),
                           "data": [series_map[lv].get(b, 0) for b in buckets]})
    return ok({"buckets": buckets, "series": series})


@app.get("/api/alarms/playback")
def api_alarm_playback():
    """时空回放帧：按时间升序返回全部预警点，前端按时间轴逐帧揭示"""
    where, params = build_filters(request.args)
    conn = db()
    recs = rows_to_dicts(conn.execute(
        f"SELECT ts, type, level, level_rank, lng, lat, province, city, county, title, issuer "
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
        f"SELECT s.code, s.province, s.city, s.lng, s.lat, {col} AS value, "
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
    conn = db()
    data = rows_to_dicts(conn.execute(
        f"SELECT s.code, s.province, s.city, {col} AS value, o.info, o.temp, o.humidity "
        f"FROM station s JOIN observation o ON o.code = s.code "
        f"WHERE {col} IS NOT NULL ORDER BY {col} {order} LIMIT ?", [limit]))
    conn.close()
    return ok({"metric": metric, "order": order, "data": data})


@app.get("/api/station/<code>")
def api_station_detail(code: str):
    conn = db()
    st = conn.execute(
        "SELECT s.*, o.temp, o.feelst, o.humidity, o.rain, o.pressure, o.info, "
        "       o.rcomfort, o.icomfort, o.publish_time, o.collected_at "
        "FROM station s LEFT JOIN observation o ON o.code = s.code WHERE s.code = ?",
        [code]).fetchone()
    if not st:
        conn.close()
        return err("站点不存在", 404)
    fc = rows_to_dicts(conn.execute(
        "SELECT * FROM forecast WHERE code = ? ORDER BY date", [code]))
    # 同省站点数，用于详情页给一点上下文
    peer = conn.execute("SELECT COUNT(*) FROM station WHERE province = ?", [st["province"]]).fetchone()[0]
    conn.close()
    return ok({"station": dict(st), "forecast": fc, "peer_count": peer})


@app.get("/api/stations/weather-types")
def api_weather_types():
    conn = db()
    data = rows_to_dicts(conn.execute(
        "SELECT info AS name, COUNT(*) AS count FROM observation "
        "WHERE info IS NOT NULL GROUP BY info ORDER BY count DESC"))
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
    """按名称查区划（含下级），供地图下钻使用"""
    name = request.args.get("name", "")
    conn = db()
    r = conn.execute("SELECT * FROM region WHERE name = ?", [name]).fetchone()
    if not r:
        conn.close()
        return err("未找到该区划", 404)
    children = rows_to_dicts(conn.execute(
        "SELECT adcode, name, lng, lat FROM region WHERE parent = ? ORDER BY adcode",
        [r["adcode"]]))
    conn.close()
    return ok({"region": dict(r), "children": children})


# ------------------------------------------------------------------ 问答
@app.post("/api/qa")
@app.get("/api/qa")
def api_qa():
    from qa import answer_question
    q = (request.get_json(silent=True) or {}).get("q") or request.args.get("q", "")
    if not q.strip():
        return err("请提供问题内容 q")
    try:
        return ok(answer_question(q.strip(), db()))
    except Exception as exc:                                   # noqa: BLE001
        return ok({"question": q, "answer": f"抱歉，解析这个问题时出错了：{exc}",
                   "chart": None, "intent": "error", "confidence": 0})


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
@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path: str):
    target = WEB_DIR / path
    if target.exists() and target.is_file():
        return send_from_directory(WEB_DIR, path)
    return send_from_directory(WEB_DIR, "index.html")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--no-live", action="store_true", help="关闭实时更新，只提供静态数据服务")
    ap.add_argument("--alarm-interval", type=int, default=60, help="预警轮询间隔（秒）")
    ap.add_argument("--weather-interval", type=int, default=45, help="实况轮转间隔（秒）")
    ap.add_argument("--weather-batch", type=int, default=300, help="每轮刷新的站点数")
    ap.add_argument("--typhoon-interval", type=int, default=1800, help="台风更新间隔（秒）")
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
        weather_batch=a.weather_batch, typhoon_interval=a.typhoon_interval)

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
