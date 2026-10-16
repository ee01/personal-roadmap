const { chromium } = require('/Users/Esone/.npm/_npx/705bc6b22212b352/node_modules/playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type()==='error' && errs.push(m.text()));
  await p.goto('file://' + process.argv[2]); await p.waitForTimeout(800);
  await p.screenshot({ path: '.shots/1-default.png' });
  await p.click('#blSyncBtn'); await p.waitForTimeout(400);
  await p.screenshot({ path: '.shots/2-sync-pop.png' });
  // tick next quarter -> pending
  const chips = await p.$$('#chips .chip'); await chips[chips.length-1].click(); await p.waitForTimeout(300);
  await p.screenshot({ path: '.shots/3-pending.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.click('#msTrigger'); await p.waitForTimeout(400);
  await p.screenshot({ path: '.shots/4-ms.png' });
  console.log(JSON.stringify(errs));
  await b.close();
})();
