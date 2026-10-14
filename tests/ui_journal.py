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
        ctx=b.new_context(viewport={'width':vp[0],'height':vp[1]},accept_downloads=True); pg=ctx.new_page(); logs=[]
        pg.on('pageerror',lambda e:logs.append(str(e)))
        pg.goto(DIST); pg.wait_for_selector('#hEq')
        pg.click('[data-act=otype][data-v=market]'); pg.fill('#tkQty','0.02'); pg.click('#tkGo'); pg.wait_for_timeout(300)
        pg.click('[data-act=sub][data-v=fills]'); pg.click('[data-act=jr]')
        pg.select_option('#jrTag','Breakout'); pg.fill('#jrNote','tested the journal'); pg.click('[data-act=jrSave]')
        pg.wait_for_timeout(300)
        check('Breakout' in pg.inner_text('#tbl'),f'{name}: tag shows in fills list')
        # sell it all
        pg.click('[data-act=sub][data-v=pos]'); pg.click('[data-act=sellAll]'); pg.wait_for_timeout(400)
        pg.click('.dock [data-v=stats]'); pg.wait_for_selector('#statsBody .tile'); pg.wait_for_timeout(300)
        t=pg.inner_text('#statsBody'); check('BY JOURNAL TAG' in t.upper() and 'BREAKOUT' in t.upper(),f'{name}: stats group by tag')
        with pg.expect_download() as d: pg.click('[data-act=exportFills]')
        csv=open(d.value.path()).read(); check('tag,note' in csv.splitlines()[0] and 'Breakout,tested the journal' in csv,f'{name}: CSV carries tag and note')
        # survives reload (local storage)
        pg.reload(); pg.wait_for_selector('#hEq'); pg.click('[data-act=sub][data-v=fills]'); pg.wait_for_timeout(300)
        check('Breakout' in pg.inner_text('#tbl'),f'{name}: journal survives reload')
        check(not logs,f'no page errors {logs[:2]}'); ctx.close()
    b.close()
print('FAILED' if errs else 'ALL OK')
