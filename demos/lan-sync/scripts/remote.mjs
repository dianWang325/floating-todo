import { spawnSync } from 'node:child_process';
const [id = '971', argument = 'status'] = process.argv.slice(2);
if (!['971', '972', '973'].includes(id)) throw new Error('Choose demo container 971, 972, or 973');
const command = argument.startsWith('{') ? JSON.parse(argument) : { op: argument, full: false };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const remote = ['pct', 'exec', id, '--', 'env', 'DEMO_STATE=/var/lib/todo-demo', 'NODE_NO_WARNINGS=1',
  '/opt/node/bin/node', '/opt/todo-demo/demos/lan-sync/ctl.mjs', JSON.stringify(command)].map(quote).join(' ');
const result = spawnSync('ssh', ['-o', 'BatchMode=yes', 'root@192.168.11.10', remote], { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || String(result.error)); process.exit(result.status || 1);
}
try { console.log(JSON.stringify(JSON.parse(result.stdout), null, 2)); }
catch { process.stdout.write(result.stdout); }
