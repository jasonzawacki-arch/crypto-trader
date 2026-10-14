import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
import os as _os, pathlib as _pl
DIST = _pl.Path(_os.path.dirname(_os.path.abspath(__file__))).parent.joinpath('dist', 'index.html').as_uri()
_os.makedirs('/tmp/shots', exist_ok=True)
errs = []
def check(c, m):
    print(('ok   ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
db = os.path.join(tempfile.mkdtemp(), 'gt.db')
env = dict(os.environ, GT_CORS='*', GT_DB=db, PYTHONPATH='server', GT_ADMIN_USER='root', GT_ADMIN_PASSWORD='admin-password-1')
p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'gtrader.api:app', '--port', '8767', '--log-level', 'error'], env=env)
base = 'http://127.0.0.1:8767'
for _ in range(60):
    try: urllib.request.urlopen(base + '/api/health'); break
    except Exception: time.sleep(0.2)
def api(method, path, body=None, tok=None):
    r = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + tok} if tok else {})})
    return json.loads(urllib.request.urlopen(r).read())
try:
    tok = api('POST', '/api/login', {'name': 'root', 'password': 'admin-password-1'})['token']
    api('POST', '/api/users', {'name': 'tina', 'password': 'trader-pass-1', 'role': 'trader'}, tok)
    api('POST', '/api/users', {'name': 'vic', 'password': 'viewer-pass-1', 'role': 'viewer'}, tok)
    with sync_playwright() as pw:
        b = pw.chromium.launch(); logs = []
        def session(user, pw_):
            pg = b.new_page(viewport={'width': 1200, 'height': 900}); pg.on('pageerror', lambda e: logs.append(str(e)))
            pg.goto(DIST); pg.wait_for_selector('#hEq'); pg.click('.dock [data-v=risk]')
            pg.fill('[data-f=srv-url]', base); pg.fill('[data-f=srv-user]', user); pg.fill('[data-f=srv-pass]', pw_); pg.click('[data-act=connect]')
            pg.wait_for_function("(()=>{const t=document.querySelector('#srvMsg').innerText;return t.length>0&&!t.startsWith('Connecting')})()")
            return pg
        pg = session('root', 'wrong-password')
        check('Wrong name or password' in pg.inner_text('#srvMsg'), 'wrong password refused: ' + pg.inner_text('#srvMsg'))
        pg.close()
        pg = session('root', 'admin-password-1')
        check('as root (admin)' in pg.inner_text('#srvMsg'), 'admin signed in: ' + pg.inner_text('#srvMsg'))
        pg.click('.dock [data-v=risk]'); pg.click('[data-act=audit]'); pg.wait_for_selector('text=/login/i >> nth=0'); pg.wait_for_timeout(500)
        t = pg.inner_text('body')
        check('tina' in t.lower() or 'users' in t.lower(), 'audit log lists activity')
        check('admin-password-1' not in t, 'no password in audit log')
        pg.close()
        pg = session('tina', 'trader-pass-1')
        check('(trader)' in pg.inner_text('#srvMsg'), 'trader signed in')
        pg.click('.dock [data-v=risk]'); check(pg.locator('[data-act=audit]').count() == 0, 'trader sees no audit log')
        pg.click('.dock [data-v=trade]'); pg.fill('#tkQty', '0.01'); pg.click('#tkGo'); pg.wait_for_function("document.querySelector('#tmsg').innerText.length>0")
        check('Filled' in pg.inner_text('#tmsg'), 'trader can trade')
        pg.close()
        pg = session('vic', 'viewer-pass-1')
        pg.click('.dock [data-v=trade]'); pg.fill('#tkQty', '0.01'); pg.click('#tkGo'); pg.wait_for_function("document.querySelector('#tmsg').innerText.length>0")
        check('viewer' in pg.inner_text('#tmsg') and 'cannot' in pg.inner_text('#tmsg'), 'viewer is refused: ' + pg.inner_text('#tmsg'))
        pg.screenshot(path='/tmp/shots/auth.png', full_page=True)
        check(not logs, f'no page errors {logs[:2]}')
        b.close()
finally:
    p.terminate()
print('FAILED' if errs else 'ALL OK')
