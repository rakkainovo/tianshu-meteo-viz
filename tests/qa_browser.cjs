const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.QA_BROWSER || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = process.env.QA_URL || 'http://127.0.0.1:5188';
  const url = base + '/?enter=1&static=1#/qa';
  const input = page.getByRole('textbox', { name: '气象问题' });
  const answer = () => page.locator('.qa-msg:not(.me) .qa-bubble').last();
  async function ask(text) {
    await input.fill(text);
    const response = page.waitForResponse(r => r.url().endsWith('/api/qa') && r.request().method() === 'POST');
    await input.press('Enter');
    const payload = await (await response).json();
    assert.equal(payload.ok, true);
    assert.notEqual(payload.intent, 'error', payload.answer);
    await page.getByRole('button', { name: '提问', exact: true }).waitFor();
    return payload;
  }
  try {
    await page.goto(url);
    await input.waitFor();
    await page.getByRole('button', { name: '开始新对话' }).click();
    const first = await ask('rRKjq站现在气温多少？');
    assert.equal(first.focus.params.code, 'rRKjq');
    assert.match(await answer().innerText(), /沙坪坝/);
    assert.doesNotMatch(await answer().innerText(), /温县/);
    const second = await ask('它明天呢？');
    assert.equal(second.intent, 'station_forecast');
    assert.equal(second.context.scopes[0].code, 'rRKjq');
    fs.mkdirSync('.cache', { recursive: true });
    await page.screenshot({ path: '.cache/qa-desktop.png', fullPage: true });
    await page.reload();
    await input.waitFor();
    assert.match(await answer().innerText(), /逐日预报/);
    await page.getByRole('button', { name: '查看站点详情' }).last().click();
    await page.waitForURL(/#\/station\?code=rRKjq/);
    await page.goto(url);
    await input.waitFor();
    const ambiguous = await ask('朝阳站现在湿度多少？');
    assert.equal(ambiguous.intent, 'clarify');
    const choiceResponse = page.waitForResponse(r => r.url().endsWith('/api/qa') && r.request().method() === 'POST');
    await answer().getByRole('button', { name: /北京市.*朝阳站/ }).click();
    const chosen = await (await choiceResponse).json();
    assert.equal(chosen.context.scopes[0].province, '北京市');
    await page.getByRole('button', { name: '提问', exact: true }).waitFor();
    await page.getByRole('button', { name: '开始新对话' }).click();
    const comparison = await ask('北京和上海哪个更热？');
    assert.equal(comparison.intent, 'station_compare');
    await page.locator('.qa-chart canvas').first().waitFor();
    const pixels = await page.locator('.qa-chart canvas').first().evaluate(canvas => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
      return painted;
    });
    assert.ok(pixels > 500, 'Comparison chart must contain rendered pixels');
    await page.screenshot({ path: '.cache/qa-comparison.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await input.waitFor();
    await page.getByRole('button', { name: '开始新对话' }).click();
    await ask('沙坪坝站明天天气怎么样？');
    await input.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page must not overflow horizontally');
    const bounds = await input.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, 'Input must fit the mobile viewport');
    await page.screenshot({ path: '.cache/qa-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ desktop: 'passed', mobile: 'passed', stationSelection: 'passed', conversation: 'passed', stationNavigation: 'passed', chartPixels: pixels, browserErrors: errors }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
