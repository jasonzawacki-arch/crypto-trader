import sys, os
from playwright.sync_api import sync_playwright
import os as _os, pathlib as _pl
DIST = _pl.Path(_os.path.dirname(_os.path.abspath(__file__))).parent.joinpath('dist', 'index.html').as_uri()
_os.makedirs('/tmp/shots', exist_ok=True)
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/shots'
os.makedirs(OUT, exist_ok=True)
errs = []
def check(c, m):
    print(('ok   ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, vp, scheme in [('desk-dark', (1280, 900), 'dark'), ('phone-light', (390, 800), 'light')]:
        ctx = b.new_context(viewport={'width': vp[0], 'height': vp[1]}, color_scheme=scheme)
        pg = ctx.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: logs.append(str(e)))
        pg.goto(DIST)
        pg.wait_for_selector('#hEq')
        check('$10,000.00' in pg.inner_text('#hEq'), f'{name}: starts at $10,000')
        pg.click('#hPlay'); pg.click('[data-act=speed][data-v="60"]'); pg.wait_for_timeout(1500); pg.click('#hPlay')
        check(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name}: no horizontal scroll')
        # market buy
        pg.click('[data-act=chip][data-v="10"]') if False else None
        pg.fill('#tkQty', '0.02'); pg.click('#tkGo'); pg.wait_for_timeout(200)
        t = pg.inner_text('#tmsg'); print('   msg:', t)
        check('Filled' in t, f'{name}: market buy fills')
        pg.screenshot(path=f'{OUT}/{name}-trade.png', full_page=True)
        pg.click('#mSym [data-v=ETH-USD]'); pg.fill('#tkQty', '0.3'); pg.click('#tkGo'); pg.wait_for_timeout(200)
        check('Filled 0.3 ETH' in pg.inner_text('#tmsg'), f'{name}: ETH tradable before playing')
        pg.click('#mSym [data-v=BTC-USD]')
        pg.click('[data-act=sub][data-v=fills]'); check('Buy' in pg.inner_text('#tbl'), f'{name}: fill listed')
        pg.click('[data-act=sub][data-v=pos]'); [pg.click('[data-act=sellAll]') for _ in range(2)]; pg.wait_for_function("document.querySelector('#tbl').innerText.includes('No open positions')", timeout=3000)
        check('No open positions' in pg.inner_text('#tbl'), f'{name}: sell all closes position')
        # bots
        pg.click('.dock [data-v=bots]'); pg.click('[data-act=botAdd]'); pg.click('[data-act=botToggle]')
        check('Running' in pg.inner_text('.pill'), f'{name}: bot runs')
        pg.screenshot(path=f'{OUT}/{name}-bots.png', full_page=True)
        pg.click('[data-act=botTest]'); pg.wait_for_selector('#cvb')
        check('out-of-sample' in pg.inner_text('#view').lower(), f'{name}: backtest from bot')
        pg.click('[data-act=btAll]'); check('Buy & hold' in pg.inner_text('#view'), f'{name}: compare table')
        pg.evaluate('window.scrollTo(0,0)')
        pg.screenshot(path=f'{OUT}/{name}-test.png', full_page=True)
        pg.click('.dock [data-v=risk]'); pg.click('[data-act=kill]')
        try:  # the screen redraws after the state is saved, which can take a moment
            pg.wait_for_function("document.querySelector('#killState').innerText.includes('Kill switch is ON')", timeout=5000)
        except Exception:
            pass
        check('Kill switch is ON' in pg.inner_text('#killState'), f'{name}: kill switch')
        pg.click('.dock [data-v=bots]'); pg.wait_for_timeout(300)
        check('Running' not in pg.inner_text('#view'), f'{name}: kill switch stopped the bots')
        pg.click('.dock [data-v=risk]')
        pg.screenshot(path=f'{OUT}/{name}-risk.png', full_page=True)
        check(pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{name}: risk no horizontal scroll')
        # persistence
        pg.reload(); pg.wait_for_selector('#hEq')
        check(pg.evaluate("window.__gt.S.ex.fills.length") >= 2, f'{name}: state restored after reload')
        logs = [l for l in logs if 'ERR_TUNNEL' not in l]; check(not logs, f'{name}: no console errors {logs[:3]}')
        ctx.close()
    b.close()
print('FAILED' if errs else 'ALL OK')
sys.exit(1 if errs else 0)
