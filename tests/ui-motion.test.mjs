import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadPlugin } from './load-plugin.mjs';

const require = createRequire(process.env.HERMES_SOURCE_ROOT ? resolve(process.env.HERMES_SOURCE_ROOT, 'package.json') : new URL('../package.json', import.meta.url));
const React = require('react');
const { jsx } = require('react/jsx-runtime');
const { JSDOM } = require('jsdom');

// The real React hooks/reconciler exercise the contribution, not a copied component.
test('red indicator follows actual capture, not permission, stopped audio or upload', async () => {
  const dom = new JSDOM('<div id="voice"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = require('react-dom/client');
  let grant, processor, tick, stopped = 0, closed = 0;
  const intervals = new Set();
  const route = { connectionId: 'fixture', profile: 'default' };
  const host = {
    state: { focusedSessionId: { get: () => 'live' }, focusedStoredSessionId: { get: () => 'stored' },
      focusedSessionOwner: { get: () => route } },
    profileRoutes: async () => [route], retainProfile: () => new Promise(() => {}),
    requestProfile() { throw new Error('No backend allowed'); }, composer: { submit() { throw new Error('No submit allowed'); } }, notify() {},
  };
  const stream = { getTracks: () => [{ stop() { stopped++; } }], getAudioTracks: () => [{ getSettings: () => ({}) }] };
  class AudioContext {
    constructor() { this.sampleRate = 48000; }
    async resume() {} async close() { closed++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return processor = { connect() {}, disconnect() {} }; }
    get destination() { return {}; }
  }
  const plugin = await loadPlugin({ AudioContext, navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } },
    setInterval(fn) { tick = fn; intervals.add(fn); return fn; }, clearInterval(fn) { intervals.delete(fn); },
  }, {
    host, useValue: store => React.useSyncExternalStore(callback => store.subscribe(callback), () => store.get()),
  }, { react: React, 'react/jsx-runtime': require('react/jsx-runtime') });
  const contributions = [], disposers = [];
  plugin.default.register({ register: value => contributions.push(value), onDispose: fn => disposers.push(fn) });
  const element = contributions[0].render();
  const voice = element.props.voice;
  const root = createRoot(document.querySelector('#voice'));
  const indicator = () => document.querySelector('.hermes-voice-note__dot');
  const button = () => document.querySelector('button');
  try {
    await React.act(() => root.render(jsx(element.type, element.props)));
    assert.equal(indicator(), null);
    let starting;
    await React.act(() => { starting = voice.start(); });
    assert.equal(voice.state.get().phase, 'starting');
    assert.equal(indicator(), null, 'Permission pending is not recording');
    await React.act(async () => { grant(stream); await starting; });
    assert.equal(voice.state.get().phase, 'recording');
    assert.ok(indicator(), 'Real capture needs a dedicated red indicator');
    assert.equal(indicator().getAttribute('aria-hidden'), 'true');
    assert.match(document.querySelector('style').textContent, /background:\s*var\(--ui-red\)/);
    const primary = button();
    const status = document.querySelector('[role="status"]');
    assert.equal(status.textContent, 'Идёт запись');
    const label = primary.firstChild;
    await React.act(() => tick());
    assert.equal(button(), primary, 'Timer renders must not remount controls');
    assert.equal(primary.firstChild, label, 'Timer renders must not restart label animation');
    assert.equal(document.querySelector('[role="status"]'), status);
    assert.equal(status.textContent, 'Идёт запись', 'Live region must not announce every timer tick');
    processor.onaudioprocess({ inputBuffer: { numberOfChannels: 2, getChannelData: () => new Float32Array([0, 0.25]) } });
    await React.act(() => voice.stop());
    assert.equal(indicator(), null, 'Stopped/ready audio is not recording');
    assert.equal(stopped, 1); assert.equal(closed, 1);
    assert.equal(intervals.size, 0);
    await React.act(() => { void voice.send(); });
    assert.equal(voice.state.get().phase, 'sending');
    assert.equal(indicator(), null, 'Upload is not recording');
    await React.act(() => voice.cancel());
    assert.equal(indicator(), null);
    assert.equal(button(), primary);
    assert.equal(primary.textContent, '🎙 Записать');
    for (const control of document.querySelectorAll('button')) assert.equal(control.type, 'button');
  } finally {
    await React.act(() => { root.unmount(); disposers.forEach(fn => fn()); });
    assert.equal(intervals.size, 0);
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});
