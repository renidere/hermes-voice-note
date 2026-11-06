import { atom, host, Button, Codicon, COMPOSER_AREAS, useValue } from '@hermes/plugin-sdk';
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
    this.level = atom(0);
    this.levelAt = -Infinity;
    this.chunks = [];
    this.generation = 0;
  }

  update(values) { this.state.set({ ...this.state.get(), ...values }); }

  async start() {
    if (this.state.get().phase !== 'idle') return;
    this.level.set(0);
    this.levelAt = -Infinity;
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
        const now = Date.now();
        if (now - this.levelAt < 100) return;
        this.levelAt = now;
        let level = 0;
        for (const channel of chunk) {
          let sum = 0;
          for (const sample of channel) sum += sample * sample;
          const rms = Math.sqrt(sum / channel.length);
          if (Number.isFinite(rms)) level = Math.max(level, rms);
        }
        this.level.set(Math.min(1, level));
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
    this.level.set(0);
    this.levelAt = -Infinity;
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
    : state.phase === 'starting' ? 'Микрофон…'
    : state.phase === 'sending' ? 'Отправка…'
    : state.phase === 'ready' ? 'Готово' : '';
  const idle = state.phase === 'idle';
  return jsxs('div', { className: 'hermes-voice-note', 'data-phase': state.phase, children: [
    jsx('style', { children: `
      .hermes-voice-note { position:relative; display:inline-flex; align-items:center; gap:4px; width:max-content; max-width:100%; min-height:28px; }
      .hermes-voice-note .hermes-voice-note__info { display:flex; align-items:center; gap:6px; width:80px; min-width:0; color:var(--ui-text-secondary); font-variant-numeric:tabular-nums; }
      .hermes-voice-note .hermes-voice-note__status { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
      .hermes-voice-note .hermes-voice-note__dot { flex:none; width:6px; height:6px; border-radius:50%; background:var(--ui-red); }
      .hermes-voice-note .hermes-voice-note__meter { display:inline-flex; flex:none; align-items:center; gap:2px; width:14px; height:12px; color:var(--ui-text-secondary); }
      .hermes-voice-note .hermes-voice-note__meter span { display:block; width:2px; border-radius:1px; background:currentColor; transition:transform 100ms linear, opacity 100ms linear; }
      .hermes-voice-note .hermes-voice-note__label, .hermes-voice-note .hermes-voice-note__error { animation:hermes-voice-note-fade 160ms ease-out; }
      .hermes-voice-note button { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; min-width:0; padding:0; transition:opacity 160ms ease, background-color 160ms ease, color 160ms ease; }
      .hermes-voice-note .hermes-voice-note__label { display:inline-flex; align-items:center; gap:5px; }
      .hermes-voice-note .hermes-voice-note__cancel { animation:hermes-voice-note-fade 160ms ease-out; }
      .hermes-voice-note[data-phase="idle"] .hermes-voice-note__info, .hermes-voice-note[data-phase="idle"] .hermes-voice-note__cancel { display:none; }
      .hermes-voice-note[data-phase="idle"] .hermes-voice-note__primary { width:auto; padding:0 8px; }
      .hermes-voice-note .hermes-voice-note__error { position:absolute; bottom:calc(100% + 6px); left:0; z-index:10; width:max-content; max-width:min(260px,80vw); padding:6px 8px; border:1px solid var(--ui-stroke-secondary); border-radius:4px; background:var(--ui-bg-quaternary); color:var(--ui-text-secondary); font-size:12px; }
      .hermes-voice-note .hermes-voice-note__sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
      @keyframes hermes-voice-note-fade { from { opacity:0; } to { opacity:1; } }
      @media (prefers-reduced-motion:reduce) {
        .hermes-voice-note, .hermes-voice-note *, .hermes-voice-note *::before, .hermes-voice-note *::after { animation:none !important; transition:none !important; }
      }
    ` }),
    jsx('span', { role: 'status', className: 'hermes-voice-note__sr', children: state.phase === 'recording' ? 'Идёт запись' : status }),
    jsxs('span', { className: 'hermes-voice-note__info', children: [
      jsxs('span', { className: 'hermes-voice-note__status', 'aria-hidden':true, children: [
        state.phase === 'recording' && jsx('span', { className: 'hermes-voice-note__dot', 'aria-hidden': true }),
        jsx('span', { className: 'hermes-voice-note__label', children: status }, state.phase),
      ] }),
      state.phase === 'recording' && jsx(SignalMeter, { voice }),
    ] }),
    state.error && jsx('span', { role: 'alert', title: state.error, className: 'hermes-voice-note__error', children: state.error }),
    jsx(Button, { type: 'button', variant: 'ghost', size: idle ? 'sm' : 'icon-xs', className: 'hermes-voice-note__primary',
      title: idle ? 'Записать голосовое сообщение' : 'Отправить запись', 'aria-label': idle ? 'Записать' : 'Отправить', disabled: !['idle', 'recording', 'ready'].includes(state.phase),
      onClick: () => (voice.state.get().phase === 'idle' ? voice.start() : voice.send()).catch(() => {}),
      children: jsxs('span', { className: 'hermes-voice-note__label', children: [jsx(Codicon, { name: idle ? 'mic' : 'send', size:14 }), jsx('span', { className: idle ? undefined : 'hermes-voice-note__sr', children: idle ? 'Записать' : 'Отправить' })] }, idle ? 'record' : 'send') }),
    jsx(Button, { type: 'button', variant: 'ghost', size: 'icon-xs', className: 'hermes-voice-note__cancel', title: 'Отменить запись', 'aria-label': 'Отмена',
      disabled: idle, tabIndex: idle ? -1 : undefined, 'aria-hidden': idle, inert: idle,
      onClick: () => voice.cancel(), children: jsxs('span', { className: 'hermes-voice-note__label', children: [jsx(Codicon, { name:'close', size:14 }), jsx('span', { className:'hermes-voice-note__sr', children:'Отмена' })] }) }),
  ] });
}

function SignalMeter({ voice }) {
  const rms = useValue(voice.level);
  const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 48));
  return jsx('span', { className:'hermes-voice-note__meter', role:'meter', 'aria-label':'Входной сигнал', 'aria-valuemin':0, 'aria-valuemax':100, 'aria-valuenow':Math.round(level * 100), title:'Сигнал с микрофона',
    children:[6,12,8].map((height, index) => jsx('span', { 'aria-hidden':true, style:{ height, transform:`scaleY(${0.2 + level * 0.8})`, opacity:0.3 + level * 0.7 } }, index)) });
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
