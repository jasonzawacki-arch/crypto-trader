import os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
import os as _os, pathlib as _pl
DIST = _pl.Path(_os.path.dirname(_os.path.abspath(__file__))).parent.joinpath('dist', 'index.html').as_uri()
_os.makedirs('/tmp/shots', exist_ok=True)
errs = []
def check(c, m):
    print(('ok   ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
down = os.path.join(tempfile.mkdtemp(), 'down')
env = dict(os.environ, GT_CORS='*', FAKE_DOWN=down)
p = subprocess.Popen([sys.executable, 'tests/live_fake_server.py'], env=env)
for _ in range(60):
    try: urllib.request.urlopen('http://127.0.0.1:8766/api/health'); break
    except Exception: time.sleep(0.2)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={'width': 1200, 'height': 900}); logs = []
        pg.on('pageerror', lambda e: logs.append(str(e)))
        pg.goto(DIST); pg.wait_for_selector('#hEq')
        pg.click('.dock [data-v=risk]')
        check(pg.locator('[data-f=mode] option[value=live]').count() == 0, 'live option hidden in local mode')
        pg.fill('[data-f=srv-url]', 'http://127.0.0.1:8766'); pg.click('[data-act=connect]')
        pg.wait_for_function("document.querySelector('#srvMsg').innerText.startsWith('Connected')")
        pg.select_option('[data-f=mode]', 'live'); pg.wait_for_function("document.querySelector('#modeTag').innerText.toLowerCase().includes('live prices')")
        check(pg.is_hidden('#hSpeed'), 'speed controls hidden in live mode')
        pg.click('#hPlay'); pg.wait_for_timeout(1500)
        pg.click('.dock [data-v=risk]'); pg.wait_for_selector('#liveCard table')
        check('BTC-USD' in pg.inner_text('#liveCard'), 'live card lists quotes')
        pg.click('.dock [data-v=trade]'); pg.fill('#tkQty', '0.01'); pg.click('#tkGo'); pg.wait_for_function("document.querySelector('#tmsg').innerText.length>0")
        check('Filled' in pg.inner_text('#tmsg'), 'paper buy on live price: ' + pg.inner_text('#tmsg'))
        pg.click('.dock [data-v=risk]'); pg.click('[data-act=calib]'); pg.wait_for_selector('#liveCard .tiles')
        check('LIVE HALF-SPREAD' in pg.inner_text('#liveCard').upper() and '5.0 bps' in pg.inner_text('#liveCard'), 'comparison shows live half-spread')
        # outage -> stale alarm
        open(down, 'w').close(); pg.wait_for_function("document.querySelector('#banner').innerText.toLowerCase().includes('stale')", timeout=15000)
        check('buys are paused' in pg.inner_text('#banner').lower(), 'stale banner: ' + pg.inner_text('#banner')[:90])
        pg.click('.dock [data-v=trade]'); pg.fill('#tkQty', '0.01'); pg.click('#tkGo'); pg.wait_for_timeout(600)
        check('stale' in pg.inner_text('#tmsg').lower(), 'buy refused while stale: ' + pg.inner_text('#tmsg')[:80])
        os.remove(down); pg.wait_for_function("!document.querySelector('#banner').innerText.toLowerCase().includes('stale')", timeout=15000)
        check(True, 'banner clears when quotes resume')
        pg.screenshot(path='/tmp/shots/live.png', full_page=True)
        check(not logs, f'no page errors {logs[:2]}')
        b.close()
finally:
    p.terminate()
print('FAILED' if errs else 'ALL OK')
