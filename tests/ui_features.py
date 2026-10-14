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
        # chart tap sets a limit price below market -> buy
        pg.wait_for_function('!!window.__gt.ui.geom'); box=pg.locator('#cv').bounding_box(); pg.locator('#cv').click(position={'x':box['width']*0.5,'y':box['height']*0.7})
        pg.wait_for_selector('#tkPrice')
        px=float(pg.input_value('#tkPrice')); mark=pg.evaluate("window.__gt.S.ex.mark('BTC-USD')")
        check(px<mark and pg.evaluate("window.__gt.ui.tk.type")=='limit' and pg.evaluate("window.__gt.ui.tk.side")=='buy', f'{name}: tapping below price sets a buy limit ({px} < {mark})')
        # bracket market buy
        pg.click('[data-act=otype][data-v=market]'); pg.fill('#tkQty','0.02'); pg.fill('#tkSl','4'); pg.fill('#tkTp','8'); pg.click('#tkGo'); pg.wait_for_timeout(300)
        check('Filled' in pg.inner_text('#tmsg'),'bracket buy fills')
        pg.click('[data-act=sub][data-v=ord]'); txt=pg.inner_text('#tbl')
        check('stop' in txt and 'limit' in txt,'stop and take-profit orders appear: '+txt.replace('\n',' ')[:90])
        # run fast until something triggers or just check stats tab
        pg.click('#hPlay'); pg.click('[data-act=speed][data-v="60"]'); pg.wait_for_timeout(2500); pg.click('#hPlay')
        pg.click('.dock [data-v=stats]'); pg.wait_for_selector('#statsBody .tile')
        t=pg.inner_text('#statsBody'); check('YOUR RETURN' in t.upper() and 'JUST HOLDING' in t.upper(),'stats tab shows return and hold comparison')
        check('too few' in t,'small-sample warning shown')
        check(pg.evaluate("document.documentElement.scrollWidth<=innerWidth"),f'{name}: stats no horizontal scroll')
        check(len(pg.query_selector_all('.dock button'))==5 and pg.evaluate("(()=>{const r=document.querySelector('.dock').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()"),f'{name}: five-tab dock fits')
        # export fills (browser download path)
        with pg.expect_download() as d: pg.click('[data-act=exportFills]')
        path=d.value.path(); csv=open(path).read()
        check(csv.startswith('time_utc,symbol,side') and 'BTC-USD' in csv,'fills CSV downloads: '+csv.splitlines()[0][:40])
        with pg.expect_download() as d: pg.click('[data-act=exportSummary]')
        sm=open(d.value.path()).read(); check('return_pct' in sm and 'closed_trades' in sm,'summary CSV downloads')
        pg.screenshot(path=f'/tmp/shots/{name}-stats.png',full_page=True)
        pg.click('.dock [data-v=trade]'); pg.screenshot(path=f'/tmp/shots/{name}-trade2.png',full_page=True)
        check(not logs,f'no page errors {logs[:2]}')
        ctx.close()
    b.close()
print('FAILED' if errs else 'ALL OK')
