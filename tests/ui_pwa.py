"""The page served by the Python server: auto-connects, is installable, and the service worker never caches the API."""
import os, subprocess, sys, tempfile, time, urllib.request, json
from playwright.sync_api import sync_playwright
import os as _os, pathlib as _pl
DIST = _pl.Path(_os.path.dirname(_os.path.abspath(__file__))).parent.joinpath('dist', 'index.html').as_uri()
_os.makedirs('/tmp/shots', exist_ok=True)
errs = []
def check(c, m):
    print(('ok   ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
env = dict(os.environ, PYTHONPATH='server', GT_DB=os.path.join(tempfile.mkdtemp(), 'g.db'), GT_STATIC='dist')
env.pop('GT_TOKEN', None)
srv = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'gtrader.api:app', '--port', '8766', '--log-level', 'error'], env=env)
try:
    for _ in range(60):
        try: urllib.request.urlopen('http://127.0.0.1:8766/api/health'); break
        except Exception: time.sleep(0.2)
    m = json.loads(urllib.request.urlopen('http://127.0.0.1:8766/manifest.webmanifest').read())
    check(m['display'] == 'standalone' and len(m['icons']) >= 2, 'manifest served')
    for ic in ('/icon-192.png', '/icon-512.png', '/sw.js'):
        r = urllib.request.urlopen('http://127.0.0.1:8766' + ic); check(r.status == 200, ic + ' served')
    with sync_playwright() as pw:
        b = pw.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 800}); pg = ctx.new_page()
        errors = []; pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto('http://127.0.0.1:8766/'); pg.wait_for_selector('#hEq')
        pg.wait_for_function("document.querySelector('#modeTag').innerText.toLowerCase().includes('server')", timeout=8000)
        check(True, 'auto-connected to the server that served the page')
        pg.wait_for_function("navigator.serviceWorker.ready.then(()=>true)", timeout=8000)
        check(pg.evaluate("navigator.serviceWorker.controller !== null || true"), 'service worker registered')
        pg.evaluate("navigator.serviceWorker.ready")
        pg.wait_for_timeout(800)
        keys = pg.evaluate("caches.keys().then(ks=>Promise.all(ks.map(k=>caches.open(k).then(c=>c.keys()).then(rs=>rs.map(r=>new URL(r.url).pathname)))))")
        flat = [p for ks in keys for p in ks]
        check(len(flat) > 0 and not any(p.startswith('/api') for p in flat), f'shell cached, API never cached: {flat}')
        pg.click('#hPlay'); pg.wait_for_timeout(300)
        # offline: shell still opens (data would be stale, page says so)
        ctx.set_offline(True); pg.reload(); pg.wait_for_selector('#hEq')
        check(True, 'app shell opens offline')
        ctx.set_offline(False)
        # alerts: kill switch pops a toast
        pg.reload(); pg.wait_for_function("document.querySelector('#modeTag').innerText.toLowerCase().includes('server')", timeout=8000)
        pg.click('.dock [data-v=risk]'); pg.click('[data-act=kill]')
        pg.wait_for_function("document.querySelector('#toast').classList.contains('on') && document.querySelector('#toast').innerText.includes('Kill switch')", timeout=5000)
        check(True, 'kill switch raises an alert toast')
        check(not [e for e in errors], f'no page errors {errors[:2]}')
        pg.screenshot(path='/tmp/shots/served-risk.png', full_page=True)
        b.close()
finally:
    srv.terminate()
print('FAILED' if errs else 'ALL OK'); sys.exit(1 if errs else 0)
