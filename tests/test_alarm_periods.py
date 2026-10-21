"""Regression coverage for current displays and retained warning history (offline)."""
import datetime as dt
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
import app
import db


class Clock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        china = dt.timezone(dt.timedelta(hours=8))
        value = cls(2026, 10, 16, 12, 0, tzinfo=china)
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)


class AlarmPeriods(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.cache')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'alarms.db'
        self.conn = db.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.executescript(db.SCHEMA)
        self.conn.executemany('INSERT INTO alarm_level VALUES (?,?,?)',
                             [('蓝色', '#00f', 1), ('黄色', '#ff0', 2),
                              ('橙色', '#f80', 3), ('红色', '#f00', 4)])
        self.conn.executemany('INSERT INTO alarm '
                              '(id,ts,type,level,level_rank,province,city,last_seen_at) '
                              'VALUES (?,?,?,?,?,?,?,?)', [
            (key, ts, '大风', level, rank, province, province + '城市', seen)
            for key, ts, level, rank, province, seen in [
                ('midnight', '2026-10-16 00:00', '蓝色', 1, '江苏省', '2026-10-16 12:00:00'),
                ('today', '2026-10-16 08:00', '红色', 4, '江苏省', '2026-10-16 12:00:00'),
                ('yesterday', '2026-10-15 23:59', '橙色', 3, '浙江省', '2026-10-16 12:00:00'),
                ('days_old', '2026-10-13 08:00', '黄色', 2, '浙江省', '2026-10-16 12:00:00'),
                ('revoked', '2026-10-16 07:00', '黄色', 2, '江苏省', '2026-10-16 11:00:00'),
                ('edge', '2026-10-01 12:00', '蓝色', 1, '江苏省', '2026-10-01 12:00:00'),
                ('before', '2026-10-01 11:59', '蓝色', 1, '江苏省', '2026-10-01 12:00:00'),
                ('old', '2026-09-17 10:00', '蓝色', 1, '江苏省', '2026-09-17 10:00:00'),
                ('future', '2026-10-16 13:00', '蓝色', 1, '浙江省', '2026-10-16 12:00:00'),
            ]])
        self.conn.commit()
        for target, value in [('app.DB_PATH', self.path), ('app.datetime.datetime', Clock)]:
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = app.app.test_client()

    def get(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_today_requires_current_scan_and_china_calendar_day(self):
        result = self.get('/api/alarms?active=1&period=today')
        self.assertEqual({r['id'] for r in result['records']}, {'today', 'midnight'})
        self.assertEqual(result['total'], 2)
        self.assertEqual(result['active']['active_total'], 2)
        self.assertEqual(result['active']['severe'], 1)
        self.assertEqual(result['active']['province_count'], 1)
        for dim in ('province', 'city', 'level', 'type'):
            stats = self.get('/api/alarms/agg?active=1&period=today&dim=' + dim)
            self.assertEqual(sum(r['count'] for r in stats['data']), 2)
        self.assertEqual(self.get('/api/alarms?active=1&period=today&province=浙江省')['total'], 0)
        self.assertEqual(self.get('/api/alarms?active=1')['total'], 5)

    def test_zero_today_does_not_reuse_historical_counts(self):
        self.conn.execute("UPDATE alarm SET ts='2026-10-15 08:00'")
        self.conn.commit()
        result = self.get('/api/alarms?active=1&period=today')
        self.assertEqual(result['records'], [])
        for key in ('active_total', 'province_count', 'city_count', 'issuer_count', 'severe'):
            self.assertEqual(result['active'][key], 0)

    def test_recent_series_and_all_history_in_both_dimensions(self):
        for dim in ('level', 'province'):
            recent = self.get('/api/alarms/series?period=15d&dim=' + dim)
            full = self.get('/api/alarms/series?dim=' + dim)
            self.assertEqual(recent['buckets'][0], '2026-10-01 12:00')
            self.assertEqual(full['buckets'][0], '2026-09-17 10:00')
            count = lambda data: sum(v or 0 for s in data['series'] for v in s['data'])
            self.assertEqual(count(recent), 6)  # Includes withdrawn warnings in history.
            self.assertEqual(count(full), 9)
        self.assertEqual(self.get('/api/alarms')['total'], 9)
        self.assertEqual(len(self.get('/api/alarms/playback')['points']), 9)


if __name__ == '__main__':
    unittest.main()
