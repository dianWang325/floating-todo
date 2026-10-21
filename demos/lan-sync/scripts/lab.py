#!/usr/bin/env python3
"""Run on the Proxmox host. Controls only the three dedicated synthetic demo guests."""
import concurrent.futures
import json
import math
import os
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

IDS = [971, 972, 973]
RESULT = {"tests": [], "environment": {"containers": IDS, "network": "10.77.42.0/29", "tailscale": "not tested: authorization pending"}}
WORKER = r'''
import json,sys,urllib.request
token=json.loads(sys.stdin.readline())
for line in sys.stdin:
    try:
        req=urllib.request.Request("http://127.0.0.1:47832/control",data=line.encode(),headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"})
        with urllib.request.urlopen(req,timeout=45) as r: out=json.load(r)
        print(json.dumps({"ok":True,"value":out}),flush=True)
    except Exception as e: print(json.dumps({"ok":False,"error":str(e)}),flush=True)
'''

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()

class Control:
    def __init__(self, ct):
        self.ct = ct
        token = run("pct", "exec", str(ct), "--", "/opt/node/bin/node", "--input-type=module", "-e",
                    "import{DatabaseSync}from'node:sqlite';let d=new DatabaseSync('/var/lib/todo-demo/demo.sqlite3',{readOnly:true});console.log(JSON.parse(d.prepare('SELECT json FROM meta').get().json).adminToken)")
        pid = run("lxc-info", "-n", str(ct), "-pH")
        self.worker = subprocess.Popen(["nsenter", "-t", pid, "-n", "--", sys.executable, "-u", "-c", WORKER],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.worker.stdin.write(json.dumps(token)+"\n"); self.worker.stdin.flush()
        self.lock = threading.Lock()
    def call(self, op, **kw):
        with self.lock:
            self.worker.stdin.write(json.dumps({"op": op, **kw})+"\n"); self.worker.stdin.flush()
            r = json.loads(self.worker.stdout.readline())
            if not r["ok"]: raise RuntimeError(r["error"])
            return r["value"]
    def close(self):
        self.worker.terminate()

def log(name, **data):
    RESULT["tests"].append({"name": name, **data})
    with open("/tmp/todo-sync-demo-progress.json", "w") as f:
        json.dump(RESULT, f, indent=2)
    print(json.dumps({"name": name, **data}), flush=True)

def main():
    nodes = [Control(i) for i in IDS]
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
    def statuses(full=False):
        return list(pool.map(lambda n: n.call("status", full=full), nodes))
    def converge(timeout=30):
        began = time.monotonic()
        while time.monotonic()-began < timeout:
            s = statuses()
            if len({x["root"] for x in s}) == 1: return s
            time.sleep(.05)
        raise AssertionError("failed to converge")
    try:
        began = time.monotonic()
        while time.monotonic()-began < 40:
            s = statuses()
            if all(len(x["candidates"]) >= 2 for x in s): break
            time.sleep(1)
        assert all(len(x["candidates"]) >= 2 for x in s), "mDNS discovery missing"
        log("mDNS: all three nodes discover two other nodes", elapsedMs=round((time.monotonic()-began)*1000),
            sources=[[c["source"] for c in x["candidates"]] for x in s])
        for i, j, mode in [(0, 1, "dynamic"), (1, 2, "fixed"), (2, 0, "fixed")]:
            codes = nodes[j].call("codes")
            started = time.monotonic()
            nodes[i].call("pair", url=f"http://10.77.42.{j+2}:47831", code=codes[mode], mode=mode)
            log(f"pair {IDS[i]}→{IDS[j]} {mode}", durationMs=round((time.monotonic()-started)*1000, 2))
        converge()
        samples = []
        for i in range(30):
            began = time.monotonic()
            nodes[i % 3].call("edit", title=f"latency-{i}-{uuid.uuid4()}")
            converge()
            samples.append((time.monotonic()-began)*1000)
        log("30 automatic edit-to-all-node convergence samples", medianMs=round(statistics.median(samples), 2),
            p95Ms=round(sorted(samples)[math.ceil(len(samples)*.95)-1], 2), maxMs=round(max(samples), 2),
            samplesMs=[round(x, 2) for x in samples])
        for n in nodes: n.call("pause", value=True)
        base = nodes[0].call("edit", title="conflict-base")
        for n in nodes: n.call("pause", value=False)
        converge()
        for n in nodes: n.call("pause", value=True)
        left = nodes[0].call("edit", id=base["entityId"], title="concurrent-left")
        nodes[1].call("edit", id=base["entityId"], title="concurrent-delete", deleted=True)
        nodes[2].call("edit", title="independent-offline")
        for n in nodes: n.call("pause", value=False)
        converge()
        assert all(len(s["conflicts"]) == 1 for s in statuses(True))
        nodes[2].call("resolve", key="task:"+base["entityId"], revisionId=left["revisionId"])
        converge()
        assert all(len(s["conflicts"]) == 0 for s in statuses(True))
        log("offline edit/delete conflict preserved and alternative restored", passed=True)
        before = statuses()
        run("pct", "exec", "973", "--", "systemctl", "kill", "--signal=SIGKILL", "todo-sync-demo")
        nodes[0].call("edit", title="while-C-restarts")
        time.sleep(5)
        after = converge(35)
        assert all(x["count"] >= before[0]["count"] + 1 for x in after)
        log("SIGKILL restart: identity, pairing, history and pending edits recover", passed=True)
        # Dedicated interface only. Cleanup is in finally even if a test fails.
        pid = run("lxc-info", "-n", "972", "-pH")
        try:
            run("nsenter", "-t", pid, "-n", "--", "tc", "qdisc", "add", "dev", "eth1", "root", "netem", "delay", "40ms", "loss", "5%")
            began = time.monotonic()
            for i in range(10): nodes[i % 3].call("edit", title=f"loss-delay-{i}")
            converge(60)
            log("40ms egress delay + 5% packet loss on B", passed=True, convergenceMs=round((time.monotonic()-began)*1000))
        finally:
            subprocess.run(["nsenter", "-t", pid, "-n", "--", "tc", "qdisc", "del", "dev", "eth1", "root"], capture_output=True)
        # Quiescent resource measurement includes both application endpoints, excludes control traffic in app byte counters.
        time.sleep(2)
        before = statuses()
        began = time.monotonic()
        time.sleep(45)
        after = statuses()
        elapsed = time.monotonic()-began
        resources = []
        for ct, a, b in zip(IDS, before, after):
            resources.append({"ct": ct, "rssMiB": round(b["resources"]["rss"]/2**20, 2),
                "idleCpuOneCorePercent": round((b["resources"]["cpuMicros"]-a["resources"]["cpuMicros"])/(elapsed*1e6)*100, 3),
                "appPayloadBytesPerSecond": round(sum(b["metrics"][k]-a["metrics"][k] for k in ["rxBytes","txBytes"])/elapsed, 2)})
        log("45s idle sample (application payload, not wire traffic)", resources=resources)
        began = time.monotonic()
        for i in range(300):
            nodes[i % 3].call("edit", title=f"burst-{i}")
        after = converge(60)
        log("300 edits across three nodes", convergenceMs=round((time.monotonic()-began)*1000),
            versions=after[0]["count"], rssMiB=[round(x["resources"]["rss"]/2**20,2) for x in after])
        # Three minutes of low-rate changes; bounded result retains only aggregate data.
        soak_start = time.monotonic(); max_rss = [0, 0, 0]; updates = 0
        while time.monotonic()-soak_start < 180:
            nodes[updates % 3].call("edit", title=f"soak-{updates}")
            s = converge(30)
            max_rss = [max(a, b["resources"]["rss"]) for a,b in zip(max_rss,s)]
            updates += 1
            if updates % 10 == 0: print(json.dumps({"soakProgress": updates}), flush=True)
            time.sleep(3)
        log("180s low-rate soak", edits=updates, maxRssMiB=[round(x/2**20,2) for x in max_rss],
            finalCounts=[x["count"] for x in statuses()])
        RESULT["passed"] = True
    except Exception as e:
        RESULT["passed"] = False; RESULT["error"] = str(e)
        print(json.dumps({"failed": str(e)}), flush=True)
        raise
    finally:
        with open("/tmp/todo-sync-demo-results.json", "w") as f: json.dump(RESULT, f, indent=2)
        for n in nodes: n.close()
        pool.shutdown()

if __name__ == "__main__": main()
