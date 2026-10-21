#!/usr/bin/env python3
from lab import IDS, Control, run
import concurrent.futures
import json
import time

nodes=[Control(i) for i in IDS]
pool=concurrent.futures.ThreadPoolExecutor(max_workers=3)
result={"network":"Tailscale","tests":[]}
def states():return list(pool.map(lambda n:n.call("status",full=False),nodes))
def converge(timeout=60):
    t=time.monotonic()
    while time.monotonic()-t<timeout:
        s=states()
        if len({x["root"] for x in s})==1:return s
        time.sleep(.1)
    raise AssertionError("soak failed to converge")
def restarts():
    return [int(run("pct","exec",str(i),"--","systemctl","show","todo-sync-demo","-p","NRestarts","--value")) for i in IDS]
def save():
    with open("/tmp/todo-soak-results.json","w") as f:json.dump(result,f,indent=2)
try:
    initial=states()[0]["count"];before_restarts=restarts()
    started=time.monotonic()
    for i in range(1000):nodes[i%3].call("edit",title=f"overlay-scale-{i}")
    s=converge()
    assert s[0]["count"]==initial+1000
    result["tests"].append({"name":"1000 real-LXC edits and convergence",
        "elapsedMs":round((time.monotonic()-started)*1000),"counts":[x["count"] for x in s]})
    started=time.monotonic();maximum=[0,0,0];updates=0
    while time.monotonic()-started<300:
        nodes[updates%3].call("edit",title=f"overlay-soak-{updates}")
        s=converge()
        maximum=[max(a,b["resources"]["rss"]) for a,b in zip(maximum,s)]
        updates+=1
        result["progress"]={"seconds":round(time.monotonic()-started),"edits":updates,"maxRssMiB":[round(v/2**20,2) for v in maximum]}
        save()
        time.sleep(3)
    after_restarts=restarts()
    assert before_restarts==after_restarts,"unexpected service restart/OOM"
    assert all(s["count"]==initial+1000+updates for s in states())
    result["tests"].append({"name":"300s post-load soak","edits":updates,"maxRssMiB":[round(v/2**20,2) for v in maximum],
        "unexpectedRestarts":0,"counts":[s["count"] for s in states()]})
    result["passed"]=True
except Exception as e:
    result["passed"]=False;result["error"]=str(e);raise
finally:
    save()
    for n in nodes:n.close()
    pool.shutdown()
    print(json.dumps(result),flush=True)
