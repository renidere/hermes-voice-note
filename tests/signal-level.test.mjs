import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlugin } from './load-plugin.mjs';

async function fixture() {
  let now = 0, processor, limit;
  const route = { connectionId: 'local', profile: 'default' };
  const host = { state: {
    focusedSessionId: { get: () => 'live' }, focusedStoredSessionId: { get: () => 'stored' },
    focusedSessionOwner: { get: () => route },
  }, profileRoutes: async () => [route] };
  const stream = { getTracks: () => [{ stop() {} }] };
  const env = {
    Date: { now: () => now },
    setTimeout(fn) { limit = fn; return 1; }, clearTimeout() {},
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    AudioContext: class {
      sampleRate = 48000;
      async resume() {} async close() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return processor = { connect() {}, disconnect() {} }; }
    },
  };
  const plugin = await loadPlugin(env);
  const voice = new plugin.VoiceNote(host);
  const event = channels => ({ inputBuffer: {
    numberOfChannels: channels.length, getChannelData: channel => channels[channel],
  } });
  return { voice, plugin, env, stream, host, event,
    time(value) { now = value; }, feed(channels) { processor.onaudioprocess(event(channels)); },
    callback: () => processor.onaudioprocess, limit: () => limit(),
  };
}

const channels = (left, right) => [new Float32Array(left), new Float32Array(right)];

test('reset lifecycle rejects late frames and leaves captured WAV bytes exact', async () => {
  const f = await fixture();
  const input = channels([0, 0.5, -1], [0, 0, 0]);
  await f.voice.start(); f.feed(input);
  const old = f.callback();
  f.voice.stop();
  assert.equal(f.voice.level.get(), 0, 'stop resets');
  assert.deepEqual(Buffer.from(await f.voice.blob.arrayBuffer()),
    Buffer.from(await f.plugin.encodeWav([input], 48000).arrayBuffer()));
  old(f.event(input)); assert.equal(f.voice.level.get(), 0);
  f.voice.cancel();
  await f.voice.start();
  old(f.event(input)); assert.equal(f.voice.level.get(), 0);
  f.feed(channels([0.5], [0]));
  assert.equal(f.voice.level.get(), 0.5, 'new recording first frame is immediate');
  f.voice.cancel(); assert.equal(f.voice.level.get(), 0, 'cancel resets');
  f.voice.level.set(0.75);
  await f.voice.start(); assert.equal(f.voice.level.get(), 0, 'start resets');
  f.feed(channels([0.5], [0])); f.limit();
  assert.equal(f.voice.level.get(), 0, 'duration limit resets');
  f.voice.cancel(); await f.voice.start(); f.feed(input);
  f.voice.capturedBytes = 64 * 1024 * 1024;
  f.feed(input); assert.equal(f.voice.level.get(), 0, 'byte limit resets');
  f.voice.cancel(); await f.voice.start();
  f.feed(channels([NaN], [0.5]));
  assert.equal(f.voice.level.get(), 0.5, 'invalid channel does not hide valid channel');
  assert.throws(() => f.voice.stop());
  assert.equal(f.voice.level.get(), 0, 'encoding failure resets');
  f.env.navigator.mediaDevices.getUserMedia = async () => { throw new Error('denied'); };
  f.voice.level.set(0.75);
  await assert.rejects(f.voice.start(), /denied/);
  assert.equal(f.voice.level.get(), 0, 'startup failure resets');
  let grant;
  f.env.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const starting = f.voice.start();
  await new Promise(resolve => setImmediate(resolve));
  f.voice.cancel(); grant(f.stream); await starting;
  assert.equal(f.voice.level.get(), 0, 'late permission cannot restore level');
});

test('publishes first frame immediately and then at most once per 100ms without smoothing PCM', async () => {
  const f = await fixture();
  await f.voice.start();
  const values = [];
  const unsubscribe = f.voice.level.subscribe(value => values.push(value));
  values.length = 0;
  try {
    for (const [time, value] of [[0, 0.5], [1, 1], [99, 1], [100, 0.25], [199, 1], [200, 0]]) {
      f.time(time); f.feed(channels([value], [0]));
    }
    assert.deepEqual(values, [0.5, 0.25, 0]);
    assert.equal(f.voice.chunks.length, 6, 'throttling must not skip captured PCM');
  } finally { unsubscribe(); f.voice.cancel(); }
});

test('level is finite clamped max-channel linear RMS, including active plus silent stereo', async () => {
  const f = await fixture();
  assert.equal(f.voice.level?.get(), 0, 'separate level atom starts at zero');
  await f.voice.start();
  const cases = [
    [channels([0, 0], [0, 0]), 0],
    [channels([0.5, -0.5], [0, 0]), 0.5],
    [channels([0, 0], [0.5, -0.5]), 0.5],
    [channels([0, 1], [0, 0]), Math.sqrt(0.5)],
    [channels([2, -2], [0, 0]), 1],
    [channels([NaN, Infinity], [0, 0]), 0],
  ];
  try {
    for (let i = 0; i < cases.length; i++) {
      f.time(i * 100);
      const [input, expected] = cases[i];
      const before = input.map(channel => Buffer.from(channel.buffer).toString('hex'));
      f.feed(input);
      assert.equal(f.voice.level.get(), expected);
      assert.deepEqual(input.map(channel => Buffer.from(channel.buffer).toString('hex')), before);
    }
  } finally { f.voice.cancel(); }
});
