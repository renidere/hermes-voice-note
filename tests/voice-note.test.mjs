import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './load-plugin.mjs';

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return [].concat(node.props?.children || []).map(textContent).join('');
}

function findButton(node, label) {
  if (node?.type === 'button' && textContent(node) === label) return node;
  return [].concat(node?.props?.children || []).map(child => findButton(child, label)).find(Boolean);
}


test('encodes the captured left and silent right channels as a PCM WAV without downmix', async () => {
  const plugin = await loadPlugin();
  assert.equal(typeof plugin.encodeWav, 'function', 'PCM encoder is not implemented');
  const blob = plugin.encodeWav([[new Float32Array([0, 0.5, -1]), new Float32Array([0, 0, 0])]], 48000);
  assert.equal(blob.type, 'audio/wav');
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(buffer.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.deepEqual([...new Int16Array(buffer, 44)], [0, 0, 16384, 0, -32768, 0]);
});

function fakeHost() {
  const focus = { live: 'live-a', stored: 'stored-a', owner: { connectionId: 'fixture-backend', profile: 'default' } };
  const route = { connectionId: 'fixture-backend', mode: 'remote', profile: 'default', targetProfile: 'default' };
  const calls = [];
  const host = {
    state: {
      focusedSessionId: { get: () => focus.live }, focusedStoredSessionId: { get: () => focus.stored },
      focusedSessionOwner: { get: () => focus.owner }, busyBySession: { get: () => ({}) },
    },
    profileRoutes: async () => [route], retainProfile: async () => () => calls.push(['release']),
    requestProfile: async (owner, method, params) => {
      calls.push([method, structuredClone(params), owner]);
      if (method === 'session.resume') return { session_id: 'resumed-a', stored_session_id: 'stored-a' };
      if (method === 'file.attach') return { attached: true, ref_text: '@file:attachments/voice.wav' };
      throw new Error(`Unexpected RPC: ${method}`);
    },
    composer: { submit: (id, text) => { calls.push(['submit', id, text]); return true; } },
    notify: value => calls.push(['notify', value]),
  };
  return { host, focus, route, calls };
}

function fakeAudio() {
  const capture = { tracksStopped: 0, contextClosed: 0, constraints: null, processor: null };
  const stream = { getTracks: () => [{ stop() { capture.tracksStopped++; } }],
    getAudioTracks: () => [{ getSettings: () => ({ channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false }) }] };
  class AudioContext {
    constructor() { this.sampleRate = 48000; this.state = 'running'; }
    async resume() {}
    async close() { this.state = 'closed'; capture.contextClosed++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { capture.processor = { connect() {}, disconnect() {}, onaudioprocess: null }; return capture.processor; }
    get destination() { return {}; }
  }
  return { capture, env: { AudioContext, navigator: { mediaDevices: { getUserMedia: async value => { capture.constraints = structuredClone(value); return stream; } } } } };
}

function feed(capture) {
  capture.processor.onaudioprocess({ inputBuffer: { numberOfChannels: 2,
    getChannelData: channel => new Float32Array(channel ? [0, 0, 0] : [0, 0.5, -0.5]) } });
}

test('records WAV and submits only its reference through the original session without ASR', async () => {
  const { host, calls, route } = fakeHost();
  const { env, capture } = fakeAudio();
  const plugin = await loadPlugin(env);
  assert.equal(typeof plugin.VoiceNote, 'function', 'Voice recorder is not implemented');
  const voice = new plugin.VoiceNote(host);
  await voice.start();
  assert.equal(voice.state.get().phase, 'recording');
  assert.deepEqual(capture.constraints.audio, { channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  feed(capture);
  await voice.send();
  const upload = calls.find(([name]) => name === 'file.attach');
  assert.equal(upload[1].session_id, 'resumed-a');
  assert.equal(upload[1].path, undefined);
  assert.match(upload[1].data_url, /^data:audio\/wav;base64,UklGR/);
  assert.equal(upload[2], route);
  assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
  assert.equal(capture.tracksStopped, 1);
  assert.equal(capture.contextClosed, 1);
  assert.equal(voice.state.get().phase, 'idle');
  assert.deepEqual(calls.filter(([name]) => !['release', 'notify', 'submit'].includes(name)).map(([name]) => name), ['session.resume', 'file.attach']);
});

test('cancelling while microphone permission is pending closes the late stream without uploading', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  let grant;
  env.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const plugin = await loadPlugin(env);
  const voice = new plugin.VoiceNote(host);
  assert.equal(typeof voice.cancel, 'function', 'Cancellation is not implemented');
  const starting = voice.start();
  await new Promise(resolve => setImmediate(resolve));
  voice.cancel();
  grant({ getTracks: () => [{ stop() { capture.tracksStopped++; } }] });
  await starting;
  assert.equal(capture.tracksStopped, 1);
  assert.equal(capture.processor, null);
  assert.equal(voice.state.get().phase, 'idle');
  assert.equal(calls.length, 0);
});

test('upload failure retains the stopped recording and permits an explicit retry', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  const request = host.requestProfile;
  let offline = true;
  host.requestProfile = async (...args) => {
    if (args[1] === 'file.attach' && offline) throw new Error('offline');
    return request(...args);
  };
  await voice.start(); feed(capture);
  await assert.rejects(voice.send(), /offline/);
  assert.equal(voice.state.get().phase, 'ready');
  assert.ok(voice.blob.size > 44);
  assert.equal(calls.some(([name]) => name === 'submit'), false);
  assert.equal(capture.tracksStopped, 1);
  offline = false;
  await voice.send();
  assert.equal(calls.filter(([name]) => name === 'submit').length, 1);
  assert.equal(voice.state.get().phase, 'idle');
});


test('cancelling an in-flight upload never submits a later server reply', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  const request = host.requestProfile;
  let finishUpload;
  host.requestProfile = (...args) => args[1] === 'file.attach'
    ? new Promise(resolve => { finishUpload = resolve; }) : request(...args);
  await voice.start(); feed(capture);
  const sending = voice.send();
  await new Promise(resolve => setImmediate(resolve));
  voice.cancel();
  finishUpload({ attached: true, ref_text: '@file:attachments/cancelled.wav' });
  await sending;
  assert.equal(calls.some(([name]) => name === 'submit'), false);
  assert.equal(voice.state.get().phase, 'idle');
  assert.equal(voice.blob, null);
});


test('a second send click cannot start a second upload', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  const request = host.requestProfile;
  const uploads = [];
  host.requestProfile = (...args) => args[1] === 'file.attach'
    ? new Promise(resolve => uploads.push(resolve)) : request(...args);
  await voice.start(); feed(capture);
  const first = voice.send();
  const second = voice.send();
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(uploads.length, 1); }
  finally {
    for (const resolve of uploads) resolve({ attached: true, ref_text: '@file:attachments/one.wav' });
    await Promise.allSettled([first, second]);
  }
  assert.equal(calls.filter(([name]) => name === 'submit').length, 1);
});


test('failed audio startup releases the device and returns to idle', async () => {
  const { host } = fakeHost();
  const { env, capture } = fakeAudio();
  env.AudioContext.prototype.createMediaStreamSource = () => { throw new Error('device lost'); };
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await assert.rejects(voice.start(), /device lost/);
  assert.equal(capture.tracksStopped, 1);
  assert.equal(capture.contextClosed, 1);
  assert.equal(voice.state.get().phase, 'idle');
  assert.match(voice.state.get().error, /микрофон/i);
});


test('sending before the first audio frame stops capture instead of leaving a stuck recorder', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await voice.start();
  await assert.rejects(voice.send());
  assert.equal(voice.state.get().phase, 'idle');
  assert.equal(capture.tracksStopped, 1);
  assert.equal(calls.length, 0);
});


test('the recording limit stops capture and retains audio without auto-sending', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  let timeout;
  env.setTimeout = (fn, ms) => { timeout = { fn, ms }; return 1; };
  env.clearTimeout = () => {};
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await voice.start(); feed(capture);
  assert.ok(timeout, 'Recording limit is not installed');
  assert.equal(timeout.ms, 300000);
  timeout.fn();
  assert.equal(voice.state.get().phase, 'ready');
  assert.ok(voice.blob.size > 44);
  assert.equal(capture.tracksStopped, 1);
  assert.equal(calls.length, 0);
});


test('the plugin contributes Record and Send controls and stops capture when disabled', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const plugin = await loadPlugin(env, { host });
  assert.equal(typeof plugin.default?.register, 'function', 'Desktop plugin entry point is missing');
  const contributions = [], cleanup = [];
  plugin.default.register({ register: value => contributions.push(value), onDispose: fn => cleanup.push(fn) });
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].area, 'composer.actions');
  const element = contributions[0].render();
  const render = () => element.type(element.props);
  const record = findButton(render(), 'Записать');
  assert.ok(record);
  await record.props.onClick();
  assert.ok(findButton(render(), 'Отправить'));
  feed(capture);
  await findButton(render(), 'Отправить').props.onClick();
  assert.equal(calls.filter(([name]) => name === 'submit').length, 1);
  await findButton(render(), 'Записать').props.onClick();
  cleanup.forEach(fn => fn());
  assert.equal(capture.tracksStopped, 2);
});


test('does not silently record when the device reports active automatic gain control', async () => {
  const { host } = fakeHost();
  const { env, capture } = fakeAudio();
  env.navigator.mediaDevices.getUserMedia = async () => ({
    getTracks: () => [{ stop() { capture.tracksStopped++; } }],
    getAudioTracks: () => [{ getSettings: () => ({ autoGainControl: true }) }],
  });
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await assert.rejects(voice.start());
  assert.equal(capture.tracksStopped, 1);
  assert.equal(capture.processor, null);
  assert.equal(voice.state.get().phase, 'idle');
});


test('invalid attachment replies never become a user instruction', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const request = host.requestProfile;
  host.requestProfile = (...args) => args[1] === 'file.attach'
    ? Promise.resolve({ attached: true, ref_text: 'unexpected server text' }) : request(...args);
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await voice.start(); feed(capture);
  await assert.rejects(voice.send());
  assert.equal(calls.some(([name]) => name === 'submit'), false);
  assert.equal(voice.state.get().phase, 'ready');
});


test('a queued callback from a cancelled capture cannot enter the next recording', async () => {
  const { host } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await voice.start();
  const oldCallback = capture.processor.onaudioprocess;
  voice.cancel();
  await voice.start();
  oldCallback({ inputBuffer: { numberOfChannels: 2, getChannelData: () => new Float32Array([0.25]) } });
  try { assert.equal(voice.chunks.length, 0); }
  finally { voice.cancel(); }
});


test('the window warns before discarding a pending voice recording and removes the warning on disable', async () => {
  const { host } = fakeHost();
  const { env } = fakeAudio();
  const listeners = new Map();
  env.addEventListener = (name, fn) => listeners.set(name, fn);
  env.removeEventListener = (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); };
  const plugin = await loadPlugin(env, { host });
  const contributions = [], cleanup = [];
  plugin.default.register({ register: value => contributions.push(value), onDispose: fn => cleanup.push(fn) });
  assert.ok(listeners.has('beforeunload'), 'Pending-recording protection is missing');
  const element = contributions[0].render();
  await findButton(element.type(element.props), 'Записать').props.onClick();
  let prevented = false;
  listeners.get('beforeunload')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  cleanup.forEach(fn => fn());
  assert.equal(listeners.has('beforeunload'), false);
});


test('an empty new chat gets a clear existing-chat requirement without opening the microphone', async () => {
  const { host, focus } = fakeHost();
  focus.live = focus.stored = null;
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await voice.start().catch(() => {});
  assert.equal(capture.constraints, null);
  assert.equal(voice.state.get().phase, 'idle');
  assert.match(voice.state.get().error, /существующий чат/);
});


test('an older SDK is refused visibly instead of installing a broken record button', async () => {
  const { host, calls } = fakeHost();
  delete host.state.focusedSessionOwner;
  const plugin = await loadPlugin({}, { host });
  const contributions = [];
  plugin.default.register({ register: c => contributions.push(c), onDispose() {} });
  assert.equal(contributions.length, 0);
  assert.ok(calls.find(([name, value]) => name === 'notify' && value.kind === 'error'));
});
