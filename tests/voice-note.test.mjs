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
    retainSession: async (stored, capturedOwner) => {
      assert.equal(stored, 'stored-a');
      const owner = capturedOwner ?? route;
      const routes = (await host.profileRoutes()).filter(r => r.connectionId === owner.connectionId && r.profile === owner.profile);
      if (routes.length !== 1) throw new Error('Fixture native owner is unresolved');
      const release = await host.retainProfile(routes[0], { spawnPriority: 'foreground' });
      return { request: (...args) => host.requestProfile(routes[0], ...args), release };
    },
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

test('an existing chat can record without a live runtime and sends to its captured owner', async () => {
  const { host, focus, calls, route } = fakeHost();
  focus.live = null;
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start();
    assert.equal(voice.state.get().phase, 'recording');
    assert.equal(calls.length, 0, 'Recording must not wake the backend');
    feed(capture);
    focus.live = 'live-b';
    focus.stored = 'stored-b';
    focus.owner = { connectionId: 'other-backend', profile: 'other' };
    await voice.send();
    const resume = calls.find(([name]) => name === 'session.resume');
    assert.equal(resume[1].session_id, 'stored-a');
    assert.equal(resume[2], route);
    assert.equal(calls.find(([name]) => name === 'file.attach')[2], route);
    assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
  } finally { voice.cancel(); }
});


test('native session transport sends a recording with no owner snapshot to its original chat', async () => {
  const { host, focus, calls, route } = fakeHost();
  focus.live = null; focus.owner = null;
  const routed = host.requestProfile;
  host.retainSession = async (stored, capturedOwner) => {
    assert.equal(stored, 'stored-a');
    assert.equal(capturedOwner, null);
    calls.push(['retainSession', stored]);
    return { request: (...args) => routed(route, ...args), release: () => calls.push(['release']) };
  };
  host.profileRoutes = host.retainProfile = host.requestProfile = async () => { throw new Error('Legacy routing must not run'); };
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start(); feed(capture);
    assert.equal(calls.length, 0, 'Native routing must wait for explicit Send');
    focus.stored = 'stored-b'; focus.owner = { connectionId: 'other-backend', profile: 'other' };
    await voice.send();
    assert.deepEqual(calls.find(([name]) => name === 'retainSession'), ['retainSession', 'stored-a']);
    assert.equal(calls.find(([name]) => name === 'session.resume')[1].session_id, 'stored-a');
    assert.equal(calls.find(([name]) => name === 'file.attach')[2], route);
    assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
    assert.equal(calls.filter(([name]) => name === 'release').length, 1);
    assert.equal(voice.state.get().phase, 'idle');
    assert.equal(voice.blob, null);
  } finally { voice.cancel(); }
});


test('native owner lookup failure keeps exact WAV bytes and retries the original session', async () => {
  const { host, focus, calls, route } = fakeHost();
  focus.owner = null;
  const routed = host.requestProfile;
  let offline = false;
  host.retainSession = async (stored, owner) => {
    assert.equal(stored, 'stored-a'); assert.equal(owner, null);
    if (offline) throw new Error('private-native-lookup-failure');
    return { request: (...args) => routed(route, ...args), release: () => calls.push(['release']) };
  };
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start(); feed(capture); await voice.send();
    assert.equal(calls.filter(([name]) => name === 'submit').length, 1, 'Healthy native delivery must work before the fault');
    calls.length = 0; offline = true;
    await voice.start(); feed(capture);
    await assert.rejects(voice.send(), /private-native-lookup-failure/);
    const wav = Buffer.from(await voice.blob.arrayBuffer());
    assert.equal(voice.state.get().phase, 'ready');
    assert.equal(calls.some(([name]) => name === 'file.attach' || name === 'submit'), false);
    assert.doesNotMatch(voice.state.get().error, /private-/);
    offline = false; focus.stored = 'stored-b';
    await voice.send();
    const upload = calls.find(([name]) => name === 'file.attach');
    assert.deepEqual(Buffer.from(upload[1].data_url.split(',')[1], 'base64'), wav);
    assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
  } finally { voice.cancel(); }
});


test('a cancelled native lookup releases its late lease without touching a newer recording', async () => {
  const { host, focus, calls, route } = fakeHost();
  focus.owner = null;
  const routed = host.requestProfile;
  let finish;
  host.retainSession = () => new Promise(resolve => { finish = resolve; });
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start(); feed(capture);
    const sending = voice.send();
    await new Promise(resolve => setImmediate(resolve));
    voice.cancel(); focus.stored = 'stored-b';
    await voice.start(); feed(capture);
    finish({ request: (...args) => routed(route, ...args), release: () => calls.push(['release']) });
    await sending;
    assert.equal(voice.state.get().phase, 'recording');
    assert.ok(voice.chunks.length);
    assert.deepEqual(calls, [['release']]);
  } finally { voice.cancel(); }
});


test('native transport keeps a known captured owner rather than resolving the new focus', async () => {
  const { host, focus, calls, route } = fakeHost();
  const routed = host.requestProfile;
  host.retainSession = async (stored, owner) => {
    assert.equal(stored, 'stored-a');
    assert.deepEqual(structuredClone(owner), { connectionId: 'fixture-backend', profile: 'default' });
    return { request: (...args) => routed(route, ...args), release: () => calls.push(['release']) };
  };
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start(); feed(capture);
    focus.owner.connectionId = 'other-backend'; focus.stored = 'stored-b';
    await voice.send();
    assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
  } finally { voice.cancel(); }
});


test('native composer refusal keeps the WAV until the original composer accepts a retry', async () => {
  const { host, focus, calls, route } = fakeHost();
  focus.owner = null;
  const routed = host.requestProfile;
  host.retainSession = async (stored, owner) => {
    assert.equal(stored, 'stored-a'); assert.equal(owner, null);
    return { request: (...args) => routed(route, ...args), release: () => calls.push(['release']) };
  };
  const submit = host.composer.submit;
  let blocked = false;
  host.composer.submit = (...args) => blocked ? false : submit(...args);
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start(); feed(capture); await voice.send();
    assert.equal(calls.filter(([name]) => name === 'submit').length, 1, 'Healthy composer must accept before injecting refusal');
    calls.length = 0; blocked = true;
    await voice.start(); feed(capture);
    await assert.rejects(voice.send(), /исходный чат/i);
    const wav = voice.blob;
    assert.ok(wav.size > 44);
    assert.equal(voice.state.get().phase, 'ready');
    assert.match(voice.state.get().error, /ввод.*доступ/);
    assert.equal(calls.some(([name]) => name === 'submit'), false);
    assert.equal(calls.filter(([name]) => name === 'release').length, 1);
    blocked = false;
    await voice.send();
    assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
    const uploaded = calls.filter(([name]) => name === 'file.attach').at(-1);
    assert.deepEqual(Buffer.from(uploaded[1].data_url.split(',')[1], 'base64'), Buffer.from(await wav.arrayBuffer()));
    assert.equal(voice.blob, null);
  } finally { voice.cancel(); }
});


test('microphone capture starts even when the chat owner is temporarily unavailable', async () => {
  const { host, focus, calls } = fakeHost();
  focus.owner = null;
  host.profileRoutes = async () => { throw new Error('Route inventory must not run during capture'); };
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start();
    assert.equal(voice.state.get().phase, 'recording');
    feed(capture);
    assert.ok(voice.chunks.length);
    assert.deepEqual(calls, []);
  } finally { voice.cancel(); }
  assert.equal(capture.tracksStopped, 1);
});


test('route failure happens only on Send and retains the WAV for a successful retry', async () => {
  const { host, calls, route } = fakeHost();
  let routesRead = 0;
  host.profileRoutes = async () => { routesRead++; throw new Error('Route inventory offline'); };
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start();
    assert.equal(voice.state.get().phase, 'recording');
    assert.equal(routesRead, 0);
    feed(capture);
    await assert.rejects(voice.send(), /Route inventory offline/);
    const recorded = Buffer.from(await voice.blob.arrayBuffer());
    assert.equal(voice.state.get().phase, 'ready');
    assert.equal(capture.tracksStopped, 1);
    assert.equal(routesRead, 1);
    assert.equal(calls.some(([name]) => name === 'submit' || name === 'file.attach'), false);
    host.profileRoutes = async () => [route];
    await voice.send();
    const uploaded = calls.find(([name]) => name === 'file.attach');
    assert.deepEqual(Buffer.from(uploaded[1].data_url.split(',')[1], 'base64'), recorded);
    assert.equal(calls.filter(([name]) => name === 'submit').length, 1);
  } finally { voice.cancel(); }
});


test('delivery reports the failing stage and preserves the recording without guessing a server', async () => {
  const cases = [
    { setup(host, focus) { focus.owner = null; host.retainSession = async () => { throw new Error('private-owner-failure'); }; }, message: /подключить исходный чат/i },
    { setup(host) { host.profileRoutes = async () => { throw new Error('private-route-failure'); }; }, message: /подключить исходный чат/i },
    { setup(host) { host.profileRoutes = async () => []; }, message: /подключить исходный чат/i },
    { setup(host) { host.retainProfile = async () => { throw new Error('private-connect-failure'); }; }, message: /подключить исходный чат/i },
    { setup(host) { host.requestProfile = async () => { throw new Error('private-resume-failure'); }; }, message: /открыть исходный чат/i },
  ];
  for (const scenario of cases) {
    const { host, focus, calls } = fakeHost();
    scenario.setup(host, focus);
    const { env, capture } = fakeAudio();
    const voice = new (await loadPlugin(env)).VoiceNote(host);
    try {
      await voice.start(); feed(capture);
      await assert.rejects(voice.send());
      assert.equal(voice.state.get().phase, 'ready');
      assert.ok(voice.blob.size > 44);
      assert.match(voice.state.get().error, scenario.message);
      assert.match(voice.state.get().error, /запись сохранена/i);
      assert.equal(voice.state.get().error.includes('private-'), false);
      assert.equal(calls.some(([name]) => name === 'file.attach' || name === 'submit'), false);
      assert.equal(capture.tracksStopped, 1);
    } finally { voice.cancel(); }
  }
});


test('capture failures identify the microphone stage without mentioning the server', async () => {
  const cases = [
    { name: 'NotAllowedError', message: /нет доступа к микрофону/i },
    { name: 'NotFoundError', message: /микрофон не найден/i },
    { name: 'NotReadableError', message: /микрофон занят или недоступен/i },
    { dsp: true, message: /не отключил автоматическую обработку/i },
    { context: true, message: /настроить запись с микрофона/i },
  ];
  for (const scenario of cases) {
    const { host, calls } = fakeHost();
    const { env } = fakeAudio();
    if (scenario.name) env.navigator.mediaDevices.getUserMedia = async () => {
      const error = new Error('private-device-detail'); error.name = scenario.name; throw error;
    };
    if (scenario.dsp) env.navigator.mediaDevices.getUserMedia = async () => ({
      getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ getSettings: () => ({ autoGainControl: true }) }],
    });
    if (scenario.context) env.AudioContext.prototype.createMediaStreamSource = () => { throw new Error('private-device-detail'); };
    const voice = new (await loadPlugin(env)).VoiceNote(host);
    await assert.rejects(voice.start());
    assert.equal(voice.state.get().phase, 'idle');
    assert.match(voice.state.get().error, scenario.message);
    assert.doesNotMatch(voice.state.get().error, /сервер|подключение к чату|private-/i);
    assert.equal(calls.filter(([name, value]) => name === 'notify' && value.kind === 'error').length, 1);
    voice.cancel();
  }
});


test('a refreshed or renamed chat cannot mutate the captured delivery owner', async () => {
  const { host, focus, calls, route } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  try {
    await voice.start(); feed(capture);
    focus.owner.connectionId = 'other-source';
    focus.owner.profile = 'other-profile';
    await voice.send();
    assert.equal(calls.find(([name]) => name === 'session.resume')[2], route);
    assert.deepEqual(calls.find(([name]) => name === 'submit'), ['submit', 'stored-a', '@file:attachments/voice.wav']);
  } finally { voice.cancel(); }
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
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  env.AudioContext.prototype.createMediaStreamSource = () => { throw new Error('device lost'); };
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await assert.rejects(voice.start(), /device lost/);
  assert.equal(capture.tracksStopped, 1);
  assert.equal(capture.contextClosed, 1);
  assert.equal(voice.state.get().phase, 'idle');
  assert.match(voice.state.get().error, /микрофон/i);
  assert.deepEqual(structuredClone(calls), [['notify', { kind: 'error', message: voice.state.get().error }]]);
});


test('sending before the first audio frame stops capture instead of leaving a stuck recorder', async () => {
  const { host, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const voice = new (await loadPlugin(env)).VoiceNote(host);
  await voice.start();
  await assert.rejects(voice.send());
  assert.equal(voice.state.get().phase, 'idle');
  assert.equal(capture.tracksStopped, 1);
  assert.deepEqual(structuredClone(calls), [['notify', { kind: 'error', message: voice.state.get().error }]]);
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
  assert.deepEqual(structuredClone(calls), [['notify', { kind: 'error', message: voice.state.get().error }]]);
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


test('record errors notify outside the composer without leaking raw failures', async () => {
  const { host, focus, calls } = fakeHost();
  const { env, capture } = fakeAudio();
  const plugin = await loadPlugin(env, { host });
  const contributions = [], cleanup = [];
  plugin.default.register({ register: value => contributions.push(value), onDispose: fn => cleanup.push(fn) });
  const element = contributions[0].render();
  const voice = element.props.voice;
  const click = label => findButton(element.type(element.props), label).props.onClick();
  const expectError = () => {
    assert.deepEqual(structuredClone(calls.filter(([name]) => name === 'notify')), [['notify', { kind: 'error', message: voice.state.get().error }]]);
    assert.ok(calls.every(([name]) => ['notify', 'release'].includes(name)));
    assert.ok(voice.state.get().error);
    assert.equal(voice.state.get().error.includes('private-raw-failure'), false);
    calls.length = 0;
  };
  try {
    focus.stored = null;
    await click('Записать');
    assert.equal(capture.constraints, null);
    expectError();
    focus.stored = 'stored-a';
    const getUserMedia = env.navigator.mediaDevices.getUserMedia;
    env.navigator.mediaDevices.getUserMedia = async () => {
      const error = new Error('private-raw-failure'); error.name = 'NotAllowedError'; throw error;
    };
    await click('Записать');
    assert.match(voice.state.get().error, /Нет доступа к микрофону/);
    expectError();
    env.navigator.mediaDevices.getUserMedia = getUserMedia;
    await click('Записать'); feed(capture);
    host.requestProfile = async () => { throw new Error('private-raw-failure'); };
    await click('Отправить');
    assert.equal(voice.state.get().phase, 'ready');
    assert.ok(voice.blob.size > 44);
    assert.equal(capture.tracksStopped, 1);
    expectError();
    voice.cancel();
    assert.deepEqual(calls, [], 'Clearing an error must not notify again');
  } finally { cleanup.forEach(fn => fn()); }
});


test('a stopped recording is labelled for sending, not as a completed delivery', async () => {
  const { host } = fakeHost();
  const { env, capture } = fakeAudio();
  const plugin = await loadPlugin(env, { host });
  const contributions = [], cleanup = [];
  plugin.default.register({ register: c => contributions.push(c), onDispose: fn => cleanup.push(fn) });
  const element = contributions[0].render();
  const voice = element.props.voice;
  try {
    await voice.start(); feed(capture); voice.stop();
    const text = textContent(element.type(element.props));
    assert.match(text, /К отправке/);
    assert.doesNotMatch(text, /Готово/);
    assert.ok(voice.blob.size > 44);
  } finally { cleanup.forEach(fn => fn()); }
});


test('a legacy routing SDK without native acceptance support is refused before recording', async () => {
  const { host, calls } = fakeHost();
  delete host.retainSession;
  const plugin = await loadPlugin({}, { host });
  const contributions = [];
  plugin.default.register({ register: c => contributions.push(c), onDispose() {} });
  assert.equal(contributions.length, 0);
  assert.ok(calls.find(([name, value]) => name === 'notify' && value.kind === 'error'));
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
