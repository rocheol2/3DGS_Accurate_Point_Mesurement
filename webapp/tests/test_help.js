const puppeteer = require('puppeteer-core'); const path = require('path');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--window-size=1200,900'] });
  const p = await b.newPage(); await p.setViewport({ width: 1200, height: 900 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:8765/help.html', { waitUntil: 'networkidle0' });
  const rows = await p.evaluate(() => document.querySelectorAll('#err-table tr').length - 1);
  console.log('help.html error-table rows:', rows, '| page errors:', errs.length ? errs : 'none');
  await p.screenshot({ path: path.join(__dirname, 'shots', '10_help.png'), fullPage: false });
  const r = await p.goto('http://127.0.0.1:8765/../index.html', { waitUntil: 'load' }).catch(() => null);
  await b.close();
})();
