import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('one explicit launcher starts its own bundled client without changing the stable protocol', () => {
  const path = new URL('../install/Start-Voice-Note.cmd', import.meta.url);
  assert.ok(existsSync(path), 'A paired client needs an unambiguous launch entrypoint');
  const source = readFileSync(path, 'utf8');
  assert.match(source, /setlocal/i);
  assert.match(source, /HERMES_DESKTOP_USER_DATA_DIR=%LOCALAPPDATA%\\HermesVoiceNote\\desktop/);
  assert.match(source, /HERMES_HOME=%HERMES_DESKTOP_USER_DATA_DIR%\\hermes-home/);
  assert.match(source, /HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION=1/);
  assert.match(source, /start "".*"%~dp0hermes-light-3b42157\.exe"/i);
  assert.doesNotMatch(source, /hermes:\/\/|powershell|Set-ExecutionPolicy|copy |del |rmdir /i);
});
