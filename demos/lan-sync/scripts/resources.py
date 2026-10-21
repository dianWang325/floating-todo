#!/usr/bin/env python3
"""Idle cgroup CPU/memory and interface byte deltas; run with no workload."""
from lab import IDS, run
import json
import time

def sample(ct):
    pid=run("lxc-info","-n",str(ct),"-pH")
    net=run("nsenter","-t",pid,"-n","--","cat","/proc/net/dev")
    interfaces={}
    for line in net.splitlines()[2:]:
        name,rest=line.split(":",1);values=rest.split()
        if name.strip() in ["eth0","eth1","tailscale0"]:
            interfaces[name.strip()]=int(values[0])+int(values[8])
    units={}
    for unit in (["todo-sync-demo","todo-tailscaled"] if ct in IDS else ["todo-headscale"]):
        text=run("pct","exec",str(ct),"--","systemctl","show",unit,"-p","MemoryCurrent","-p","CPUUsageNSec","-p","TasksCurrent")
        units[unit]={k:int(v) for k,v in (line.split("=",1) for line in text.splitlines())}
    return {"interfaces":interfaces,"units":units,"time":time.monotonic()}
all_ids=IDS+[974]
before={ct:sample(ct) for ct in all_ids}
started=time.monotonic()
time.sleep(30)
after={ct:sample(ct) for ct in all_ids}
elapsed=time.monotonic()-started
result={"note":"Interface bytes include headers/control/background traffic. eth1 underlay and tailscale0 overlay overlap; do not sum.",
        "sampleSeconds":round(elapsed,2),"nodes":{}}
for ct in all_ids:
    a,b=before[ct],after[ct]
    elapsed=b["time"]-a["time"]
    result["nodes"][ct]={"sampleSeconds":round(elapsed,2),"interfacesBytesPerSecond":{k:round((v-a["interfaces"].get(k,v))/elapsed,2) for k,v in b["interfaces"].items()},
        "services":{k:{"cgroupMemoryMiB":round(v["MemoryCurrent"]/2**20,2),
            "idleCpuOneCorePercent":round((v["CPUUsageNSec"]-a["units"][k]["CPUUsageNSec"])/elapsed/1e9*100,3),
            "tasks":v["TasksCurrent"]} for k,v in b["units"].items()}}
with open("/tmp/todo-resource-results.json","w") as f:json.dump(result,f,indent=2)
print(json.dumps(result),flush=True)
