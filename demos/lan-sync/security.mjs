import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class Pake {
  constructor(binary = process.env.PAKE_BINARY || fileURLToPath(new URL('./pake/target/release/todo-demo-pake', import.meta.url))) {
    this.pending = [];
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const p = this.pending.shift();
      if (!p) return;
      try { const r = JSON.parse(line); r.error ? p.reject(new Error(r.error)) : p.resolve(r); }
      catch (e) { p.reject(e); }
    });
    const fail = e => { for (const p of this.pending.splice(0)) p.reject(e); this.failed = e; };
    this.child.on('error', fail);
    this.child.on('exit', () => fail(new Error('PAKE worker stopped')));
  }
  call(v) {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify(v) + '\n');
    });
  }
  close() { this.child.kill(); }
}
export const proof = (key, context) => createHmac('sha256', Buffer.from(key, 'hex')).update(context).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function keyFor(key, from, to, kind) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(0),
    Buffer.from(JSON.stringify(['todo-demo/v1', from, to, kind])), 32));
}
export function seal(key, header, body) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(key, header.from, header.to, header.kind), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const data = Buffer.concat([cipher.update(JSON.stringify(body)), cipher.final()]);
  return { header, nonce: nonce.toString('hex'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
}
export function unseal(key, envelope) {
  const { header, nonce, data, tag } = envelope;
  if (!/^[a-f0-9]{24}$/.test(nonce) || !/^[a-f0-9]{32}$/.test(tag)) throw new Error('invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(key, header.from, header.to, header.kind), Buffer.from(nonce, 'hex'));
  decipher.setAAD(Buffer.from(JSON.stringify(header)));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]));
}
