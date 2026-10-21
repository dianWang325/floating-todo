#!/usr/bin/env python3
"""Short final LAN verification with raw latency samples and an explicit percentile definition."""
from lab import Control, IDS
import concurrent.futures
import json
import statistics
import time

nodes=[Control(i) for i in IDS]
pool=concurrent.futures.ThreadPoolExecutor(max_workers=3)
result={}
try:
    samples=[]
    for i in range(30):
        started=time.monotonic()
        nodes[i%3].call("edit",title=f"final-lan-{i}")
        while time.monotonic()-started<30:
            states=list(pool.map(lambda n:n.call("status",full=False),nodes))
            if len({s["root"] for s in states})==1:break
            time.sleep(.025)
        else:raise AssertionError("convergence timeout")
        samples.append((time.monotonic()-started)*1000)
    result={"passed":True,"network":"LAN","samplesMs":[round(x,2) for x in samples],
        "medianMs":round(statistics.median(samples),2),"p95Ms":round(sorted(samples)[28],2),
        "maxMs":round(max(samples),2),"percentileMethod":"nearest-rank ceil(0.95*n)",
        "counts":[s["count"] for s in states]}
finally:
    with open("/tmp/todo-lan-final.json","w") as f:json.dump(result,f,indent=2)
    print(json.dumps(result),flush=True)
    for n in nodes:n.close()
    pool.shutdown()
