"""Exercise the production batch writer and history triggers on a disk database."""
import datetime as dt
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
import db
import live
from weathercn_client import _ca_bundle


class LiveStorage(unittest.TestCase):
    def test_certificate_uses_ascii_temp_when_default_falls_back_to_chinese_path(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache') as directory:
            ascii_temp = os.environ.get('TEMP') or tempfile.gettempdir()
            if not ascii_temp.isascii():
                self.skipTest('An ASCII temporary directory is needed for libcurl')
            root = Path(directory)
            source = root / '中文路径' / 'cacert.pem'
            source.parent.mkdir()
            source.write_bytes(b'certificate bundle fixture')
            missing_temp = Path(ascii_temp) / 'tianshu-ca' / ('test-' + uuid.uuid4().hex)
            # Isolate system temp-directory permissions; check the exact path
            # selected for libcurl and the source bundle copied into it.
            with patch('certifi.where', return_value=str(source)), \
                    patch('weathercn_client.tempfile.gettempdir', return_value=str(source.parent)), \
                    patch.dict(os.environ, {'TIANSHU_CA_BUNDLE': '', 'TEMP': str(missing_temp), 'TMP': ''}), \
                    patch.object(Path, 'mkdir'), \
                    patch('weathercn_client.shutil.copyfile') as copy:
                bundle = _ca_bundle()
            self.assertIsNotNone(bundle)
            self.assertTrue(bundle.isascii())
            copy.assert_called_once_with(str(source), Path(bundle))

    def test_batch_and_ondemand_persist_observations_forecasts_and_history(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.cache') as directory:
            path = Path(directory) / 'meteo.db'
            conn = db.connect(path)
            conn.executescript(db.SCHEMA)
            conn.executemany('INSERT INTO station(code,province,city) VALUES (?,?,?)',
                             [(str(i), '重庆市', str(i)) for i in range(320)])
            conn.commit()
            conn.close()
            db.migrate(path)
            engine = live.LiveEngine(db_path=path, enabled=False)
            published = dt.datetime.now().replace(second=0, microsecond=0)
            forecast_day = (published.date() + dt.timedelta(days=1)).isoformat()

            def payload(code):
                return {'data': {
                    'real': {'publish_time': published.isoformat(' '),
                             'weather': {'temperature': 23, 'humidity': 70, 'rain': 0}},
                    'predict': {'detail': [{'date': forecast_day,
                                            'day': {'weather': {'temperature': 25, 'info': '晴'}},
                                            'night': {'weather': {'temperature': 18, 'info': '晴'}}}]},
                }}

            with patch.object(engine.nmc, 'weather', side_effect=payload):
                result = engine.run_job('weather')
            self.assertNotIn('error', result)
            self.assertEqual(result['new'], 320)
            self.assertEqual(engine.status()['freshness']['coverage'], 1)

            # A later on-demand observation adds a real frame, then polling the
            # same published frame again updates it without duplicating history.
            published += dt.timedelta(minutes=1)
            with patch.object(engine.nmc_ondemand, 'weather', side_effect=payload):
                self.assertTrue(engine.refresh_station('0', force=True)['refreshed'])
                self.assertTrue(engine.refresh_station('0', force=True)['refreshed'])
            conn = db.connect(path)
            try:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM observation').fetchone()[0], 320)
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM forecast').fetchone()[0], 320)
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM observation_history').fetchone()[0], 321)
                self.assertEqual(conn.execute("SELECT updates FROM observation WHERE code='0'").fetchone()[0], 3)
                self.assertEqual(conn.execute('PRAGMA quick_check').fetchone()[0], 'ok')
            finally:
                conn.close()


if __name__ == '__main__':
    unittest.main()
