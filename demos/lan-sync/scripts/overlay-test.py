#!/usr/bin/env python3
"""Requires lab.py next to this file; operates only on the three demo guests."""
from lab import Control, IDS, run
import concurrent.futures
import json
import ipaddress
import statistics
import subprocess
import time

addresses = []
for ct in IDS:
    vpn = json.loads(run("pct", "exec", str(ct), "--", "/opt/tailscale/tailscale", "status", "--json"))
    assert vpn["BackendState"] == "Running", f"CT {ct}: VPN authorization required"
    addresses.append(next(ip for ip in vpn["TailscaleIPs"] if ipaddress.ip_address(ip).version == 4))
urls = [f"http://{address}:47831" for address in addresses]
nodes = [Control(i) for i in IDS]
pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
result = {"network": "real Tailscale, mDNS disabled", "addresses": dict(zip(IDS, addresses)), "tests": []}
def status(full=False):
    return list(pool.map(lambda n: n.call("status", full=full), nodes))
def log(name, **kw):
    result["tests"].append({"name":name, **kw})
    with open("/tmp/todo-overlay-progress.json","w") as f: json.dump(result,f,indent=2)
    print(json.dumps(result["tests"][-1]),flush=True)
def converge(timeout=40):
    started=time.monotonic()
    while time.monotonic()-started<timeout:
        s=status()
        if len({x["root"] for x in s})==1:return s
        time.sleep(.05)
    raise AssertionError("overlay convergence timeout")
try:
    started=time.monotonic()
    while time.monotonic()-started<70:
        s=status()
        if all(set(urls)-{urls[i]} <= {c["url"] for c in x["candidates"] if c["source"]=="tailscale"} for i,x in enumerate(s)):break
        time.sleep(1)
    assert all(set(urls)-{urls[i]} <= {c["url"] for c in x["candidates"] if c["source"]=="tailscale"} for i,x in enumerate(s))
    assert all(set(urls)-{urls[i]} <= {p["url"] for p in x["peers"]} for i,x in enumerate(s))
    log("Tailscale node-list discovery and authenticated address migration", urls=[[c["url"] for c in x["candidates"]] for x in s])
    # Physical application address must be unavailable, proving no plaintext-LAN fallback.
    pid=run("lxc-info","-n","971","-pH")
    probe=subprocess.run(["nsenter","-t",pid,"-n","--","python3","-c",
        "import urllib.request;urllib.request.urlopen('http://10.77.42.3:47831/hello',timeout=2)"],capture_output=True)
    assert probe.returncode!=0
    log("physical-address application fallback unavailable",passed=True)
    for n in nodes:n.call("pause",value=True)
    for i,j,mode in [(0,1,"dynamic"),(1,2,"fixed"),(2,0,"fixed")]:
        code=nodes[j].call("codes")[mode]
        began=time.monotonic()
        nodes[i].call("pair",url=urls[j],mode=mode,code=code)
        log(f"{mode} code pairing over Tailscale",durationMs=round((time.monotonic()-began)*1000,2))
    for n in nodes:n.call("pause",value=False)
    converge()
    samples=[]
    for i in range(30):
        began=time.monotonic()
        nodes[i%3].call("edit",title=f"overlay-{i}")
        converge()
        samples.append((time.monotonic()-began)*1000)
    log("30 Tailscale automatic convergence samples",medianMs=round(statistics.median(samples),2),
        p95Ms=round(sorted(samples)[28],2),maxMs=round(max(samples),2),samplesMs=[round(x,2) for x in samples])
    base=nodes[0].call("edit",title="overlay-conflict-base");converge()
    for n in nodes:n.call("pause",value=True)
    left=nodes[0].call("edit",id=base["entityId"],title="overlay-left")
    nodes[2].call("edit",id=base["entityId"],title="overlay-right")
    for n in nodes:n.call("pause",value=False)
    converge()
    assert all(len(s["conflicts"])==1 for s in status(True))
    nodes[1].call("resolve",key="task:"+base["entityId"],revisionId=left["revisionId"])
    converge()
    assert all(len(s["conflicts"])==0 for s in status(True))
    log("conflict preservation and replacement over Tailscale",passed=True)
    # Stop only this guest's VPN, then let normal polling recover without forcing a sync.
    run("pct","exec","973","--","systemctl","stop","todo-tailscaled")
    nodes[0].call("edit",title="during-VPN-outage")
    time.sleep(2)
    assert nodes[2].call("status",full=False)["root"]!=nodes[0].call("status",full=False)["root"]
    began=time.monotonic()
    run("pct","exec","973","--","systemctl","start","todo-tailscaled")
    converge(60)
    log("VPN stop/start reconnect without manual sync",recoveryMs=round((time.monotonic()-began)*1000))
    time.sleep(2)
    before=status();began=time.monotonic()
    vpn_before=[int(run("pct","exec",str(i),"--","systemctl","show","todo-tailscaled","-p","CPUUsageNSec","--value")) for i in IDS]
    time.sleep(45)
    after=status();elapsed=time.monotonic()-began
    resources=[]
    for ct,a,b,vcpu in zip(IDS,before,after,vpn_before):
        raw=run("pct","exec",str(ct),"--","systemctl","show","todo-tailscaled","-p","MemoryCurrent","-p","CPUUsageNSec")
        fields=dict(line.split("=",1) for line in raw.splitlines())
        resources.append({"ct":ct,"appRssMiB":round(b["resources"]["rss"]/2**20,2),
            "appIdleCpuPercent":round((b["resources"]["cpuMicros"]-a["resources"]["cpuMicros"])/elapsed/1e6*100,3),
            "appPayloadBytesPerSecond":round(sum(b["metrics"][k]-a["metrics"][k] for k in ["rxBytes","txBytes"])/elapsed,2),
            "vpnCgroupMiB":round(int(fields["MemoryCurrent"])/2**20,2),
            "vpnCpuPercent":round((int(fields["CPUUsageNSec"])-vcpu)/elapsed/1e9*100,3)})
    log("45s overlay idle sample",resources=resources)
    result["passed"]=True
except Exception as e:
    result["passed"]=False;result["error"]=str(e);raise
finally:
    with open("/tmp/todo-overlay-results.json","w") as f:json.dump(result,f,indent=2)
    for n in nodes:n.close()
    pool.shutdown()
