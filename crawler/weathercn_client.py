# -*- coding: utf-8 -*-
"""
weathercn_client.py —— 中国天气网（www.weather.com.cn）预警信号补充源

【为什么需要它】
中国气象局 nmc.cn 的 /rest/findAlarm 全国预警流**不收录青海省**预警：
2026-09-17 ~ 10-02 连续 15 天，该流累计 4561 条预警、覆盖 28 个省级单位，
但 `adm_code` 前缀 `63`（青海）**一条都没有**；而同一时刻中国天气网在生效列表里
有 3 条果洛州（达日 / 班玛 / 久治）雷电黄色预警。
所以"青海看不见预警"既不是采集故障，也不是"青海没发预警"——
是**上游接口本身的覆盖缺口**，只能换一路源来补。

中国天气网由气象局公共气象服务中心运营，用的是**同一套国家预警信息发布中心的
alertid**（形如 `63262241600000_20261002102000`），因此两源可按 alertid
天然去重、直接合并入库，不需要额外的 id 体系映射。

【接口】
  GET https://forecast.weather.com.cn/api/v1/traffic/alarm/alarmMap
  返回 {"status":"success","result":{"count":"297","data":[
        [ "青海省果洛藏族自治州班玛县",                       # 0 地点全名
          "101150502-20261002102000-0902.html",              # 1 详情页文件名
          "100.74", "32.93",                                 # 2/3 经度 / 纬度
          "63262241600000_20261002102000",                   # 4 alertid（与 nmc 同体系）
          "63262241600000_20261002102000",                   # 5 alertid 副本
          "青海省果洛藏族自治州班玛县发布雷电黄色预警信号",      # 6 完整标题
          {"coordinates": [...]} ], ... ]}}
  一次返回全国全部生效预警，不需要分页（实测约 300 条）。

【合规】与 nmc_client 一致：公开数据、无需登录、低频快照、仅课程非商业用途。
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path

from curl_cffi import requests as creq

from nmc_client import DEFAULT_HEADERS, RateLimiter

ALARM_MAP = "https://forecast.weather.com.cn/api/v1/traffic/alarm/alarmMap"
SOURCE = "weathercn"          # alarm.source 取值；nmc 侧为 "nmc"


def _ca_bundle() -> str | None:
    """给 libcurl 一个**纯 ASCII 路径**的 CA 证书包，拿不到时返回 None。

    【为什么需要】本机项目根目录含中文（`...\\ChatGPT\\数据可视化\\...`），而
    libcurl 打开 CAfile 走的是 ANSI 路径 API —— 中文路径下直接失败：

        SSLError: Failed to perform, curl: (77) error adding trust anchors
                  from locations: CAfile: ...\\数据可视化\\...\\certifi\\cacert.pem

    后果是 HTTPS 源**静默不可用**（nmc 与台风都是 http:// 才躲过一劫），
    中国天气网补充源因此长期没取到数据 —— 青海等省一条预警都看不见。
    这里把 certifi 的证书包复制到系统临时目录（纯 ASCII）再指给 libcurl。
    """
    configured = os.environ.get("TIANSHU_CA_BUNDLE", "")
    if configured and configured.isascii() and Path(configured).is_file():
        return configured
    try:
        import certifi
        src = certifi.where()
        if not src or not Path(src).exists():
            return None
        if src.isascii():
            return src                       # 路径本来就干净，直接用
        # gettempdir() may fall back to the Chinese project directory when the
        # Windows temp directory is missing. Never pass that path to libcurl.
        for candidate in (os.environ.get("TEMP"), os.environ.get("TMP"),
                          tempfile.gettempdir()):
            if not candidate or not candidate.isascii():
                continue
            try:
                dst_dir = Path(candidate) / "tianshu-ca"
                dst_dir.mkdir(parents=True, exist_ok=True)
                dst = dst_dir / "cacert.pem"
                # 源文件更新过（certifi 升级）就重新拷一份，否则复用
                if not dst.exists() or dst.stat().st_size != os.path.getsize(src):
                    shutil.copyfile(src, dst)
                return str(dst)
            except OSError:
                continue
        return None
    except Exception:                        # noqa: BLE001
        return None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _issuetime(alertid: str) -> str:
    """alertid 尾部的 14 位 YYYYMMDDHHMMSS -> nmc 同款 'YYYY/MM/DD HH:MM'。

    必须与 nmc 的 issuetime 格式一致：落库侧只做 `.replace('/', '-')`，
    然后按 ts[:10] 取日期、ts[11:13] 取小时。格式不对会写出脏日期。
    """
    tail = (alertid or "").split("_")[-1]
    if len(tail) >= 12 and tail[:12].isdigit():
        return "%s/%s/%s %s:%s" % (tail[0:4], tail[4:6], tail[6:8],
                                   tail[8:10], tail[10:12])
    return ""


def parse_row(row) -> dict | None:
    """一行原始数组 -> 与 nmc 同形的 item（下游 parse_alarm / 落库逻辑直接复用）。"""
    if not isinstance(row, (list, tuple)) or len(row) < 7:
        return None
    aid = str(row[4] or row[5] or "").strip()
    if not aid:
        return None
    detail = str(row[1] or "").strip()
    return {
        "alertid": aid,
        "issuetime": _issuetime(aid),
        "title": str(row[6] or "").strip(),
        "url": ("http://www.weather.com.cn/alarm/newalarmcontent.shtml?file=" + detail)
               if detail else "",
        "pic": "",
        "source": SOURCE,
        # 接口自带区县质心，供 geo 表查不到时兜底（实测与 region 表基本重合）
        "lng": _num(row[2]),
        "lat": _num(row[3]),
    }


class WeatherCnClient:
    """中国天气网预警补充源（单请求返回全国生效列表）。"""

    def __init__(self, rate: float = 1.0, timeout: int = 25, retries: int = 3):
        self.limiter = RateLimiter(rate)
        self.timeout = timeout
        self.retries = retries
        self._session: creq.Session | None = None
        self._ca = _ca_bundle()     # 中文路径下的 CA 兜底，见 _ca_bundle 注释
        self.stat_ok = 0
        self.stat_fail = 0

    @property
    def session(self) -> creq.Session:
        if self._session is None:
            s = creq.Session(impersonate="chrome124")
            s.headers.update({
                "Accept": DEFAULT_HEADERS["Accept"],
                "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
                "Referer": "http://www.weather.com.cn/alarm/",
            })
            self._session = s
        return self._session

    def _reset_session(self) -> None:
        """403 多为连接级封禁，换连接而不是原地重试（与 nmc_client 同策略）。"""
        if self._session is not None:
            try:
                self._session.close()
            except Exception:            # noqa: BLE001
                pass
        self._session = None

    def alarms(self) -> list[dict]:
        """全国当前生效预警（已规范化）。失败抛异常，由调用方决定是否降级。"""
        last: Exception | None = None
        for attempt in range(self.retries):
            self.limiter.wait()
            try:
                kw = {"verify": self._ca} if self._ca else {}
                r = self.session.get(ALARM_MAP, timeout=self.timeout, **kw)
                if r.status_code in (403, 429):
                    self._reset_session()
                    last = RuntimeError("HTTP %s（被限流）" % r.status_code)
                    time.sleep(min(1.2 * (attempt + 1), 4.0))
                    continue
                if r.status_code != 200:
                    raise RuntimeError("HTTP %s" % r.status_code)
                data = ((r.json() or {}).get("result") or {}).get("data") or []
                out = [x for x in (parse_row(row) for row in data) if x]
                self.stat_ok += 1
                return out
            except Exception as e:       # noqa: BLE001
                last = e
                time.sleep(0.5 * (attempt + 1))
        self.stat_fail += 1
        raise last if last else RuntimeError("weathercn alarmMap 请求失败")
