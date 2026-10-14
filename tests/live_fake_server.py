"""Starts the real server with a fake Gemini client so the live-price UI can be tested offline.
Touch the file named by FAKE_DOWN to make quotes fail (to trigger the stale-data alarm)."""
import os, random, sys, time
sys.path.insert(0, 'server')
import uvicorn
from gtrader.api import make_app
from gtrader.session import Session

class Fake:
    def __init__(self): self.px = {'BTC-USD': 60000.0, 'ETH-USD': 3000.0, 'SOL-USD': 150.0}
    def ticker(self, s):
        if os.path.exists(os.environ['FAKE_DOWN']): raise RuntimeError('simulated outage')
        self.px[s] *= 1 + random.uniform(-0.0005, 0.0005); p = self.px[s]
        return {'bid': p * 0.9995, 'ask': p * 1.0005, 'last': p, 'vol24': 2400.0}
    def candles(self, s):
        now = int(time.time() * 1000) // 3600000 * 3600000; p = self.px[s]
        return [[now - (300 - i) * 3600000, p, p * 1.01, p * 0.99, p, 10.0] for i in range(300)]

S = Session(feed_client=Fake(), poll_s=0.5, stale_after_s=3)
uvicorn.run(make_app(S, ''), port=8766, log_level='error')
