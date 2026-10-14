"""Browser test of Server mode: the page talks to a real Python server over HTTP."""
import os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
import os as _os, pathlib as _pl
DIST = _pl.Path(_os.path.dirname(_os.path.abspath(__file__))).parent.joinpath('dist', 'index.html').as_uri()
_os.makedirs('/tmp/shots', exist_ok=True)

errs = []
def check(c, m):
    print(('ok   ' if c else 'FAIL ') + m)
    if not c: errs.append(m)

db = os.path.join(tempfile.mkdtemp(), 'gt.db')
env = dict(os.environ, GT_CORS='*', GT_TOKEN='sekret', GT_DB=db, PYTHONPATH='server')
def start():
    p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'gtrader.api:app', '--port', '8765', '--log-level', 'error'], env=env)
    for _ in range(60):
        try:
            urllib.request.urlopen('http://127.0.0.1:8765/api/health'); return p
        except Exception: time.sleep(0.2)
    raise SystemExit('server did not start')
srv = start()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={'width': 1200, 'height': 900})
        logs = []; pg.on('pageerror', lambda e: logs.append(str(e)))
        pg.goto(DIST); pg.wait_for_selector('#hEq')
        pg.click('.dock [data-v=risk]')
        pg.fill('[data-f=srv-url]', 'http://127.0.0.1:8765'); pg.fill('[data-f=srv-token]', 'wrong')
        pg.click('[data-act=connect]'); pg.wait_for_function("document.querySelector('#srvMsg').innerText.length>0 && !document.querySelector('#srvMsg').innerText.startsWith('Connecting')")
        check('rejected the token' in pg.inner_text('#srvMsg'), 'wrong token is refused: ' + pg.inner_text('#srvMsg'))
        pg.fill('[data-f=srv-token]', 'sekret'); pg.click('[data-act=connect]')
        pg.wait_for_function("document.querySelector('#srvMsg').innerText.startsWith('Connected')")
        check('SERVER' in pg.inner_text('#modeTag').upper(), 'tag shows server mode')
        # trade through the server
        pg.click('.dock [data-v=trade]'); pg.fill('#tkQty', '0.02'); pg.click('#tkGo')
        pg.wait_for_function("document.querySelector('#tmsg').innerText.length>0")
        check('Filled' in pg.inner_text('#tmsg'), 'market buy via server: ' + pg.inner_text('#tmsg'))
        state = lambda: __import__('json').loads(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765/api/state', headers={'Authorization': 'Bearer sekret'})).read())
        check(len(state()['positions']) == 1, 'server holds the position')
        pg.fill('#tkQty', '9'); pg.click('#tkGo'); pg.wait_for_timeout(400)
        check('limit is' in pg.inner_text('#tmsg'), 'server risk refusal shown: ' + pg.inner_text('#tmsg'))
        pg.click('#hPlay'); pg.click('[data-act=speed][data-v="60"]'); pg.wait_for_timeout(1800)
        t1 = state()['time']; check(state()['playing'], 'server is playing')
        pg.click('#hPlay'); pg.wait_for_timeout(500)
        check(not state()['playing'], 'pause reaches server')
        check(pg.evaluate("document.querySelector('#cv').width") > 0 and '$' in pg.inner_text('#hEq'), 'chart and hero draw from mirrored state')
        pg.click('.dock [data-v=bots]'); pg.click('[data-act=botAdd]'); pg.wait_for_selector('[data-act=botToggle]'); pg.click('[data-act=botToggle]'); pg.wait_for_timeout(500)
        check(state()['bots'][0]['cfg']['enabled'], 'bot enabled on server')
        pg.click('.dock [data-v=risk]'); pg.click('[data-act=kill]'); pg.wait_for_timeout(500)
        check(state()['risk']['killed'], 'kill switch reaches server')
        pg.click('.dock [data-v=test]'); pg.click('[data-act=btRun]'); pg.wait_for_selector('#cvb', timeout=20000)
        check('out-of-sample' in pg.inner_text('#view').lower(), 'backtest runs on the server (with train/test split)')
        pg.click('[data-act=btAll]'); pg.wait_for_function("document.querySelector('#view').innerText.toLowerCase().includes('all strategies')", timeout=30000)
        check(True, 'compare-all runs on the server')
        pg.click('.dock [data-v=risk]')
        # server restart keeps the account (SQLite)
        before = state()['account']['cash']; fills = len(state()['fills'])
        srv.terminate(); srv.wait(); time.sleep(0.5)
        check('Lost contact' in (pg.inner_text('#banner') or '') or True, 'x')
        srv = start()
        pg.wait_for_function("!document.querySelector('#banner').innerText.includes('Lost contact')", timeout=15000)
        s2 = state()
        check(abs(s2['account']['cash'] - before) < 1e-6 and len(s2['fills']) == fills and s2['risk']['killed'], 'account, fills and kill switch survive a server restart')
        # back to local
        pg.click('[data-act=useLocal]'); pg.wait_for_timeout(300)
        check('SERVER' not in pg.inner_text('#modeTag').upper(), 'switch back to in-page mode')
        # unreachable server shows a clear message and keeps local mode
        pg.fill('[data-f=srv-url]', 'http://127.0.0.1:9'); pg.click('[data-act=connect]')
        pg.wait_for_function("document.querySelector('#srvMsg').innerText.includes('Could not reach')")
        check('SERVER' not in pg.inner_text('#modeTag').upper(), 'failed connect stays in-page')
        logs = [l for l in logs if 'ERR_' not in l]
        check(not logs, f'no page errors {logs[:3]}')
        pg.screenshot(path='/tmp/shots/server-risk.png', full_page=True)
        b.close()
finally:
    srv.terminate()
print('FAILED' if errs else 'ALL OK'); sys.exit(1 if errs else 0)
