// Opt-in Linux smoke: real Chromium capture, fake microphone, fixture SDK; no model/provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, process.env.BROWSER_SMOKE_OUT || 'evidence/browser-smoke');
await mkdir(out, { recursive: true });
const source = await readFile(join(root, 'plugin.js'));
const profile = await mkdtemp(join(process.env.TMPDIR || join(root, 'evidence'), 'voice-note-chrome-'));
const sampleRate = 48000, frames = sampleRate * 3;
const fixture = Buffer.alloc(44 + frames * 4);
fixture.write('RIFF'); fixture.writeUInt32LE(fixture.length - 8, 4); fixture.write('WAVE', 8);
fixture.write('fmt ', 12); fixture.writeUInt32LE(16, 16); fixture.writeUInt16LE(1, 20);
fixture.writeUInt16LE(2, 22); fixture.writeUInt32LE(sampleRate, 24); fixture.writeUInt32LE(sampleRate * 4, 28);
fixture.writeUInt16LE(4, 32); fixture.writeUInt16LE(16, 34); fixture.write('data', 36);
fixture.writeUInt32LE(frames * 4, 40);
for (let i = 0; i < frames; i++) fixture.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 8192), 44 + i * 4);
const fixturePath = join(profile, 'fake-microphone.wav');
await writeFile(fixturePath, fixture);
let resolveResult;
const finished = new Promise(resolve => { resolveResult = resolve; });
const requests = [];
const sdk = `export const atom = initial => { let v = initial; return { get: () => v, set: n => { v = n; } }; };\nexport const host = {}; export const Button = 'button'; export const COMPOSER_AREAS = {actions:'composer.actions'}; export const useValue = a => a.get();`;
const react = 'export const useEffect = () => {}; export const useState = v => [v, () => {}];';
const jsx = 'export const jsx = (type, props) => ({type,props}); export const jsxs = jsx;';
const page = `<!doctype html><meta charset="utf-8"><title>Voice note capture smoke</title>
<script type="importmap">{"imports":{"@hermes/plugin-sdk":"/sdk.js","react":"/react.js","react/jsx-runtime":"/jsx.js"}}</script>
<script type="module">
import {VoiceNote} from '/plugin.js';
const route = {connectionId:'fixture-backend',mode:'remote',profile:'default',targetProfile:'default'};
const state = {focusedSessionId:{get:()=> 'fixture-live'},focusedStoredSessionId:{get:()=> 'fixture-stored'},focusedSessionOwner:{get:()=>({connectionId:'fixture-backend',profile:'default'})}};
const sends = [];
const host = {state,profileRoutes:async()=>[route],retainProfile:async()=>()=>{},notify:()=>{},
 requestProfile: async (route, method, params) => {const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({route,method,params})});if(!r.ok)throw new Error(await r.text());return r.json();},
 composer:{submit:(id,text)=>{sends.push({id,text});return true;}}};
const voice = new VoiceNote(host);
try {
 await voice.start();
 const settings = voice.stream.getAudioTracks()[0].getSettings();
 await new Promise(resolve=>setTimeout(resolve,1250));
 await voice.send();
 const result={passed:true,settings,sends,phase:voice.state.get().phase};
 await fetch('/result',{method:'POST',body:JSON.stringify(result)});
} catch(error) { voice.cancel(); await fetch('/result',{method:'POST',body:JSON.stringify({passed:false,error:String(error),state:voice.state.get()})}); }
</script>`;
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      const paths = { '/': ['text/html', page], '/plugin.js': ['text/javascript', source], '/sdk.js': ['text/javascript', sdk], '/react.js': ['text/javascript', react], '/jsx.js': ['text/javascript', jsx] };
      const entry = paths[req.url];
      if (!entry) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': entry[0] }).end(entry[1]); return;
    }
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Fixture request too large'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/result') { res.writeHead(200).end('ok'); resolveResult(body); return; }
    assert.equal(req.url, '/rpc');
    assert.equal(body.route.connectionId, 'fixture-backend');
    requests.push(body.method);
    if (body.method === 'session.resume') {
      assert.equal(body.params.session_id, 'fixture-stored');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ session_id: 'fixture-resumed' })); return;
    }
    assert.equal(body.method, 'file.attach');
    assert.equal(body.params.session_id, 'fixture-resumed');
    assert.equal(body.params.path, undefined);
    assert.match(body.params.data_url, /^data:audio\/wav;base64,/);
    const audio = Buffer.from(body.params.data_url.split(',')[1], 'base64');
    await writeFile(join(out, 'recorded.wav'), audio);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ attached: true, ref_text: '@file:attachments/browser-smoke.wav' }));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixturePath}`,
  '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, url];
let chrome, timer, stderr = '';
try {
  chrome = spawn(process.env.CHROME_BIN || 'google-chrome', args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-64000); });
  const result = await Promise.race([finished, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Chromium capture timed out')), 25000);
    chrome.once('error', reject); chrome.once('exit', code => reject(new Error(`Chromium exited ${code}`)));
  })]);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.phase, 'idle');
  assert.deepEqual(result.sends, [{ id: 'fixture-stored', text: '@file:attachments/browser-smoke.wav' }]);
  assert.deepEqual(requests, ['session.resume', 'file.attach']);
  const audio = await readFile(join(out, 'recorded.wav'));
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
  assert.equal(audio.readUInt16LE(22), 2);
  assert.ok(audio.length > 44);
  let active = 0;
  for (let i = 44; i < audio.length; i += 2) if (audio.readInt16LE(i)) active++;
  assert.ok(active > 1000, 'Fake microphone must produce real nonzero PCM');
  const probe = spawnSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', join(out, 'recorded.wav')], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const decoded = spawnSync('/usr/bin/ffmpeg', ['-v', 'error', '-i', join(out, 'recorded.wav'), '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
  const report = { ...result, scope: 'Real Chromium getUserMedia/WebAudio, fake microphone, fixture SDK and HTTP receiver; not native Windows/Desktop E2E',
    production_plugin_sha256: createHash('sha256').update(source).digest('hex'),
    audio_sha256: createHash('sha256').update(audio).digest('hex'), audio_bytes: audio.length, nonzero_pcm_samples: active,
    requests, ffprobe: JSON.parse(probe.stdout), full_decode_exit: decoded.status, provider_calls: 0 };
  await writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(timer);
  if (chrome?.pid) { try { process.kill(-chrome.pid, 'SIGTERM'); } catch {} }
  await writeFile(join(out, 'chrome.stderr.log'), stderr);
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
