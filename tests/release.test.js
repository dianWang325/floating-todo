import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('npm, Tauri and Cargo report the same application version', () => {
  const version = JSON.parse(read('package.json')).version;
  const npm = JSON.parse(read('package-lock.json'));
  assert.equal(npm.version, version); assert.equal(npm.packages[''].version, version);
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, version);
  assert.equal(read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)[1], version);
  assert.equal(read('src-tauri/Cargo.lock').match(/name = "floating-todo"\r?\nversion = "([^"]+)"/)[1], version);
});
