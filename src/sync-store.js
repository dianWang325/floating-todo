import { canonical, digest, migrateSnapshot, projectView, commitView, mergeRevisions, conflicts, exportDocument, currentEntities, importRevisionsAsEdits, newDocument } from './sync-model.js';
const CACHE_KEY = 'floating-todo/v3-preview';
export class SyncStore {
  constructor({ invoke, native = false, onChange = () => {}, onStatus = () => {} }) {
    this.invoke = invoke; this.native = native; this.onChange = onChange; this.onStatus = onStatus;
    this.queue = Promise.resolve(); this.error = ''; this.busy = false; this.timer = null; this.retryAt = 0; this.failures = 0; this.persistedGeneration = 0;
  }
  async init(legacy, raw) {
    const saved = this.native ? await this.invoke('storage_load') : localStorage.getItem(CACHE_KEY);
    if (saved) {
      this.doc = JSON.parse(saved);
      this.persistedGeneration = this.doc.localGeneration || 0;
      if (this.doc.schemaVersion !== 3 || this.doc.protocolVersion !== 1) throw new Error('本地数据库来自不支持的版本');
      const check = newDocument(); mergeRevisions(check, this.doc.revisions);
    } else {
      this.doc = await migrateSnapshot(legacy);
      await this.persist(raw);
    }
    this.base = structuredClone(legacy);
    this.view = projectView(this.doc, this.base);
    this.mirror();
    return structuredClone(this.view);
  }
  mirror() {
    // Browser preview compatibility only. Native authoritative data lives in SQLite.
    if (!this.native) localStorage.setItem('floating-todo/snapshot', JSON.stringify(this.view));
  }
  persist(legacy = null) {
    const json = JSON.stringify(this.doc);
    // A failed write does not poison later retries. flush() still reports the failure.
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (this.native) {
        const generation = await this.invoke('storage_save', { json, legacy, expectedGeneration: this.persistedGeneration });
        this.persistedGeneration = generation ?? this.persistedGeneration + 1;
      }
      else localStorage.setItem(CACHE_KEY, json);
      this.storageError = null;
    });
    this.queue.catch(error => { this.storageError = String(error); this.error = `本地保存失败：${error}`; this.onStatus(); });
    return this.queue;
  }
  commit(view) {
    commitView(this.doc, this.view, view);
    this.view = structuredClone(view); this.mirror();
    this.persist(); this.schedule();
  }
  refresh(notify = true) {
    this.view = projectView(this.doc, this.base); this.mirror();
    if (notify) this.onChange(structuredClone(this.view));
    return structuredClone(this.view);
  }
  async changed() { await this.persist(); this.refresh(); this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    if (this.doc.sync.enabled) this.timer = setTimeout(() => this.sync().catch(() => {}), 2500);
  }
  start() {
    this.interval = setInterval(() => { if (Date.now() >= this.retryAt) this.sync().catch(() => {}); }, 60000);
    this.online = () => this.sync().catch(() => {});
    window.addEventListener('online', this.online);
    window.addEventListener('focus', this.online);
    this.schedule();
  }
  stop() { clearInterval(this.interval); clearTimeout(this.timer); window.removeEventListener('online', this.online); window.removeEventListener('focus', this.online); }
  status() {
    return { busy: this.busy, error: this.error, pending: this.doc.outbox.length, conflicts: conflicts(this.doc).length, lastSuccess: this.doc.sync.lastSuccess, enabled: this.doc.sync.enabled };
  }
  async configure(config, password) {
    if (this.busy) throw new Error('同步进行中，请完成后再修改连接');
    if (!this.native) throw new Error('WebDAV 连接仅在桌面应用中可用');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(config.spaceId)) throw new Error('同步空间名称仅允许字母、数字、下划线和短横线');
    const changed = this.doc.sync.url !== config.url || this.doc.sync.username !== config.username || this.doc.sync.spaceId !== config.spaceId;
    if (password) await this.invoke('sync_set_password', { config, password });
    if (changed) { this.doc.knownObjects = {}; this.doc.outbox = this.doc.revisions.map(r => r.revisionId); delete this.doc.pendingBatch; }
    Object.assign(this.doc.sync, config); await this.persist(); this.onStatus();
    this.schedule();
  }
  async request(path, method, body = null) {
    return this.invoke('dav_request', { config: { url: this.doc.sync.url, username: this.doc.sync.username }, path, method, body, etag: null });
  }
  async mkdir(path) {
    const r = await this.request(path, 'MKCOL');
    if (![200, 201, 204, 405].includes(r.status)) throw new Error(`创建同步目录失败（${r.status}）`);
  }
  async immutable(path, body) {
    const put = await this.request(path, 'PUT', body);
    if (![200, 201, 204, 412].includes(put.status)) throw new Error(`上传失败（${put.status}）`);
    const read = await this.request(path, 'GET');
    if (read.status !== 200 || read.body !== body) throw new Error('远端文件校验失败，上传队列已保留');
  }
  async ensureSpace() {
    const root = `floating-todo/${this.doc.sync.spaceId}/`;
    await this.mkdir('floating-todo/'); await this.mkdir(root);
    let response = await this.request(root + 'manifest.json', 'GET');
    if (response.status === 404) {
      const manifest = { protocolVersion: 1, spaceId: this.doc.sync.spaceId, timeZone: this.doc.sync.timeZone };
      await this.immutable(root + 'manifest.json', JSON.stringify(manifest));
      response = await this.request(root + 'manifest.json', 'GET');
    }
    if (response.status !== 200) throw new Error(`无法读取同步空间（${response.status}）`);
    const manifest = JSON.parse(response.body);
    if (manifest.protocolVersion !== 1 || manifest.spaceId !== this.doc.sync.spaceId) throw new Error('同步空间协议不兼容');
    if (manifest.timeZone !== this.doc.sync.timeZone) throw new Error('同步空间时区不同，已停止同步以避免日期错位');
    await this.mkdir(root + 'changes/'); await this.mkdir(root + `changes/${this.doc.deviceId}/`);
    return root;
  }
  async pull(root) {
    const dirs = await this.request(root + 'changes/', 'PROPFIND');
    if (dirs.status !== 207) throw new Error(`读取同步目录失败（${dirs.status}）`);
    let changed = false;
    for (const dir of dirs.entries) {
      if (!dir.collection || !dir.path.startsWith(root + 'changes/') || !/^[a-zA-Z0-9_-]+\/$/.test(dir.path.slice((root + 'changes/').length))) continue;
      const files = await this.request(dir.path, 'PROPFIND');
      if (files.status !== 207) throw new Error(`读取设备目录失败（${files.status}）`);
      for (const file of files.entries) {
        if (file.collection || !file.path.startsWith(dir.path) || !/^[a-zA-Z0-9_-]+\.json$/.test(file.path.slice(dir.path.length)) || this.doc.knownObjects[file.path]) continue;
        const response = await this.request(file.path, 'GET');
        if (response.status !== 200) throw new Error(`下载变更失败（${response.status}）`);
        const batch = JSON.parse(response.body);
        if (batch.protocolVersion !== 1 || batch.spaceId !== this.doc.sync.spaceId || batch.batchId + '.json' !== file.path.slice(dir.path.length) || batch.deviceId !== dir.path.split('/').at(-2) || !Array.isArray(batch.revisions)) throw new Error('变更批次信息不匹配');
        if (await digest(batch.revisions) !== batch.checksum) throw new Error('变更批次校验失败');
        if (this.canSync && !this.canSync()) throw new Error('正在编辑，稍后重试同步');
        const added = mergeRevisions(this.doc, batch.revisions);
        changed = added > 0 || changed;
        this.doc.knownObjects[file.path] = batch.checksum;
        const saved = this.persist();
        if (added) this.refresh();
        await saved;
      }
    }
    return changed;
  }
  async push(root) {
    while (this.doc.outbox.length) {
      if (!this.doc.pendingBatch) {
        const ids = new Set(this.doc.outbox.slice(0, 100));
        const revisions = this.doc.revisions.filter(r => ids.has(r.revisionId));
        const batch = { protocolVersion: 1, spaceId: this.doc.sync.spaceId, deviceId: this.doc.deviceId, batchId: crypto.randomUUID(), revisions, checksum: await digest(revisions) };
        this.doc.pendingBatch = batch; await this.persist();
      }
      const batch = this.doc.pendingBatch;
      const path = `${root}changes/${batch.deviceId}/${batch.batchId}.json`;
      await this.immutable(path, JSON.stringify(batch));
      const sent = new Set(batch.revisions.map(r => r.revisionId));
      this.doc.outbox = this.doc.outbox.filter(id => !sent.has(id));
      this.doc.knownObjects[path] = batch.checksum; delete this.doc.pendingBatch;
      await this.persist();
    }
  }
  async sync(force = false) {
    if (this.busy || (!force && !this.doc.sync.enabled) || (this.canSync && !this.canSync())) return;
    if (!this.native) throw new Error('请在桌面应用中使用 WebDAV 同步');
    this.busy = true; this.error = ''; this.onStatus();
    const before = new Set(conflicts(this.doc).map(c => c.key));
    try {
      await this.persist();
      const root = await this.ensureSpace();
      await this.pull(root); await this.push(root); await this.pull(root);
      this.doc.sync.lastSuccess = new Date().toISOString(); this.failures = 0; this.retryAt = 0;
      await this.persist();
      const restored = conflicts(this.doc).filter(c => !before.has(c.key) && !c.winner.deleted && c.heads.some(r => r.deleted));
      if (restored.length) this.notice?.(`${restored.length} 项较新的编辑已恢复被删除的内容，可在同步冲突中查看`);
    } catch (error) {
      this.error = String(error.message || error); this.failures++;
      this.retryAt = Date.now() + Math.min(900000, 30000 * 2 ** Math.min(this.failures, 5));
      throw error;
    } finally { this.busy = false; this.onStatus(); }
  }
  backup(view) { return exportDocument(this.doc, view); }
  async prepareImport(parsed, normalize, defaults) {
    if (parsed.schemaVersion === 3) {
      if (parsed.syncData?.protocolVersion !== 1 || !Array.isArray(parsed.syncData.revisions)) throw new Error('备份缺少 v3 数据');
      const source = newDocument(); mergeRevisions(source, parsed.syncData.revisions);
      return source.revisions;
    }
    const source = await migrateSnapshot(normalize(parsed, defaults)); return source.revisions;
  }
  previewImport(revisions) {
    const source = newDocument(); mergeRevisions(source, revisions);
    const current = currentEntities(this.doc), counts = { added: 0, updated: 0, deleted: 0 };
    for (const [key, r] of currentEntities(source)) {
      const old = current.get(key);
      if (old && old.deleted === r.deleted && canonical(old.payload) === canonical(r.payload)) continue;
      if (r.deleted) counts.deleted++; else if (!old || old.deleted) counts.added++; else counts.updated++;
    }
    return counts;
  }
  async import(revisions) { importRevisionsAsEdits(this.doc, revisions); await this.changed(); }
}
