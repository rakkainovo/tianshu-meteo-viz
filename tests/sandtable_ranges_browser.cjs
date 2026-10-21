const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.ALARM_URL || 'http://127.0.0.1:5000';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const anchor = Date.now();
  const timestamp = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const points = [0.01, 2, 6, 10, 20, 40].map((days, index) => ({
    id: 'range-' + index, ts: timestamp(anchor - days * 86400000),
    type: '大风', level: '黄色', level_rank: 2, lng: 118.8, lat: 32.1,
    province: index % 2 ? '浙江省' : '江苏省', city: index % 2 ? '杭州市' : '南京市',
    county: '', title: '历史范围验证 ' + index, issuer: '气象台'
  }));
  let history = points;
  await page.route('**/api/alarms/playback', route => route.fulfill({ json: { ok: true, points: history } }));
  await page.route('**/api/alarms?*', route => route.fulfill({ json: {
    ok: true, total: 1, records: [points[0]], active: { scan_at: timestamp(anchor), active_total: 1, stale: false }
  }}));
  const range = page.getByLabel('沙盘时间范围', { exact: true });
  const total = page.locator('.sand-kpis > div').first().locator('strong');
  async function count(expected) {
    await page.waitForFunction(value => document.querySelector('.sand-kpis strong')?.textContent.replace(/\D/g, '') === String(value), expected);
    assert.equal((await total.innerText()).replace(/\D/g, ''), String(expected));
  }
  try {
    await page.goto(base + '/?enter=1&static=1#/sandtable');
    await range.waitFor();
    await count(1);
    assert.equal(await range.inputValue(), 'today');
    // Verify a range in 3D before inspecting every selection in the shared 2D renderer.
    await range.selectOption('168');
    await count(3);
    await page.locator('.sand-timeline').waitFor();
    assert.match(await page.locator('.sand-live').innerText(), /最近 7 天.*累计发布/);
    await page.getByRole('button', { name: '2D', exact: true }).click();
    for (const [value, expected] of [['24', 1], ['72', 2], ['168', 3], ['360', 4], ['720', 5], ['all', 6]]) {
      await range.selectOption(value);
      await count(expected);
    }
    await range.selectOption('custom');
    await page.getByLabel('自定义历史天数').fill('5');
    await page.getByLabel('自定义历史天数').press('Tab');
    await count(2);
    assert.match(await page.locator('.sand-live').innerText(), /最近 5 天/);
    await page.getByLabel('自定义历史天数').fill('999');
    await page.getByLabel('自定义历史天数').press('Tab');
    assert.equal(await page.getByLabel('自定义历史天数').inputValue(), '365');
    await range.selectOption('168');
    await count(3);
    await page.getByRole('button', { name: /预警清单/ }).click();
    assert.equal(await page.locator('.sand-alert').count(), 3);
    // Seek to the start, then changing a range resets the view to its cumulative endpoint.
    await page.getByLabel('回放时间轴').fill('0');
    await count(0);
    await range.selectOption('72');
    await count(2);
    await page.getByRole('button', { name: '区域排序', exact: true }).click();
    await page.locator('.sand-rank').filter({ hasText: '江苏' }).click();
    await page.waitForFunction(() => document.querySelector('.sand-stage')?.getAttribute('aria-busy') === 'false');
    await count(1);
    await range.selectOption('168');
    await count(2);
    await page.getByRole('button', { name: '返回上一级', exact: true }).click();
    await count(3);
    await page.screenshot({ path: '.cache/sandtable-range-7days.png', fullPage: true });
    await range.selectOption('today');
    await count(1);
    await page.locator('.sand-timeline').waitFor({ state: 'detached' });
    // A stopped collector must not re-label records from 40 days ago as "recent 7 days".
    history = [points[5]];
    await page.reload();
    await range.waitFor();
    await count(1);
    await range.selectOption('168');
    await count(0);
    await range.selectOption('all');
    await count(1);
    assert.deepEqual(errors, []);
    console.log('PASS: preset/custom/all ranges, 3D/2D, drill, list, seek, reset to today, stale history.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
