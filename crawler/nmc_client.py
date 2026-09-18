# -*- coding: utf-8 -*-
"""
nmc_client.py —— 中国气象局公开数据接口采集客户端

【数据来源】中国气象局 www.nmc.cn 的公开 REST 接口（网页前端自身调用的接口）。
【合规说明】
  - 全部为公开发布、无需登录的数据，不含个人隐私。
  - 采集频率受 RateLimiter 限制（默认 6 请求/秒），只做低频快照，不对服务器造成压力。
  - 仅用于课程作业的非商业研究用途。

【为什么用 curl_cffi 而不是 requests】
  nmc.cn 前端带反爬校验，普通 requests 的 TLS 指纹会被识别。
  curl_cffi 会模拟真实 Chrome 浏览器的 TLS/HTTP2 指纹，属于"正常浏览器访问"。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from curl_cffi import requests as creq

BASE = "http://www.nmc.cn"
HOME = "http://www.nmc.cn/"

# 全局默认请求头
DEFAULT_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": HOME,
}


class RateLimiter:
    """简单令牌桶限速器，保证全局请求速率不超过 rate 次/秒。"""

    def __init__(self, rate: float = 6.0):
        self.min_interval = 1.0 / rate
        self._lock = threading.Lock()
        self._next_time = time.monotonic()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            if now < self._next_time:
                sleep_for = self._next_time - now
            else:
                sleep_for = 0.0
            self._next_time = max(now, self._next_time) + self.min_interval
        if sleep_for > 0:
            time.sleep(sleep_for)


class NmcClient:
    """中国气象局数据采集客户端（线程安全：每个线程独立 Session）。"""

    def __init__(self, rate: float = 6.0, timeout: int = 25, retries: int = 3):
        self.limiter = RateLimiter(rate)
        self.timeout = timeout
        self.retries = retries
        self._local = threading.local()
        self.stat_ok = 0
        self.stat_fail = 0
        self._lock = threading.Lock()

    # ---------- 内部 ----------
    @property
    def session(self) -> creq.Session:
        """每线程一个 Session，避免跨线程复用连接池。"""
        s = getattr(self._local, "session", None)
        if s is None:
            s = creq.Session(impersonate="chrome124")
            s.headers.update(DEFAULT_HEADERS)
            self._local.session = s
        return s

    def _bump(self, ok: bool) -> None:
        with self._lock:
            if ok:
                self.stat_ok += 1
            else:
                self.stat_fail += 1

    def get_json(self, path: str, params: dict | None = None) -> Any:
        """GET 一个接口并返回解析后的 JSON，带限速 + 重试。"""
        url = path if path.startswith("http") else BASE + path
        last_err: Exception | None = None
        for attempt in range(self.retries):
            self.limiter.wait()
            try:
                r = self.session.get(url, params=params, timeout=self.timeout)
                if r.status_code != 200:
                    raise RuntimeError("HTTP %s" % r.status_code)
                data = r.json()
                self._bump(True)
                return data
            except Exception as e:          # noqa: BLE001
                last_err = e
                time.sleep(0.5 * (attempt + 1))   # 退避
        self._bump(False)
        raise RuntimeError("请求失败 %s: %s" % (url, last_err))

    # ---------- 业务接口 ----------
    def provinces(self) -> list[dict]:
        """全国省级单位列表（34 个：23省 + 5自治区 + 4直辖市 + 2特别行政区）。"""
        return self.get_json("/rest/province/all")

    def cities(self, province_code: str) -> list[dict]:
        """某省下辖的所有气象站点（含站名与站点编码）。"""
        return self.get_json("/rest/province/%s" % province_code)

    def weather(self, station_code: str) -> dict:
        """
        站点实况 + 预报。返回结构：
          real        —— 实况（温度/体感/气压/湿度/降水/天气现象/舒适度）
          predict     —— 7 天预报（昼/夜天气、温度、风向风力、降水量）
          tempchart   —— 逐小时气温曲线
          passedchart —— 过去 24 小时实况曲线
          climate     —— 气候背景
          air         —— 空气质量
          radar       —— 雷达回波
        """
        return self.get_json("/rest/weather", {"stationid": station_code})

    def alarms(self, page_no: int = 1, page_size: int = 200,
               signal_type: str = "", signal_level: str = "",
               province: str = "") -> dict:
        """全国气象预警信号（分页）。"""
        return self.get_json("/rest/findAlarm", {
            "pageNo": page_no, "pageSize": page_size,
            "signaltype": signal_type, "signallevel": signal_level,
            "province": province,
        })

    def alarm_total_pages(self, page_size: int = 200) -> int:
        j = self.alarms(1, page_size)
        return int((j.get("data") or {}).get("page", {}).get("totalPage") or 1)

    def station_alarm(self, station_code: str) -> dict:
        """某站点当前生效的预警。"""
        return self.get_json("/rest/findAlarmByStation", {"stationid": station_code})


# --------------------------------------------------------------------------
#  中央气象台台风数据（另一个域名，单独封装）
# --------------------------------------------------------------------------
TYPHOON_BASE = "http://typhoon.nmc.cn/weatherservice/typhoon/jsons"


class TyphoonClient:
    """中央气象台台风路径数据。"""

    def __init__(self, rate: float = 4.0, timeout: int = 25):
        self.limiter = RateLimiter(rate)
        self.timeout = timeout
        self._local = threading.local()

    @property
    def session(self) -> creq.Session:
        s = getattr(self._local, "session", None)
        if s is None:
            s = creq.Session(impersonate="chrome124")
            s.headers.update({"Referer": "http://typhoon.nmc.cn/web.html"})
            self._local.session = s
        return s

    @staticmethod
    def _unwrap(text: str) -> Any:
        """剥掉 JSONP 外层 `cb(( ... ))`。"""
        a = text.find("((")
        if a >= 0:
            return json.loads(text[a + 2:text.rfind("))")])
        a = text.find("(")
        return json.loads(text[a + 1:text.rfind(")")])

    def _get(self, path: str) -> Any:
        self.limiter.wait()
        url = "%s/%s?_=%d" % (TYPHOON_BASE, path, int(time.time() * 1000))
        r = self.session.get(url, timeout=self.timeout)
        r.raise_for_status()
        return self._unwrap(r.text)

    def list_default(self) -> list[list]:
        """台风列表：[id, 中文名, 英文名, 编号, 编号, 数字编号, 是否活跃, 状态]"""
        return self._get("list_default").get("typhoonList", [])

    def view(self, typhoon_id: str | int) -> dict:
        """单个台风的完整路径与强度序列。"""
        return self._get("view_%s" % typhoon_id)


# --------------------------------------------------------------------------
#  工具
# --------------------------------------------------------------------------
def save_json(obj: Any, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    return p


def parallel_map(fn, items: Iterable, workers: int = 5, desc: str = "") -> tuple[list, list]:
    """带进度的并发 map。返回 (成功结果列表, 失败项列表)。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    items = list(items)
    ok, bad = [], []
    done = 0
    total = len(items)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for f in as_completed(futs):
            item = futs[f]
            done += 1
            try:
                ok.append(f.result())
            except Exception as e:              # noqa: BLE001
                bad.append((item, str(e)))
            if desc and (done % 50 == 0 or done == total):
                el = time.time() - t0
                print("  [%s] %d/%d  成功=%d 失败=%d  用时%.1fs%s"
                      % (desc, done, total, len(ok), len(bad), el,
                         "  预计剩余%.0fs" % (el / done * (total - done)) if done else ""),
                      flush=True)
    return ok, bad
