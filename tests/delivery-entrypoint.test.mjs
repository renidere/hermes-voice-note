import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const name of ['Install', 'Update']) {
  test(`${name}.url cannot choose an arbitrary old Hermes window`, () => {
    const source = readFileSync(new URL(`../install/${name}.url`, import.meta.url), 'utf8');
    const url = new URL(/^URL=(.+)$/m.exec(source)[1].trim());
    assert.equal(url.protocol, 'https:', 'A plugin-only protocol handler cannot deliver a compatible client');
    assert.equal(url.hostname, 'github.com');
    assert.equal(url.pathname, '/renidere/hermes-voice-note/releases/latest');
  });
}
