// Run against an offline test server: ALARM_URL=http://127.0.0.1:5190 node ...
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.ALARM_URL || 'http://127.0.0.1:5190';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const chartState = () => page.locator('.trend-head').evaluate(head => {
    const el = head.parentElement.querySelector('.chart');
    const option = window.echarts.getInstanceByDom(el)?.getOption();
    return option?.xAxis[0].data || [];
  });
  async function waitRange(range) {
    await page.waitForFunction(range => {
      const el = document.querySelector('.trend-head').parentElement.querySelector('.chart');
      const buckets = window.echarts.getInstanceByDom(el)?.getOption()?.xAxis[0].data || [];
      if (!buckets.length) return false;
      const limit = Date.now() - 15 * 86400000 - 3600000;
      return (Date.parse(buckets[0].replace(' ', 'T') + '+08:00') >= limit) === (range === '15d');
    }, range);
  }
  try {
    await page.goto(base + '/?enter=1&static=1#/overview');
    await page.getByLabel('时间演化展示范围').waitFor();
    assert.equal(await page.getByLabel('时间演化展示范围').inputValue(), '15d');
    await waitRange('15d');
    const recent = await chartState();
    const map = await page.locator('.map-wrap > .chart').evaluate(el => {
      const series = window.echarts.getInstanceByDom(el).getOption().series;
      return {
        names: series.map(s => s.name),
        times: series.flatMap(s => (s.data || []).filter(r => r.time).map(r => r.time))
      };
    });
    assert.ok(map.times.length > 0);
    assert.ok(map.times.every(t => t.startsWith(today)));
    assert.ok(map.names.every(name => !String(name || '').includes('已失效')));

    await page.getByLabel('时间演化展示范围').selectOption('all');
    await waitRange('all');
    const all = await chartState();
    assert.ok(all.length > recent.length);
    assert.match(await page.locator('.cal-chip').innerText(), /今日生效/);
    await page.locator('.trend-head .ph-zoom').click();
    await page.locator('.bigview .trend-range').waitFor();
    assert.equal(await page.locator('.bigview .trend-range').inputValue(), 'all');
    await page.locator('.bigview .trend-range').selectOption('15d');
    await waitRange('15d');
    assert.equal(await page.locator('.trend-head .trend-range').inputValue(), '15d');
    await page.locator('.bigview .chip').filter({ hasText: '近 3 天' }).click();
    await page.locator('.win-tag').first().waitFor();
    assert.deepEqual(await chartState(), recent);
    await page.locator('.bv-close').click();
    await page.locator('.bigview').waitFor({ state: 'detached' });
    await page.screenshot({ path: '.cache/alarm-period-overview.png', fullPage: true });

    await page.goto(base + '/?enter=1&static=1#/sandtable');
    await page.waitForFunction(() => document.querySelector('.sand-stage')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: /预警清单/ }).click();
    await page.locator('.sand-alert').first().waitFor();
    await page.locator('.sand-alert').first().click();
    assert.ok((await page.locator('.sand-detail time').innerText()).startsWith(today));
    const listTimes = await page.locator('.sand-alert time').allTextContents();
    assert.ok(listTimes.every(t => t.startsWith(today.slice(5))));
    await page.getByRole('button', { name: '2D', exact: true }).click();
    await page.screenshot({ path: '.cache/alarm-period-sandtable.png', fullPage: true });
    await page.getByRole('button', { name: '历史回放', exact: true }).click();
    await page.locator('.sand-timeline').waitFor();
    await page.getByRole('button', { name: '今日生效', exact: true }).click();
    await page.locator('.sand-timeline').waitFor({ state: 'detached' });

    // A region/day with no current warnings must stay empty, despite global historical KPIs.
    await page.route('**/api/alarms?*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('period') !== 'today') return route.continue();
      await route.fulfill({ json: {
        ok: true, total: 0, records: [], active: { scan_at: today + ' 08:00:00',
          active_total: 0, province_count: 0, city_count: 0, issuer_count: 0, severe: 0, stale: false }
      }});
    });
    await page.goto(base + '/?enter=1&static=1#/overview');
    await page.reload(); // Reset the application cache before applying the empty-day response.
    await page.locator('.map-empty').waitFor();
    await page.waitForFunction(() => document.querySelector('.k-value span')?.textContent === '0');
    assert.match(await page.locator('.map-empty').innerText(), /今日无生效预警/);
    assert.deepEqual(errors, []);
    console.log('PASS: today-only maps, 15-day/all-history switch, enlarged chart, brush, sandbox history, zero counts.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
