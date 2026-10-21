import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { canonical, newDocument, mergeRevisions, writeRevision, currentEntities, conflicts, resolveConflict } from '../../src/sync-model.js';

export const hash = v => createHash('sha256').update(canonical(v)).digest('hex');
export const shortCode = digits => String(randomInt(10 ** digits)).padStart(digits, '0');
export class Store {
  constructor(dir, datasetId) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(`${dir}/demo.sqlite3`);
    chmodSync(`${dir}/demo.sqlite3`, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL);`);
    const saved = this.db.prepare('SELECT json FROM meta WHERE id=1').get();
    this.meta = saved ? JSON.parse(saved.json) : {
      deviceId: randomUUID(), datasetId, fixedCode: shortCode(8), dynamic: null, peers: {},
      adminToken: randomUUID(), attempts: { start: 0, count: 0 }, clock: [0, 0]
    };
    if (this.meta.datasetId !== datasetId) throw new Error('dataset mismatch');
    this.doc = newDocument(); this.doc.deviceId = this.meta.deviceId; this.doc.clock = this.meta.clock;
    mergeRevisions(this.doc, this.db.prepare('SELECT json FROM revisions ORDER BY seq').all().map(r => JSON.parse(r.json)));
    this.savedCount = this.doc.revisions.length;
    this.save(); this.updateIndex();
  }
  updateIndex() {
    this.index = this.db.prepare('SELECT id, hash FROM revisions ORDER BY seq').all();
    this.root = hash([...this.index].sort((a, b) => a.id.localeCompare(b.id)));
  }
  save() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.meta.clock = this.doc.clock;
      this.db.prepare('INSERT INTO meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(this.meta));
      const insert = this.db.prepare('INSERT INTO revisions(id,hash,json) VALUES(?,?,?)');
      for (const r of this.doc.revisions.slice(this.savedCount)) insert.run(r.revisionId, hash(r), JSON.stringify(r));
      this.db.exec('COMMIT');
      const changed = this.savedCount !== this.doc.revisions.length;
      this.savedCount = this.doc.revisions.length;
      if (changed) this.updateIndex();
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.doc.outbox = []; // This demo uses set reconciliation, not the production DAV queue.
  }
  transaction(fn) {
    const doc = structuredClone(this.doc), meta = structuredClone(this.meta);
    try { const result = fn(); this.save(); return result; }
    catch (e) { this.doc = doc; this.meta = meta; throw e; }
  }
  codes(rotate = false) {
    if (rotate || !this.meta.dynamic || this.meta.dynamic.expires <= Date.now()) {
      let code;
      do { code = shortCode(6); } while (code === this.meta.dynamic?.code);
      this.meta.dynamic = { code, epoch: randomUUID(), expires: Date.now() + 60000 };
      this.save();
    }
    return { fixed: this.meta.fixedCode, dynamic: this.meta.dynamic.code, expires: this.meta.dynamic.expires };
  }
  merge(incoming) {
    if (!Array.isArray(incoming) || incoming.length > 100) throw new Error('batch limit');
    if (incoming.some(r => Buffer.byteLength(JSON.stringify(r)) > 128 * 1024)) throw new Error('revision byte limit');
    // Do not let a badly configured peer advance the local logical clock arbitrarily.
    if (incoming.some(r => r.modifiedAt > Date.now() + 5 * 60000)) throw new Error('future clock');
    return this.transaction(() => mergeRevisions(this.doc, incoming));
  }
  edit({ id = randomUUID(), title = 'demo task', deleted = false, resolve = false }) {
    if (typeof title !== 'string' || Buffer.byteLength(title) > 8192) throw new Error('title limit');
    return this.transaction(() => {
      const previous = currentEntities(this.doc).get(`task:${id}`)?.payload;
      const payload = { id, kind: 'one_off', title, detail: '', time: null, completed: false,
        createdAt: Date.now(), scheduledDate: '2026-10-21', projectId: null, tagIds: [], ...previous, title };
      return writeRevision(this.doc, 'task', id, payload, { deleted, resolve });
    });
  }
  resolve(key, revisionId) {
    const revision = this.doc.revisions.find(r => r.revisionId === revisionId);
    if (!revision) throw new Error('unknown revision');
    return this.transaction(() => resolveConflict(this.doc, key, revision));
  }
  summary() {
    return { deviceId: this.meta.deviceId, datasetId: this.meta.datasetId, count: this.doc.revisions.length,
      root: this.root, conflicts: conflicts(this.doc),
      entities: [...currentEntities(this.doc)].map(([key, r]) => ({ key, ...r })) };
  }
  close() { this.db.close(); }
}
