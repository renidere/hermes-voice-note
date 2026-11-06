import { atom, host, Button, COMPOSER_AREAS, useValue } from '@hermes/plugin-sdk';
import { useEffect, useState } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';

export function encodeWav(chunks, sampleRate) {
  const channels = chunks[0]?.length;
  if (![1, 2].includes(channels) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('Некорректный формат записи');
  }
  let frames = 0;
  for (const chunk of chunks) {
    if (chunk.length !== channels || !chunk[0].length || chunk.some(channel => channel.length !== chunk[0].length)) {
      throw new Error('Некорректные каналы записи');
    }
    frames += chunk[0].length;
  }
  const buffer = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, buffer.byteLength - 44, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let frame = 0; frame < chunk[0].length; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = chunk[channel][frame];
        if (!Number.isFinite(sample)) throw new Error('Некорректные отсчёты записи');
        const value = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, Math.round(value * (value < 0 ? 32768 : 32767)), true);
        offset += 2;
      }
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class VoiceNote {
  constructor(host) {
    this.host = host;
    this.state = atom({ phase: 'idle', error: '', startedAt: 0 });
    this.chunks = [];
    this.generation = 0;
  }

  update(values) { this.state.set({ ...this.state.get(), ...values }); }

  async start() {
    if (this.state.get().phase !== 'idle') return;
    const generation = ++this.generation;
    const target = this.target = {
      live: this.host.state.focusedSessionId.get(),
      stored: this.host.state.focusedStoredSessionId.get(),
      owner: this.host.state.focusedSessionOwner.get(),
    };
    this.update({ phase: 'starting', error: '' });
    try {
      // shortcut: existing chats only; extend when the SDK exposes first-message attachment staging.
      if (!target.live || !target.stored) {
        this.update({ phase: 'idle', error: 'Открой существующий чат перед записью.' });
        return;
      }
      if (!target.owner) throw new Error('Не удалось определить владельца чата');
      const routes = (await this.host.profileRoutes()).filter(route =>
        route.connectionId === target.owner.connectionId && route.profile === target.owner.profile);
      if (generation !== this.generation) return;
      if (routes.length !== 1) throw new Error('Не удалось определить сервер этого чата');
      this.target.route = routes[0];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const settings = stream.getAudioTracks?.()[0]?.getSettings?.() || {};
      if (['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(key => settings[key] === true)) {
        throw new Error('Микрофон не отключил автоматическую обработку звука');
      }
      this.context = new AudioContext();
      await this.context.resume();
      if (generation !== this.generation) return;
      this.sampleRate = this.context.sampleRate;
      this.source = this.context.createMediaStreamSource(this.stream);
      // shortcut: ScriptProcessor works without a worklet asset; replace if a supported client removes it.
      this.processor = this.context.createScriptProcessor(4096, 2, 1);
      this.chunks = [];
      this.capturedBytes = 0;
      this.processor.onaudioprocess = event => {
        if (generation !== this.generation || this.state.get().phase !== 'recording') return;
        const chunk = Array.from({ length: event.inputBuffer.numberOfChannels },
          (_, channel) => new Float32Array(event.inputBuffer.getChannelData(channel)));
        this.capturedBytes += chunk[0].length * chunk.length * 2;
        if (this.capturedBytes > 64 * 1024 * 1024) { this.reachLimit(); return; }
        this.chunks.push(chunk);
      };
      this.source.connect(this.processor);
      this.processor.connect(this.context.destination);
      this.update({ phase: 'recording', startedAt: Date.now() });
      this.limitTimer = setTimeout(() => this.reachLimit(), 300000);
      this.limitTimer?.unref?.();
    } catch (error) {
      if (generation !== this.generation) return;
      this.releaseCapture();
      const message = error?.name === 'NotAllowedError'
        ? 'Нет доступа к микрофону. Разреши его использование в Windows и Hermes.'
        : 'Не удалось начать запись. Проверь микрофон и подключение к чату.';
      this.update({ phase: 'idle', error: message });
      throw error;
    }
  }

  reachLimit() {
    try { this.stop(); } catch { return; }
    this.update({ error: 'Достигнут лимит записи. Можно отправить записанное.' });
  }

  releaseCapture() {
    clearTimeout(this.limitTimer);
    if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.context?.close().catch(() => {});
    this.processor = this.source = this.stream = this.context = null;
  }

  cancel() {
    this.generation++;
    this.releaseCapture();
    this.chunks = [];
    this.blob = null;
    this.update({ phase: 'idle', error: '' });
  }

  stop() {
    if (this.state.get().phase !== 'recording') return;
    try { this.blob = encodeWav(this.chunks, this.sampleRate); }
    catch (error) {
      this.update({ phase: 'idle', error: 'В записи пока нет звука. Попробуй записать ещё раз.' });
      throw error;
    }
    finally { this.chunks = []; this.releaseCapture(); }
    this.update({ phase: 'ready' });
  }

  async send() {
    if (this.state.get().phase === 'sending') return;
    const generation = this.generation;
    const target = this.target;
    this.stop();
    if (!this.blob) throw new Error('В записи пока нет звука');
    this.update({ phase: 'sending', error: '' });
    let release;
    try {
      release = await this.host.retainProfile(target.route, { spawnPriority: 'foreground' });
      if (generation !== this.generation) return;
      const resumed = await this.host.requestProfile(target.route, 'session.resume', {
        session_id: target.stored, omit_messages: true,
      });
      if (generation !== this.generation) return;
      if (typeof resumed.session_id !== 'string' || !resumed.session_id) throw new Error('Чат недоступен');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Не удалось прочитать запись'));
        reader.readAsDataURL(this.blob);
      });
      if (generation !== this.generation) return;
      const uploaded = await this.host.requestProfile(target.route, 'file.attach', {
        session_id: resumed.session_id, name: `voice-${Date.now()}.wav`, data_url: dataUrl,
      }, 120000);
      if (generation !== this.generation) return;
      if (uploaded.attached !== true || typeof uploaded.ref_text !== 'string' || !uploaded.ref_text.startsWith('@file:')) {
        throw new Error('Сервер не принял аудио');
      }
      if (!this.host.composer.submit(target.stored, uploaded.ref_text)) throw new Error('Вернись в исходный чат и повтори отправку');
      this.blob = null;
      this.update({ phase: 'idle' });
      this.host.notify({ kind: 'success', message: 'Аудио передано в очередь чата' });
    } catch (error) {
      if (generation !== this.generation) return;
      this.update({ phase: this.blob ? 'ready' : 'idle', error: 'Отправка не завершена. Запись осталась для повтора.' });
      throw error;
    } finally { release?.(); }
  }
}


function VoiceControls({ voice }) {
  const state = useValue(voice.state);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state.phase !== 'recording') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);
  const seconds = Math.max(0, Math.floor((now - state.startedAt) / 1000));
  const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const status = state.phase === 'recording' ? elapsed
    : state.phase === 'starting' ? 'Доступ к микрофону…'
    : state.phase === 'sending' ? 'Отправка…'
    : state.phase === 'ready' ? 'Запись готова' : '';
  const idle = state.phase === 'idle';
  return jsxs('div', { className: 'hermes-voice-note', 'data-phase': state.phase, children: [
    jsx('style', { children: `
      .hermes-voice-note { display:grid; grid-template-columns:minmax(0,1fr) 104px 64px; align-items:center; gap:6px; width:340px; max-width:100%; min-height:32px; }
      .hermes-voice-note .hermes-voice-note__info { display:grid; min-width:0; color:var(--ui-text-secondary); font-variant-numeric:tabular-nums; }
      .hermes-voice-note .hermes-voice-note__status, .hermes-voice-note .hermes-voice-note__error { grid-area:1/1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hermes-voice-note .hermes-voice-note__dot { display:inline-block; width:7px; height:7px; margin-right:6px; border-radius:50%; background:var(--ui-red); }
      .hermes-voice-note .hermes-voice-note__label, .hermes-voice-note .hermes-voice-note__error { animation:hermes-voice-note-fade 160ms ease-out; }
      .hermes-voice-note button { min-width:0; transition:opacity 160ms ease, background-color 160ms ease, color 160ms ease; }
      .hermes-voice-note .hermes-voice-note__cancel { transition:opacity 160ms ease, visibility 160ms; }
      .hermes-voice-note[data-phase="idle"] .hermes-voice-note__cancel { opacity:0; visibility:hidden; pointer-events:none; }
      .hermes-voice-note .hermes-voice-note__sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
      @keyframes hermes-voice-note-fade { from { opacity:0; } to { opacity:1; } }
      @media (prefers-reduced-motion:reduce) {
        .hermes-voice-note, .hermes-voice-note *, .hermes-voice-note *::before, .hermes-voice-note *::after { animation:none !important; transition:none !important; }
      }
    ` }),
    jsxs('span', { className: 'hermes-voice-note__info', children: [
      jsx('span', { role: 'status', className: 'hermes-voice-note__sr', children: state.phase === 'recording' ? 'Идёт запись' : status }),
      jsxs('span', { className: 'hermes-voice-note__status', 'aria-hidden': true, style: { visibility: state.error ? 'hidden' : undefined }, children: [
        state.phase === 'recording' && jsx('span', { className: 'hermes-voice-note__dot', 'aria-hidden': true }),
        jsx('span', { className: 'hermes-voice-note__label', children: status }, state.phase),
      ] }),
      state.error && jsx('span', { role: 'alert', title: state.error, className: 'hermes-voice-note__error', children: state.error }),
    ] }),
    jsx(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: !['idle', 'recording', 'ready'].includes(state.phase),
      onClick: () => (voice.state.get().phase === 'idle' ? voice.start() : voice.send()).catch(() => {}),
      children: jsx('span', { className: 'hermes-voice-note__label', children: idle ? '🎙 Записать' : 'Отправить' }, idle ? 'record' : 'send') }),
    jsx(Button, { type: 'button', variant: 'ghost', size: 'sm', className: 'hermes-voice-note__cancel',
      disabled: idle, tabIndex: idle ? -1 : undefined, 'aria-hidden': idle, inert: idle,
      onClick: () => voice.cancel(), children: 'Отмена' }),
  ] });
}

export default {
  id: 'hermes-voice-note',
  name: 'Голосовые сообщения',
  description: 'Записать WAV и отправить в этот чат без предварительного распознавания.',
  register(ctx) {
    if (!host.state?.focusedSessionOwner?.get || !host.profileRoutes || !host.requestProfile || !host.retainProfile || !host.composer?.submit) {
      host.notify({ kind: 'error', message: 'Голосовые сообщения: нужен Hermes Desktop с поддержкой адресной маршрутизации плагинов.' });
      return;
    }
    const voice = new VoiceNote(host);
    ctx.register({ id: 'record', area: COMPOSER_AREAS.actions, render: () => jsx(VoiceControls, { voice }) });
    const beforeUnload = event => {
      if (voice.state.get().phase === 'idle') return;
      event.preventDefault();
      event.returnValue = '';
    };
    globalThis.addEventListener?.('beforeunload', beforeUnload);
    ctx.onDispose(() => { globalThis.removeEventListener?.('beforeunload', beforeUnload); voice.cancel(); });
  },
};
