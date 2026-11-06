// Opt-in DOM safety regression. SDK Button's native <button> contract was checked in Hermes source.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadPlugin } from './load-plugin.mjs';

const require = createRequire(process.env.HERMES_SOURCE_ROOT ? resolve(process.env.HERMES_SOURCE_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<form><textarea name="draft">Этот черновик не нужно отправлять</textarea><div id="voice"></div></form>');
const document = dom.window.document;
let unexpectedSubmits = 0, pending, processor, explicitVoiceSubmits = 0;
document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); unexpectedSubmits++; });
const route = { connectionId: 'fixture', mode: 'remote', profile: 'default', targetProfile: 'default' };
const host = {
  state: { focusedSessionId: { get: () => 'live' }, focusedStoredSessionId: { get: () => 'stored' },
    focusedSessionOwner: { get: () => ({ connectionId: 'fixture', profile: 'default' }) } },
  profileRoutes: async () => [route], retainProfile: async () => () => {}, notify() {},
  requestProfile: async (_route, method) => method === 'session.resume'
    ? { session_id: 'live' } : { attached: true, ref_text: '@file:attachments/voice.wav' },
  composer: { submit: (_id, text) => { assert.equal(text, '@file:attachments/voice.wav'); explicitVoiceSubmits++; return true; } },
};
class AudioContext {
  constructor() { this.sampleRate = 48000; }
  async resume() {} async close() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; }
  get destination() { return {}; }
}
const env = { AudioContext, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } } };
const plugin = await loadPlugin(env, { host });
const contributions = [], cleanup = [];
plugin.default.register({ register: c => contributions.push(c), onDispose: fn => cleanup.push(fn) });
const contribution = contributions[0];
function native(node) {
  if (!node || typeof node === 'boolean') return document.createTextNode('');
  if (typeof node !== 'object') return document.createTextNode(String(node));
  if (typeof node.type === 'function') return native(node.type(node.props));
  const element = document.createElement(node.type);
  const props = node.props || {};
  if (props.type !== undefined) element.setAttribute('type', props.type);
  if (props.disabled) element.disabled = true;
  if (props.onClick) element.addEventListener('click', event => { pending = props.onClick(event); });
  for (const child of [].concat(props.children || [])) element.append(native(child));
  return element;
}
async function click(label) {
  document.querySelector('#voice').replaceChildren(native(contribution.render()));
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === label);
  assert.ok(button, label);
  pending = undefined;
  button.click();
  await pending;
  assert.equal(unexpectedSubmits, 0, `${label} must not submit the parent composer form`);
  assert.equal(document.querySelector('textarea').value, 'Этот черновик не нужно отправлять');
}
try {
  await click('🎙 Записать');
  processor.onaudioprocess({ inputBuffer: { numberOfChannels: 2, getChannelData: () => new Float32Array([0, 0.25]) } });
  await click('Отправить');
  await click('🎙 Записать');
  await click('Отмена');
  assert.equal(explicitVoiceSubmits, 1);
  console.log(JSON.stringify({ passed: true, scope: 'Native jsdom form click with real plugin render and fixture SDK Button contract', checked: ['record', 'send', 'cancel'], unexpected_form_submits: unexpectedSubmits, draft_preserved: true, explicit_voice_submits: explicitVoiceSubmits }));
} finally {
  cleanup.forEach(fn => fn());
  dom.window.close();
}
