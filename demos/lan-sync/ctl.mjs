import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(`${process.env.DEMO_STATE || './state'}/demo.sqlite3`, { readOnly: true });
const meta = JSON.parse(db.prepare('SELECT json FROM meta WHERE id=1').get().json); db.close();
const input = process.argv[2] || '{"op":"status","full":false}';
const response = await fetch(`http://127.0.0.1:${process.env.ADMIN_PORT || 47832}/control`, {
  method: 'POST', headers: { authorization: `Bearer ${meta.adminToken}`, 'content-type': 'application/json' }, body: input
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
