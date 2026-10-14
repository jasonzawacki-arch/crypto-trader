from playwright.sync_api import sync_playwright
import os as _os, pathlib as _pl
DIST = _pl.Path(_os.path.dirname(_os.path.abspath(__file__))).parent.joinpath('dist', 'index.html').as_uri()
_os.makedirs('/tmp/shots', exist_ok=True)
errs=[]
def check(c,m):
    print(('ok   ' if c else 'FAIL ')+m)
    if not c: errs.append(m)
with sync_playwright() as pw:
    b=pw.chromium.launch()
    for name,vp in (('desk',(1280,900)),('phone',(390,800))):
        pg=b.new_context(viewport={'width':vp[0],'height':vp[1]}).new_page(); logs=[]
        pg.on('pageerror',lambda e:logs.append(str(e)))
        pg.goto(DIST); pg.wait_for_selector('#hEq')
        pg.click('.dock [data-v=test]'); pg.click('[data-act=btSweep]'); pg.wait_for_selector('text=/stress test ·/i',timeout=60000)
        t=pg.inner_text('body').lower()
        check('profitable slices' in t and 'fees and spread x2' in t and 'slice 4 of 4' in t,f'{name}: stress test renders slices, settings and cost runs')
        check(pg.evaluate("document.documentElement.scrollWidth<=innerWidth"),f'{name}: no horizontal scroll')
        pg.screenshot(path=f'/tmp/shots/{name}-stress.png',full_page=True)
        check(not logs,f'no page errors {logs[:2]}')
    b.close()
print('FAILED' if errs else 'ALL OK')
