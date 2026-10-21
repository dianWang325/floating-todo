import test from 'node:test';
import assert from 'node:assert/strict';
import { probeInBatches } from '../discovery.mjs';

test('discovery probes later peers after failed probes without exceeding four connections', async () => {
  let active = 0, peak = 0;
  const visited = [];
  await probeInBatches(Array.from({ length: 11 }, (_, i) => i), async i => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      visited.push(i);
      if (i < 4) throw new Error('unrelated peer has no demo service');
    } finally { active--; }
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(visited.sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i));
});
