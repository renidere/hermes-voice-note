import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('the installation shortcut does not delegate SDK delivery to an arbitrary registered Hermes client', () => {
  const shortcut = readFileSync(new URL('../install/Install.url', import.meta.url), 'utf8');
  const target = new URL(/^URL=(.+)$/m.exec(shortcut)[1].trim());
  assert.equal(target.protocol, 'https:', 'hermes:// can launch the old client and cannot deliver its missing SDK');
  assert.equal(target.hostname, 'github.com');
  assert.match(target.pathname, /^\/renidere\/hermes-voice-note\/releases\//);
});

test('Windows installer and actual packaged SDK checks gate artifact upload', () => {
  const path = new URL('../.github/workflows/windows-install.yml', import.meta.url);
  assert.ok(existsSync(path), 'Delivery needs Windows installation and native SDK acceptance, not only a package string search');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /contents: read/);
  assert.match(text, /runs-on: windows-2025/);
  assert.match(text, /powershell\.exe.*windows-install\.ps1/);
  assert.match(text, /powershell\.exe.*windows-native-install-smoke\.ps1/);
  assert.ok(text.indexOf('id: test-installer') < text.indexOf('id: smoke-native'));
  assert.ok(text.indexOf('id: smoke-native') < text.indexOf('id: upload-package'));
  assert.match(text, /if: success\(\)/);
  assert.doesNotMatch(text, /secrets\.|contents: write|continue-on-error|pull_request_target/);
});
