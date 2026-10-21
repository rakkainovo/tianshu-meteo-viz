# -*- coding: utf-8 -*-
"""
run_collect.py —— 一键采集全国气象数据

用法：
    python run_collect.py            # 采集全部（站点 + 实况 + 预警 + 台风）
    python run_collect.py stations   # 只采站点清单
    python run_collect.py alarms     # 只采预警信号
    python run_collect.py typhoon    # 只采台风路径
    python run_collect.py weather    # 只采站点实况（耗时最长）

产出目录：../data/raw/
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from nmc_client import NmcClient, TyphoonClient, parallel_map, save_json
from weathercn_client import WeatherCnClient

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
RAW.mkdir(parents=True, exist_ok=True)

client = NmcClient(rate=6.0)
weathercn_cli = WeatherCnClient(rate=1.0)
typhoon_cli = TyphoonClient(rate=4.0)


def log(msg: str) -> None:
    print(msg, flush=True)


# ==========================================================================
# 1. 站点清单：34 个省级单位 → 2529 个气象站点
# ==========================================================================
def collect_stations() -> dict:
    log("\n[1/4] 采集全国气象站点清单 ...")
    t0 = time.time()
    provs = client.provinces()
    log("  省级单位 %d 个" % len(provs))

    def one(p):
        cities = client.cities(p["code"])
        for c in cities:
            c["province_code"] = p["code"]
            c["province"] = p.get("name", c.get("province"))
        return cities

    groups, bad = parallel_map(one, provs, workers=5, desc="站点")
    stations = [c for g in groups for c in g]

    # 去重（按 province + city 唯一）
    seen, uniq = set(), []
    for s in stations:
        k = (s.get("province"), s.get("city"))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)

    out = {
        "collected_at": datetime.now().isoformat(timespec="seconds"),
        "source": "中国气象局 www.nmc.cn /rest/province/*",
        "province_count": len(provs),
        "station_count": len(uniq),
        "provinces": provs,
        "stations": uniq,
    }
    save_json(out, RAW / "stations.json")
    log("  ✓ 站点 %d 个 | 失败省级单位 %d 个 | 用时 %.1fs" % (len(uniq), len(bad), time.time() - t0))
    return out


# ==========================================================================
# 2. 全国实时气象预警信号
# ==========================================================================
# 标题结尾有「…蓝色预警信号」和「…蓝色预警」两种写法（后者多见于非气象台
# 发布的次生灾害预警，如「陕西省气象台发布山洪灾害黄色预警」）。
# 「信号」必须可选，否则这类标题整条解析失败 → level 兜底成「未知」。
ALARM_RE = re.compile(
    r"^(?P<issuer>.+?)发布(?P<type>.+?)(?P<level>蓝色|黄色|橙色|红色)预警(?:信号)?")


def parse_alarm(item: dict) -> dict:
    """把标题拆成结构化字段。"""
    title = item.get("title", "")
    m = ALARM_RE.match(title)
    rec = dict(item)
    # 全量标题里提取出所有预警（一条标题可能包含多个）
    hits = ALARM_RE.findall(title)
    rec["alarms"] = [{"issuer": h[0], "type": h[1], "level": h[2]} for h in hits]
    if hits:
        rec["issuer"], rec["type"], rec["level"] = hits[0]
    else:
        rec["issuer"] = rec["type"] = rec["level"] = ""
    # 预警图标编号 p0003003.png → 由图标也能反查类型
    pic = item.get("pic", "")
    m2 = re.search(r"(p\d+)\.png", pic)
    rec["icon"] = m2.group(1) if m2 else ""
    # 站点码：alertid 形如 44011841600000_20260918102435，前缀 12 位为行政区划码+平台码
    aid = item.get("alertid", "")
    rec["adm_code"] = aid.split("_")[0][:6] if "_" in aid else ""
    return rec


def collect_alarms(max_pages: int = 15) -> dict:
    log("\n[2/4] 采集全国气象预警信号 ...")
    t0 = time.time()
    pages = min(client.alarm_total_pages(200), max_pages)
    log("  预警总页数 = %d（本次最多取 %d 页）" % (client.alarm_total_pages(200), pages))

    # 两源合并：nmc 全国流（含 icon）+ 中国天气网补充源（补青海）。
    # 两源共用国家预警发布中心的 alertid，按它去重即可；nmc 优先。
    merged: dict[str, dict] = {}

    def _put(it: dict) -> None:
        rid = it.get("alertid")
        if rid and rid not in merged:
            merged[rid] = it

    for p in range(1, pages + 1):
        j = client.alarms(page_no=p, page_size=200)
        lst = ((j.get("data") or {}).get("page") or {}).get("list") or []
        if not lst:
            break
        for x in lst:
            _put(x)
        log("    第 %d 页 → %d 条（累计 %d）" % (p, len(lst), len(merged)))
        if len(lst) < 200:
            break

    nmc_n = len(merged)
    try:
        for it in weathercn_cli.alarms():
            _put(it)
    except Exception as e:                       # noqa: BLE001
        log("    ! 中国天气网补充源失败（继续用 nmc 结果）: %s" % str(e)[:80])

    raw_items = list(merged.values())
    parsed = [parse_alarm(x) for x in raw_items]
    log("  nmc %d 条 + 补充源去重后合计 %d 条" % (nmc_n, len(raw_items)))

    out = {
        "collected_at": datetime.now().isoformat(timespec="seconds"),
        "source": "中国气象局 www.nmc.cn /rest/findAlarm"
                  " + 中国天气网 forecast.weather.com.cn /api/v1/traffic/alarm/alarmMap",
        "count": len(parsed),
        "records": parsed,
    }
    save_json(out, RAW / "alarms.json")
    log("  ✓ 预警 %d 条 | 用时 %.1fs" % (len(parsed), time.time() - t0))
    return out


# ==========================================================================
# 3. 台风路径
# ==========================================================================
def collect_typhoon() -> dict:
    log("\n[3/4] 采集中央气象台台风路径 ...")
    t0 = time.time()
    lst = typhoon_cli.list_default()
    log("  台风列表 %d 条" % len(lst))

    out_list = []
    for row in lst:
        tid = row[0]
        try:
            d = typhoon_cli.view(tid)
        except Exception as e:                   # noqa: BLE001
            log("    ! 台风 %s 详情失败: %s" % (tid, str(e)[:60]))
            continue
        arr = d.get("typhoon") or []
        # arr[8] = 路径点数组；每个点：
        # [id, 时间(YYYYMMDDHHMM), 毫秒时间戳, 强度等级, 经度, 纬度, 中心气压, 风速, 风向, 移速, 未来预报, 各机构预报]
        pts = []
        seq = arr[8] if len(arr) > 8 and isinstance(arr[8], list) else []
        for p in seq:
            if not isinstance(p, list) or len(p) < 10:
                continue
            pts.append({
                "time": p[1], "ts": p[2], "level": p[3],
                "lon": p[4], "lat": p[5], "pressure": p[6],
                "wind_speed": p[7], "wind_dir": p[8], "move_speed": p[9],
            })
        out_list.append({
            # 注意：官方数组里 row[1] 是英文名、row[2] 是中文名（此处曾写反，已修正）
            "id": tid, "name_en": row[1], "name_cn": row[2],
            "code": row[3], "num": row[5], "active": row[6], "status": row[7],
            "meta": arr[0:8] if len(arr) >= 8 else arr,
            "path": pts,
            "center": arr[4] if len(arr) > 4 else None,
        })
        log("    · %s %s 路径点 %d" % (row[3], row[1], len(pts)))

    out = {
        "collected_at": datetime.now().isoformat(timespec="seconds"),
        "source": "中央气象台 typhoon.nmc.cn /weatherservice/typhoon/jsons/*",
        "count": len(out_list),
        "typhoons": out_list,
    }
    save_json(out, RAW / "typhoons.json")
    log("  ✓ 台风 %d 个 | 用时 %.1fs" % (len(out_list), time.time() - t0))
    return out


# ==========================================================================
# 4. 站点实况 + 预报快照
# ==========================================================================
def collect_weather(limit: int | None = None) -> dict:
    log("\n[4/4] 采集站点实况与预报快照 ...")
    t0 = time.time()
    sp = RAW / "stations.json"
    if not sp.exists():
        collect_stations()
    stations = json.loads(sp.read_text(encoding="utf-8"))["stations"]
    if limit:
        stations = stations[:limit]
    log("  待采集站点 %d 个" % len(stations))

    def one(st):
        d = client.weather(st["code"])
        data = d.get("data") or {}
        real = data.get("real") or {}
        w = real.get("weather") or {}
        pred = data.get("predict") or {}
        detail = pred.get("detail") or []
        days = []
        for dd in detail:
            day = (dd.get("day") or {})
            night = (dd.get("night") or {})
            dw = day.get("weather") or {}
            nw = night.get("weather") or {}
            days.append({
                "date": dd.get("date"),
                "day_info": dw.get("info"), "day_temp": dw.get("temperature"),
                "night_info": nw.get("info"), "night_temp": nw.get("temperature"),
                "day_wind": (day.get("wind") or {}).get("direct"),
                "day_power": (day.get("wind") or {}).get("power"),
                "precip": dd.get("precipitation"),
            })
        return {
            "code": st["code"], "province": st.get("province"), "city": st.get("city"),
            "url": st.get("url"),
            "temp": w.get("temperature"), "feelst": w.get("feelst"),
            "humidity": w.get("humidity"), "pressure": w.get("airpressure"),
            "rain": w.get("rain"), "info": w.get("info"),
            "rcomfort": w.get("rcomfort"), "icomfort": w.get("icomfort"),
            "publish_time": real.get("publish_time"),
            "forecast": days,
        }

    ok, bad = parallel_map(one, stations, workers=6, desc="实况")
    out = {
        "collected_at": datetime.now().isoformat(timespec="seconds"),
        "source": "中国气象局 www.nmc.cn /rest/weather",
        "count": len(ok), "failed": len(bad),
        "stations": ok,
    }
    save_json(out, RAW / "weather_snapshot.json")
    log("  ✓ 实况 %d 条（失败 %d）| 用时 %.1fs" % (len(ok), len(bad), time.time() - t0))
    if bad:
        log("  失败样例：%s" % str(bad[:3])[:300])
    return out


# ==========================================================================
TASKS = {
    "stations": collect_stations,
    "alarms": collect_alarms,
    "typhoon": collect_typhoon,
    "weather": collect_weather,
}

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    limit = None
    for a in sys.argv[1:]:
        if a.startswith("--limit="):
            limit = int(a.split("=")[1])

    todo = args if args else list(TASKS.keys())
    log("=" * 68)
    log(" 中国气象数据采集  |  %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    log(" 任务: %s" % ", ".join(todo))
    log("=" * 68)

    for name in todo:
        fn = TASKS.get(name)
        if not fn:
            log("  ! 未知任务: %s" % name)
            continue
        try:
            if name == "weather":
                fn(limit=limit)
            else:
                fn()
        except Exception as e:                   # noqa: BLE001
            log("  ✗ 任务 %s 失败: %s" % (name, e))

    log("\n请求统计: 成功=%d 失败=%d" % (client.stat_ok, client.stat_fail))
    log("原始数据目录: %s" % RAW.resolve())
