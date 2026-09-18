# -*- coding: utf-8 -*-
"""
db.py —— SQLite 数据库构建

把 crawler 采集并清洗后的 JSON 数据集，装载进 SQLite，供后端 API 查询。

设计要点：
1. region 表由**地图 GeoJSON 自身**生成（adcode / name / center / level / parent），
   而不是靠字符串猜地名 —— 这样"朝阳区"到底属于北京还是长春不会有歧义。
2. station 表只有站名没有经纬度，这里用 region 表做行政区划反查补全坐标。
3. 事实表按分析维度做了冗余（date / hour / province / city），
   前端多图联动时不必反复做字符串解析。

用法：
    python db.py            # 重建数据库
    python db.py --stats    # 重建后打印体检报告
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
GEO = BASE / "data" / "geo"
PROC = BASE / "data" / "processed"
DB_PATH = BASE / "data" / "meteo.db"

# 预警信号四级色标（沿用中国气象局官方发布色）
LEVEL_COLOR = {"蓝色": "#3d7eff", "黄色": "#ffd233", "橙色": "#ff8a00", "红色": "#ff3b47", "未知": "#7a8aa0"}
LEVEL_RANK = {"蓝色": 1, "黄色": 2, "橙色": 3, "红色": 4, "未知": 0}

# 热带气旋强度分级（中国气象局标准）
TY_RANK = {"TD": 1, "TS": 2, "STS": 3, "TY": 4, "STY": 5, "SuperTY": 6}

# 灾种语义色（深色大屏下保持可分辨度）
TYPE_COLOR = {
    "暴雨": "#2f9bff", "大风": "#41d6c3", "雷电": "#b48bff", "大雾": "#9aa7b8",
    "寒潮": "#4dd0ff", "高温": "#ff6b35", "地质灾害": "#c08b5c", "雷雨大风": "#5bc8ff",
    "暴雪": "#8fd6ff", "道路结冰": "#a8e0ff", "雷暴大风": "#7f9cff", "沙尘暴": "#d9b26b",
    "冰雹": "#8ee6a8", "霜冻": "#9ad0e6", "台风": "#ff4d6d", "霾": "#b0a58c",
    "干旱": "#e0a44a", "其他": "#6f7c90",
}

SCHEMA = """
PRAGMA journal_mode = WAL;

-- 行政区划（源自标准 GeoJSON，含省市县三级）
CREATE TABLE IF NOT EXISTS region (
    adcode   TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    level    TEXT NOT NULL,          -- province / city / district
    parent   TEXT,                   -- 上级 adcode
    lng      REAL, lat REAL
);
CREATE INDEX IF NOT EXISTS idx_region_parent ON region(parent);
CREATE INDEX IF NOT EXISTS idx_region_name   ON region(name);

-- 灾种字典
CREATE TABLE IF NOT EXISTS disaster_type (
    name TEXT PRIMARY KEY, color TEXT, sort INT
);

-- 等级字典
CREATE TABLE IF NOT EXISTS alarm_level (
    name TEXT PRIMARY KEY, rank INT, color TEXT
);

-- 预警信号事实表
CREATE TABLE IF NOT EXISTS alarm (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,                -- 发布时间：YYYY-MM-DD HH:MM
    date TEXT, hour INT,
    title TEXT, type TEXT, level TEXT, level_rank INT,
    issuer TEXT,
    province TEXT, city TEXT, county TEXT,
    adm_code TEXT, lng REAL, lat REAL, geo_level TEXT,
    icon TEXT, url TEXT,
    ingested_at TEXT                 -- 入库时刻（实时引擎写入，用于"新增"高亮）
);
CREATE INDEX IF NOT EXISTS idx_alarm_ts       ON alarm(ts);
CREATE INDEX IF NOT EXISTS idx_alarm_province ON alarm(province);
CREATE INDEX IF NOT EXISTS idx_alarm_city     ON alarm(city);
CREATE INDEX IF NOT EXISTS idx_alarm_type     ON alarm(type);
CREATE INDEX IF NOT EXISTS idx_alarm_level    ON alarm(level_rank);

-- 气象站点
CREATE TABLE IF NOT EXISTS station (
    code TEXT PRIMARY KEY,
    province TEXT, city TEXT,
    lng REAL, lat REAL, url TEXT,
    geo_source TEXT                  -- city / district / province_fallback
);
CREATE INDEX IF NOT EXISTS idx_station_province ON station(province);

-- 站点实况（每个站点保留最新一帧；prev_* 保存上一帧，用于实时展示增减趋势）
CREATE TABLE IF NOT EXISTS observation (
    code TEXT PRIMARY KEY,
    collected_at TEXT, publish_time TEXT,
    temp REAL, feelst REAL, humidity REAL, rain REAL, pressure REAL,
    info TEXT, rcomfort INT, icomfort INT,
    updated_at TEXT,                 -- 最近一次被实时引擎刷新的时刻
    prev_temp REAL, prev_humidity REAL, prev_rain REAL, prev_pressure REAL,
    prev_ts TEXT,
    updates INT DEFAULT 0,           -- 累计刷新次数
    next_try_at TEXT,                -- 失败退避：在此之前不再轮询该站
    fail_count INT DEFAULT 0         -- 连续失败次数（成功后清零）
);

-- 全国实时观测聚合（实时引擎每刷新一批站点写一行，用于"实时曲线"）
CREATE TABLE IF NOT EXISTS obs_stat (
    ts TEXT PRIMARY KEY,             -- YYYY-MM-DD HH:MM:SS
    n INT,                           -- 本批有效站点数
    temp_avg REAL, temp_max REAL, temp_min REAL,
    hum_avg REAL, rain_sum REAL, rain_stations INT,
    temp_max_station TEXT, temp_min_station TEXT
);

-- 实时事件流（供前端"数据流"面板展示）
CREATE TABLE IF NOT EXISTS live_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, kind TEXT, text TEXT, count INT
);
CREATE INDEX IF NOT EXISTS idx_live_event_ts ON live_event(ts);

-- 七日预报
CREATE TABLE IF NOT EXISTS forecast (
    code TEXT, date TEXT,
    day_info TEXT, night_info TEXT,
    day_temp REAL, night_temp REAL,
    day_wind TEXT, day_power TEXT, precip REAL,
    PRIMARY KEY (code, date)
);

-- 台风（路径已做长度/强度派生计算，避免前端二次遍历）
CREATE TABLE IF NOT EXISTS typhoon (
    code TEXT PRIMARY KEY,
    tid INT, num INT, name_cn TEXT, name_en TEXT, status TEXT, active TEXT,
    start_time TEXT, end_time TEXT, points INT,
    max_wind REAL, min_pressure REAL, track_km REAL,
    max_level TEXT, max_level_rank INT,
    min_lon REAL, max_lon REAL, min_lat REAL, max_lat REAL
);

-- 台风路径点
CREATE TABLE IF NOT EXISTS typhoon_path (
    code TEXT, seq INT, ts INT, time TEXT, level TEXT,
    lon REAL, lat REAL, pressure REAL, wind_speed REAL,
    wind_dir TEXT, move_speed REAL,
    PRIMARY KEY (code, seq)
);

-- 数据集元信息
CREATE TABLE IF NOT EXISTS dataset_meta (
    key TEXT PRIMARY KEY, value TEXT
);
"""

# 依赖实时引擎新增列的索引 —— 必须在建列之后才能真正创建（老库需先 ALTER）
LATE_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_alarm_ingested ON alarm(ingested_at);
CREATE INDEX IF NOT EXISTS idx_obs_updated    ON observation(updated_at);
"""


# ---------------------------------------------------------------- 工具
def log(m: str) -> None:
    print(m, flush=True)


def norm(name: str) -> str:
    """地名归一：去掉行政级别后缀，便于站名与区划名对齐"""
    if not name:
        return ""
    s = name.strip()
    for suf in ("特别行政区", "维吾尔自治区", "回族自治区", "壮族自治区", "自治区",
                "自治州", "自治县", "地区", "盟", "省", "市", "区", "县", "旗"):
        if s.endswith(suf) and len(s) > len(suf):
            s = s[: -len(suf)]
            break
    return s


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    from math import asin, cos, radians, sin, sqrt
    lon1, lat1 = a
    lon2, lat2 = b
    dlon, dlat = radians(lon2 - lon1), radians(lat2 - lat1)
    h = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


# ---------------------------------------------------------------- 区划表
def load_regions() -> list[tuple]:
    """从 GeoJSON 构建 省 / 市 / 县 三级区划"""
    rows: list[tuple] = []
    nat = GEO / "100000.json"
    if not nat.exists():
        raise SystemExit("缺少全国地图 data/geo/100000.json，请先运行 crawler/fetch_geo.py")

    doc = json.loads(nat.read_text(encoding="utf-8"))
    provinces: list[int] = []
    for f in doc["features"]:
        p = f["properties"]
        ac, nm, c = p.get("adcode"), p.get("name"), p.get("center")
        # 国界文件里夹带"南海诸岛"等非行政区要素（adcode 形如 100000_JD），需剔除
        if not ac or not nm or not str(ac).isdigit():
            continue
        ac = int(ac)
        if ac == 100000:
            continue
        provinces.append(ac)
        rows.append((str(ac), nm, "province", "100000", c[0] if c else None, c[1] if c else None))

    for ac in provinces:
        pf = GEO / f"{ac}.json"
        if not pf.exists():
            continue
        cities: list[int] = []
        for f in json.loads(pf.read_text(encoding="utf-8"))["features"]:
            p = f["properties"]
            cad, cnm, c = p.get("adcode"), p.get("name"), p.get("center")
            if not cad or not cnm:
                continue
            cities.append(int(cad))
            rows.append((str(cad), cnm, "city", str(ac), c[0] if c else None, c[1] if c else None))

        for cad in cities:
            cf = GEO / f"c{cad}.json"
            if not cf.exists():
                continue
            for f in json.loads(cf.read_text(encoding="utf-8"))["features"]:
                p = f["properties"]
                dad, dnm, c = p.get("adcode"), p.get("name"), p.get("center")
                if not dad or not dnm:
                    continue
                rows.append((str(dad), dnm, "district", str(cad), c[0] if c else None, c[1] if c else None))
    return rows


def build_region_index(region_rows: list[tuple]) -> dict:
    """构造两级索引，供站点反查坐标

    气象站的 `city` 字段是五花八门的地名：有的写地级市（"石家庄"），
    有的写区县（"昌平"），有的还带括号注解（"鹿泉（石家庄）"）。
    所以这里建两套索引：

        flat[(省名, 归一化地名)]  任意层级地名 -> 中心点（限定在同一省内，避免"朝阳"打架）
        flat[("*", 省名)]         省级中心点，用于兜底
    """
    by_ad = {r[0]: r for r in region_rows}
    flat: dict[tuple[str, str], tuple[float, float]] = {}

    # 先算出每个 adcode 归属的省名
    prov_of: dict[str, str] = {}

    def walk(ac: str, depth: int = 0) -> str:
        if ac in prov_of:
            return prov_of[ac]
        r = by_ad.get(ac)
        if not r or depth > 4:
            return ""
        if r[2] == "province":
            prov_of[ac] = r[1]
        else:
            prov_of[ac] = walk(r[3] or "", depth + 1)
        return prov_of[ac]

    for ac in by_ad:
        walk(ac)

    # 省级中心点
    for ac, nm, lv, parent, lng, lat in region_rows:
        if lv == "province" and lng is not None:
            flat[("*", norm(nm))] = (lng, lat)
            flat[("*", nm)] = (lng, lat)

    # 市 / 县：按"省 + 地名"登记（先市后县，市级优先命中）
    for want in ("city", "district"):
        for ac, nm, lv, parent, lng, lat in region_rows:
            if lv != want or lng is None:
                continue
            pname = prov_of.get(ac, "")
            if not pname:
                continue
            flat.setdefault((pname, norm(nm)), (lng, lat))
            flat.setdefault((pname, nm), (lng, lat))

    return {"flat": flat, "by_ad": by_ad, "prov_of": prov_of}


def station_candidates(city: str) -> list[str]:
    """把站名拆成候选地名："鹿泉（石家庄）" -> ["鹿泉", "石家庄"]"""
    c = (city or "").strip()
    out: list[str] = []
    for l, r in (("（", "）"), ("(", ")")):
        if l in c and r in c:
            inner = c[c.find(l) + 1: c.rfind(r)].strip()
            outer = c[: c.find(l)].strip()
            out.extend([outer, inner])
            break
    out.append(c)
    # 去掉常见修饰后缀（"牧试站""农试站""观测站"等）
    tail = re.sub(r"(气象站|观测站|牧试站|农试站|农气站|试验站|水文站|站)$", "", c).strip()
    if tail and tail != c:
        out.append(tail)
    return [x for x in dict.fromkeys(out) if x]


# ---------------------------------------------------------------- 导入
def build(db_path: Path = DB_PATH, region_rows: list[tuple] | None = None) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    for suf in ("-wal", "-shm"):
        p = Path(str(db_path) + suf)
        if p.exists():
            p.unlink()

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)

    # --- 区划 ---
    region_rows = region_rows or load_regions()
    conn.executemany("INSERT OR REPLACE INTO region VALUES (?,?,?,?,?,?)", region_rows)
    log(f"  region       : {len(region_rows)} 条"
        f"（省 {sum(1 for r in region_rows if r[2]=='province')}"
        f" / 市 {sum(1 for r in region_rows if r[2]=='city')}"
        f" / 县 {sum(1 for r in region_rows if r[2]=='district')}）")

    ridx = build_region_index(region_rows)
    flat = ridx["flat"]

    # --- 字典 ---
    conn.executemany("INSERT OR REPLACE INTO disaster_type VALUES (?,?,?)",
                     [(k, v, i) for i, (k, v) in enumerate(TYPE_COLOR.items())])
    conn.executemany("INSERT OR REPLACE INTO alarm_level VALUES (?,?,?)",
                     [(k, v, LEVEL_COLOR[k]) for k, v in LEVEL_RANK.items()])

    # --- 站点 ---
    sp = PROC / "stations.json"
    if sp.exists():
        rows, hits = [], {"city": 0, "province_fallback": 0}
        stations = json.loads(sp.read_text(encoding="utf-8"))["stations"]
        for s in stations:
            prov, city = s.get("province", ""), s.get("city", "")
            pt, src = flat.get(("*", norm(prov))), "province_fallback"
            for cand in station_candidates(city):
                hit = flat.get((prov, norm(cand))) or flat.get((prov, cand))
                if hit:
                    pt, src = hit, "city"
                    break
            if pt is None:                      # 连省中心都缺失时退到全国几何中心
                pt = (104.0, 35.0)
            hits[src] = hits.get(src, 0) + 1
            rows.append((s["code"], prov, city, pt[0], pt[1], None, src))
        conn.executemany("INSERT OR REPLACE INTO station VALUES (?,?,?,?,?,?,?)", rows)
        rate = hits["city"] / max(len(rows), 1) * 100
        log(f"  station      : {len(rows)} 个（地名级命中 {hits['city']} = {rate:.1f}%"
            f" / 省中心兜底 {hits['province_fallback']}）")

    # --- 实况 ---
    wp = PROC / "weather.json"
    if wp.exists():
        pack = json.loads(wp.read_text(encoding="utf-8"))
        # 统一成 "YYYY-MM-DD HH:MM:SS"（快照里是 ISO 的 T 分隔），
        # 否则与实时引擎写入的时间串比较时会出错
        collected = (pack.get("collected_at") or "").replace("T", " ")
        obs, fcs = [], []
        for s in pack["stations"]:
            obs.append((s["code"], collected, s.get("publish_time"),
                        s.get("temp"), s.get("feelst"), s.get("humidity"),
                        s.get("rain"), s.get("pressure"), s.get("info"),
                        s.get("rcomfort"), s.get("icomfort"),
                        collected, None, None, None, None, None, 0, None, 0))
            for d in s.get("forecast") or []:
                def num(v):
                    try:
                        return float(v)
                    except (TypeError, ValueError):
                        return None
                fcs.append((s["code"], d.get("date"), d.get("day_info"), d.get("night_info"),
                            num(d.get("day_temp")), num(d.get("night_temp")),
                            d.get("day_wind"), d.get("day_power"), num(d.get("precip"))))
        conn.executemany(
            "INSERT OR REPLACE INTO observation (code, collected_at, publish_time, temp, feelst,"
            " humidity, rain, pressure, info, rcomfort, icomfort, updated_at, prev_temp,"
            " prev_humidity, prev_rain, prev_pressure, prev_ts, updates, next_try_at, fail_count)"
            " VALUES (" + ",".join("?" * 20) + ")", obs)
        conn.executemany("INSERT OR REPLACE INTO forecast VALUES (?,?,?,?,?,?,?,?,?)", fcs)
        log(f"  observation  : {len(obs)} 条 / forecast {len(fcs)} 条")

    # --- 台风 ---
    tp = PROC / "typhoons.json"
    if tp.exists():
        pack = json.loads(tp.read_text(encoding="utf-8"))
        ty, pts = typhoon_rows(pack["typhoons"])
        if ty:
            conn.executemany("INSERT OR REPLACE INTO typhoon VALUES ("
                             + ",".join("?" * 19) + ")", ty)
            conn.executemany("INSERT OR REPLACE INTO typhoon_path VALUES ("
                             + ",".join("?" * 11) + ")", pts)
        log(f"  typhoon      : {len(ty)} 个 / {len(pts)} 路径点")

    # --- 预警 ---
    ap = PROC / "alarms.json"
    if ap.exists():
        pack = json.loads(ap.read_text(encoding="utf-8"))
        built = __import__("datetime").datetime.now().isoformat(timespec="seconds")
        rows = []
        for r in pack["records"]:
            ts = (r.get("time") or "").replace("/", "-")
            rows.append((r.get("id"), ts, ts[:10],
                         int(ts[11:13]) if len(ts) >= 13 else None,
                         r.get("title"), r.get("type"), r.get("level"), r.get("level_rank"),
                         r.get("issuer"), r.get("province"), r.get("city"), r.get("county"),
                         r.get("adm_code"), r.get("lng"), r.get("lat"), r.get("geo_level"),
                         r.get("icon"), r.get("url"), r.get("ingested_at") or built))
        conn.executemany(
            "INSERT OR REPLACE INTO alarm (id, ts, date, hour, title, type, level, level_rank,"
            " issuer, province, city, county, adm_code, lng, lat, geo_level, icon, url, ingested_at)"
            " VALUES (" + ",".join("?" * 19) + ")", rows)
        log(f"  alarm        : {len(rows)} 条")

    # --- 元信息 ---
    meta = {
        "built_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "source_alarm": "中国气象局 www.nmc.cn /rest/findAlarm",
        "source_station": "中国气象局 www.nmc.cn /rest/weather",
        "source_typhoon": "中央气象台 typhoon.nmc.cn",
        "source_geo": "阿里 DataV 标准行政区划边界",
    }
    conn.executemany("INSERT OR REPLACE INTO dataset_meta VALUES (?,?)", list(meta.items()))
    conn.executescript(LATE_INDEXES)
    conn.commit()
    conn.close()
    log(f"  数据库       : {db_path}（{db_path.stat().st_size / 1024 / 1024:.1f} MB）")


def typhoon_rows(pack: list[dict]) -> tuple[list[tuple], list[tuple]]:
    """把台风原始结构转换成 (typhoon 行, typhoon_path 行)。

    派生计算放在入库时一次算好（路径长度、极值强度、包围盒），
    避免前端每次渲染都遍历上千个路径点。建库与实时更新共用这段逻辑。
    """
    ty, pts = [], []
    for t in pack:
        path = t.get("path") or []
        if not path:
            continue
        winds = [p["wind_speed"] for p in path if isinstance(p.get("wind_speed"), (int, float))]
        press = [p["pressure"] for p in path if isinstance(p.get("pressure"), (int, float))]
        dist = sum(haversine((path[i]["lon"], path[i]["lat"]),
                             (path[i + 1]["lon"], path[i + 1]["lat"]))
                   for i in range(len(path) - 1))
        lons = [p["lon"] for p in path]
        lats = [p["lat"] for p in path]
        # 该台风生命史中的最强等级（TD < TS < STS < TY < STY < SuperTY）
        lv = max(path, key=lambda p: TY_RANK.get(p.get("level"), 0)).get("level")
        ty.append((t["code"], t.get("id"), t.get("num"), t.get("name_cn"), t.get("name_en"),
                   t.get("status"), t.get("active"),
                   path[0]["time"], path[-1]["time"], len(path),
                   max(winds) if winds else None, min(press) if press else None, round(dist),
                   lv, TY_RANK.get(lv, 0),
                   min(lons), max(lons), min(lats), max(lats)))
        for i, p in enumerate(path):
            pts.append((t["code"], i, p.get("ts"), p.get("time"), p.get("level"),
                        p.get("lon"), p.get("lat"), p.get("pressure"),
                        p.get("wind_speed"), p.get("wind_dir"), p.get("move_speed")))
    return ty, pts


def migrate(db_path: Path = DB_PATH) -> list[str]:
    """把老版本数据库原地升级到支持实时增量的结构（幂等）。

    返回本次实际执行的变更列表；数据库已是最新时返回空列表。
    这样用户手上的 meteo.db 不必重建（重建会丢掉已经积累的预警历史）。
    """
    if not Path(db_path).exists():
        return []
    changes: list[str] = []
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)                    # 建缺失的表（不动已有表）
        for table, cols in (
            ("alarm", [("ingested_at", "TEXT")]),
            ("observation", [("updated_at", "TEXT"), ("prev_temp", "REAL"),
                             ("prev_humidity", "REAL"), ("prev_rain", "REAL"),
                             ("prev_pressure", "REAL"), ("prev_ts", "TEXT"),
                             ("updates", "INT DEFAULT 0"), ("next_try_at", "TEXT"),
                             ("fail_count", "INT DEFAULT 0")]),
        ):
            have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            for name, typ in cols:
                if name not in have:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {typ}")
                    changes.append(f"{table}.{name}")
        # 历史行补默认值，避免前端拿到 NULL
        conn.execute("UPDATE observation SET updates = 0 WHERE updates IS NULL")
        conn.execute("UPDATE observation SET updated_at = collected_at "
                     "WHERE updated_at IS NULL AND collected_at IS NOT NULL")
        conn.execute("UPDATE alarm SET ingested_at = ts WHERE ingested_at IS NULL")
        # 时间串统一为空格分隔（早期快照用了 ISO 的 T 分隔，会让字符串比较失真）
        for col in ("collected_at", "updated_at", "prev_ts", "next_try_at"):
            conn.execute(f"UPDATE observation SET {col} = REPLACE({col}, 'T', ' ') "
                         f"WHERE {col} LIKE '%T%'")
        conn.execute("UPDATE alarm SET ingested_at = REPLACE(ingested_at, 'T', ' ') "
                     "WHERE ingested_at LIKE '%T%'")
        conn.executescript(LATE_INDEXES)
        conn.commit()
    finally:
        conn.close()
    return changes


def report(db_path: Path = DB_PATH) -> None:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = lambda s: conn.execute(s).fetchone()[0]
    log("\n---- 数据体检 ----")
    for label, sql in [
        ("区划总数", "SELECT COUNT(*) FROM region"),
        ("站点总数", "SELECT COUNT(*) FROM station"),
        ("站点无坐标", "SELECT COUNT(*) FROM station WHERE lng IS NULL"),
        ("实况有效温度", "SELECT COUNT(*) FROM observation WHERE temp IS NOT NULL"),
        ("预警总数", "SELECT COUNT(*) FROM alarm"),
        ("预警无坐标", "SELECT COUNT(*) FROM alarm WHERE lng IS NULL"),
        ("预警时间跨度", "SELECT MIN(ts)||'  ~  '||MAX(ts) FROM alarm"),
        ("台风数量", "SELECT COUNT(*) FROM typhoon"),
        ("台风路径点", "SELECT COUNT(*) FROM typhoon_path"),
        ("预报条目", "SELECT COUNT(*) FROM forecast"),
    ]:
        log(f"  {label:<12}: {q(sql)}")
    log("\n  灾种分布: " + ", ".join(
        f"{r[0]}={r[1]}" for r in conn.execute(
            "SELECT type, COUNT(*) c FROM alarm GROUP BY type ORDER BY c DESC")))
    log("  等级分布: " + ", ".join(
        f"{r[0]}={r[1]}" for r in conn.execute(
            "SELECT level, COUNT(*) c FROM alarm GROUP BY level ORDER BY c DESC")))
    conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--db", default=str(DB_PATH))
    a = ap.parse_args()
    log("=" * 60)
    log(" 构建 SQLite 数据库")
    log("=" * 60)
    build(Path(a.db))
    if a.stats:
        report(Path(a.db))
    return 0


if __name__ == "__main__":
    sys.exit(main())
