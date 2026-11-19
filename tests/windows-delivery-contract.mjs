import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const workflowPath = resolve(root, '.github/workflows/windows-client.yml');
const require = createRequire(resolve(process.env.HERMES_SOURCE_ROOT, 'package.json'));
const yaml = require('js-yaml');

test('Windows delivery builds the patched client before publishing an artifact', () => {
  assert.ok(existsSync(workflowPath), 'A Windows client delivery workflow is required');
  const workflow = yaml.load(readFileSync(workflowPath, 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['windows-client']);
  const job = workflow.jobs['windows-client'];
  assert.equal(job['runs-on'], 'windows-2025');
  assert.equal(job['timeout-minutes'], 45);
  assert.doesNotMatch(job.env.HERMES_HOME, /\$\{\{\s*runner\./, 'job.env cannot use the runner context before runner assignment');
  assert.equal(job.env.HERMES_DESKTOP_VARIANT, 'light');
  assert.equal(job.env.HERMES_BUILD_COMMIT, '3b421578588243f920886e6fe79a6faa87ea026e');
  const ids = job.steps.filter(step => step.id).map(step => step.id);
  assert.deepEqual(ids, ['checkout-plugin', 'checkout-core', 'apply-sdk', 'bundle-plugin', 'verify-source', 'test-sdk', 'test-composer', 'test-plugin', 'build-client', 'package-client', 'verify-package', 'smoke-bundled', 'finalize-receipt', 'upload-package']);
  for (const step of job.steps.filter(step => step.uses)) {
    assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/);
    if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
  }
  const source = job.steps.find(step => step.id === 'checkout-core');
  assert.equal(source.with.repository, 'NousResearch/hermes-agent');
  assert.equal(source.with.ref, job.env.HERMES_BUILD_COMMIT);
  const apply = job.steps.find(step => step.id === 'apply-sdk').run;
  assert.match(apply, /git apply --check/);
  assert.match(apply, /git apply -- /);
  assert.match(job.steps.find(step => step.id === 'bundle-plugin').run, /Copy-Item .*plugin\.js src\/plugins\/hermes-voice-note\/plugin\.js/);
  assert.match(job.steps.find(step => step.id === 'smoke-bundled').run, /windows-bundled-smoke\.ps1/);
  assert.match(job.steps.find(step => step.id === 'finalize-receipt').run, /recordControlObserved/);
  const sdk = job.steps.find(step => step.id === 'test-sdk');
  assert.match(sdk.run, /session-request\.test\.ts/);
  assert.match(job.steps.find(step => step.id === 'test-composer').run, /use-composer-submit\.test\.tsx/);
  const packageCommand = job.steps.find(step => step.id === 'package-client').run;
  assert.match(packageCommand, /^node apps\/desktop\/scripts\/run-electron-builder\.mjs /, 'pnpm must not split builder -c dotted overrides');
  assert.match(packageCommand, /--win zip --x64 --publish never/);
  const upload = job.steps.find(step => step.id === 'upload-package');
  assert.equal(upload.if, 'success()');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with.path, 'delivery/*');
  const text = readFileSync(workflowPath, 'utf8');
  assert.doesNotMatch(text, /secrets\.|pull_request_target|contents: write|continue-on-error/);
});
