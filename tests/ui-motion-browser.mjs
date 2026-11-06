// Real React DOM + SDK Button in Chrome; only loopback fixtures, no Hermes/provider APIs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hermes = process.env.HERMES_SOURCE_ROOT;
assert.ok(hermes, 'Set HERMES_SOURCE_ROOT to a Hermes source checkout for this opt-in UI smoke');
const require = createRequire(join(hermes, 'package.json'));
const { build } = require('esbuild');
const source = await readFile(process.env.PLUGIN_SOURCE || join(root, 'plugin.js'), 'utf8');
const out = resolve(process.env.UI_MOTION_OUT || join(root, 'evidence/ui-motion-browser'));
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(process.env.TMPDIR || join(root, 'evidence'), 'voice-ui-chrome-'));
const sdk = `
import {useSyncExternalStore} from 'react';
export {Button} from ${JSON.stringify(join(hermes, 'apps/desktop/src/components/ui/button.tsx'))};
export {Codicon} from ${JSON.stringify(join(hermes, 'apps/desktop/src/components/ui/codicon.tsx'))};
export const atom = initial => { let value = initial; const listeners = new Set(); return {get:()=>value,set:v=>{value=v;listeners.forEach(fn=>fn());},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}; };
export const useValue = store => useSyncExternalStore(store.subscribe,store.get);
export const COMPOSER_AREAS = {actions:'composer.actions'};
const route = {connectionId:'fixture',profile:'default'};
export const control = {phase:()=>{},sends:[],formSubmits:0,offline:true};
export const host = {
 state:{focusedSessionId:{get:()=> 'live'},focusedStoredSessionId:{get:()=> 'stored'},focusedSessionOwner:{get:()=> route}},
 profileRoutes:()=>new Promise(resolve=>{control.grantRoutes=()=>resolve([route]);}),
 retainProfile:()=>new Promise(resolve=>{control.finishRetain=()=>resolve(()=>{});}),
 requestProfile:async(_route,method)=>{if(method==='session.resume')return {session_id:'resumed'};if(control.offline)throw new Error('Fixture offline');return {attached:true,ref_text:'@file:attachments/ui.wav'};},
 composer:{submit:(id,text)=>{control.sends.push({id,text});return true;}},notify(){}
};`;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import plugin from 'voice-plugin';
import {control} from '@hermes/plugin-sdk';
const contributions=[],dispose=[];
plugin.register({register:c=>contributions.push(c),onDispose:fn=>dispose.push(fn)});
const element=contributions[0].render();
control.voice=element.props.voice;
control.dispose=()=>dispose.forEach(fn=>fn());
window.fixture=control;
document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();control.formSubmits++;});
createRoot(document.querySelector('#voice')).render(element);`;
const built = await build({ stdin: { contents: entry, resolveDir: hermes, loader: 'jsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'local-fixtures', setup(b) {
    b.onResolve({ filter: /^voice-plugin$/ }, () => ({ path: 'plugin', namespace: 'fixture' }));
    b.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
    // Button's unused loading branch imports an icon package absent from this checkout.
    b.onResolve({ filter: /^@\/lib\/icons$/ }, () => ({ path: 'unused-spinner', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'plugin' ? source : args.path === 'unused-spinner' ? 'export const Loader2 = () => null;' : sdk, loader: 'js', resolveDir: hermes }));
    b.onResolve({ filter: /^@\// }, args => ({ path: resolve(hermes, 'apps/desktop/src', args.path.slice(2) + (args.path === '@/lib/utils' ? '.ts' : args.path === '@/lib/icons' ? '.ts' : '')) }));
  } }] });
const styles = await readFile(join(hermes, 'apps/desktop/src/styles.css'), 'utf8');
const codiconCss = await readFile(join(root, 'node_modules/@vscode/codicons/dist/codicon.css'));
const codiconFont = await readFile(join(root, 'node_modules/@vscode/codicons/dist/codicon.ttf'));
const token = name => [...styles.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].at(-1)?.[1];
assert.ok(token('--ui-red'), 'Use a verified Hermes theme token');
const html = `<!doctype html><meta charset="utf-8"><title>Voice-note UI — local fixture</title><link rel="stylesheet" href="/codicon.css">
<style>
:root { --ui-red:${token('--ui-red')}; --ui-text-secondary:${token('--ui-text-secondary')}; --ui-text-primary:${token('--ui-text-primary')}; --ui-text-tertiary:${token('--ui-text-tertiary')}; --ui-bg-quaternary:${token('--ui-bg-quaternary')}; --chrome-action-hover:${token('--chrome-action-hover')}; }
body { margin:40px; background:#18181b; color:#eee; font:13px system-ui; }
form { width:620px; padding:20px; border:1px solid #444; border-radius:10px; }
textarea { width:100%; box-sizing:border-box; margin-bottom:16px; background:transparent; color:inherit; border:0; resize:none; }
button { font:inherit; background:transparent; color:var(--ui-text-secondary); border:0; padding:4px 10px; cursor:pointer; }
button:disabled { opacity:.5; } button:hover { background:var(--chrome-action-hover); }
#outside { margin-top:20px; transition:opacity 1s; animation:fixture-outside 3s linear infinite; }
@keyframes fixture-outside { from { opacity:.9; } to { opacity:1; } }
</style><form><textarea>Этот черновик не нужно отправлять</textarea><div id="voice"></div></form><button id="outside" type="button">Проверка изоляции CSS</button><script type="module" src="/bundle.js"></script>`;
const server = createServer((req,res) => {
  if (req.url === '/') res.writeHead(200, {'Content-Type':'text/html'}).end(html);
  else if (req.url === '/bundle.js') res.writeHead(200, {'Content-Type':'text/javascript'}).end(built.outputFiles[0].contents);
  else if (req.url === '/codicon.css') res.writeHead(200, {'Content-Type':'text/css'}).end(codiconCss);
  else if (req.url.startsWith('/codicon.ttf')) res.writeHead(200, {'Content-Type':'font/ttf'}).end(codiconFont);
  else res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--remote-debugging-port=0', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--window-size=1000,600', `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: ['ignore','ignore','pipe'] });
let stderr='', ws, nextId=0;
chrome.stderr.on('data', data => { stderr=(stderr+data).slice(-64000); });
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const pending = new Map();
async function cdp(method, params={}) {
  const id=++nextId;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function wait(expression) {
  for(let i=0;i<120;i++) { if(await evaluate(`Boolean(${expression})`)) return; await delay(50); }
  throw new Error(`Timed out: ${expression}`);
}
async function screenshot(name) {
  const shot=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(join(out,name),Buffer.from(shot.data,'base64'));
}
const reports=[];
const watchdog=setTimeout(()=>{try {process.kill(-chrome.pid,'SIGKILL');} catch {}},45000);
try {
  let port;
  for(let i=0;i<100;i++) { try {port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;} catch {await delay(50);} }
  assert.ok(port,'Chrome DevTools must start');
  const targets=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id) {const p=pending.get(data.id);pending.delete(data.id);if(data.error)p.reject(new Error(JSON.stringify(data.error)));else p.resolve(data.result);}});
  await cdp('Page.enable');
  for(const motion of ['no-preference','reduce']) {
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:motion}]});
    await cdp('Page.navigate',{url});
    await wait(`window.fixture && document.querySelector('#voice button')`);
    await evaluate('document.fonts.ready.then(()=>true)');
    await evaluate(`window.primary=document.querySelector('#voice button');window.box=()=>{const r=document.querySelector('.hermes-voice-note').getBoundingClientRect(),b=primary.getBoundingClientRect();return {width:r.width,height:r.height,left:b.left,buttonWidth:b.width};}; window.idleBox=box();`);
    const idleSize=await evaluate('idleBox');
    assert.ok(idleSize.width<=112, `Idle toolbar must fit one ordinary button, got ${idleSize.width}px`);
    await screenshot(`${motion}-idle.png`);
    await evaluate('primary.click()');
    await wait(`fixture.voice.state.get().phase==='starting'`);
    assert.equal(await evaluate(`!!document.querySelector('.hermes-voice-note__dot')`),false);
    const animation=await evaluate(`(()=>{const el=primary.firstElementChild;return el?{name:getComputedStyle(el).animationName,duration:getComputedStyle(el).animationDuration}:null;})()`);
    assert.ok(animation,'Phase label must have a stable animated DOM node');
    if(motion==='no-preference') {
      assert.notEqual(animation.name,'none','State changes need a calm fade');
      assert.ok(parseFloat(animation.duration)>0 && parseFloat(animation.duration)<=0.25,'Fade must be short and calm');
    } else assert.equal(animation.name,'none','Reduced motion must disable the fade');
    await evaluate('fixture.grantRoutes()');
    await wait(`fixture.voice.state.get().phase==='recording'`);
    const recording=await evaluate(`(()=>{const dot=document.querySelector('.hermes-voice-note__dot');window.label=primary.firstElementChild;window.live=document.querySelector('[role="status"]');window.visual=document.querySelector('.hermes-voice-note__status');return {dot:dot?getComputedStyle(dot).backgroundColor:null,token:getComputedStyle(document.documentElement).getPropertyValue('--ui-red').trim(),status:live.textContent,box:box()};})()`);
    assert.ok(recording.dot && recording.dot!=='rgba(0, 0, 0, 0)','Recording dot must resolve to a visible theme red');
    assert.equal(await evaluate(`(()=>{const x=document.createElement('span');x.style.background='var(--ui-red)';document.body.append(x);const c=getComputedStyle(x).backgroundColor;x.remove();return c;})()`),recording.dot);
    assert.equal(recording.status,'Идёт запись');
    await wait(`Number(document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow'))>0`);
    const signal=await evaluate(`(()=>{const m=document.querySelector('[role="meter"]');return {value:Number(m.getAttribute('aria-valuenow')),width:m.getBoundingClientRect().width,bars:m.querySelectorAll('span').length};})()`);
    assert.ok(signal.value>0 && signal.value<=100, 'Real microphone frames must reach the meter');
    assert.ok(signal.width<=16 && signal.bars===3, 'Signal feedback must stay a tiny three-stroke indicator');
    const narrow=await evaluate(`(()=>{const f=document.querySelector('form');f.style.width='180px';const r=document.querySelector('.hermes-voice-note').getBoundingClientRect(),p=primary.getBoundingClientRect(),i=document.querySelector('.hermes-voice-note__info').getBoundingClientRect(),b=f.getBoundingClientRect();return {width:r.width,inside:r.right<=b.right,nonoverlap:i.right<=p.left};})()`);
    assert.ok(narrow.width<=180 && narrow.inside && narrow.nonoverlap, 'Compact controls must fit a narrow composer without overlap');
    await screenshot(`${motion}-narrow-recording.png`);
    await evaluate(`document.querySelector('form').style.width='620px'`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#voice button')].every(b=>b.getAttribute('aria-label') && b.title)`),true,'Icon actions need accessible names and hints');
    await delay(1200);
    assert.equal(await evaluate(`primary===document.querySelector('#voice button') && label===primary.firstElementChild && visual===document.querySelector('.hermes-voice-note__status') && live.textContent==='Идёт запись'`),true,'Timer must preserve DOM identity and quiet live status');
    assert.equal(await evaluate(`document.querySelector('.hermes-voice-note__status').textContent.includes('00:01')`),true,'Real timer must advance');
    await screenshot(`${motion}-recording.png`);
    await evaluate(`primary.click()`);
    await wait(`fixture.voice.state.get().phase==='sending'`);
    assert.equal(await evaluate(`!!document.querySelector('.hermes-voice-note__dot')`),false,'Dot must disappear immediately when capture stops');
    assert.equal(await evaluate('primary.disabled'),true);
    await evaluate('fixture.finishRetain()');
    await wait(`fixture.voice.state.get().phase==='ready'`);
    assert.equal(await evaluate(`!!document.querySelector('.hermes-voice-note__dot')`),false);
    assert.ok(await evaluate(`document.querySelector('[role="alert"]').textContent.includes('осталась')`),'Retry must retain the existing error UX');
    await screenshot(`${motion}-retry.png`);
    const dimensions=await evaluate(`({idle:idleBox,ready:box()})`);
    for(const [phase,box] of Object.entries({recording:recording.box,ready:dimensions.ready})) {
      assert.ok(box.width<=190, `${phase} controls must remain compact, got ${box.width}px`);
      assert.ok(box.height<=32, `${phase} controls must remain a single toolbar row`);
      assert.ok(box.buttonWidth>=24 && box.buttonWidth<=32, 'Active actions must be usable icon buttons');
    }
    await evaluate('fixture.offline=false;primary.click()');
    await wait(`fixture.voice.state.get().phase==='sending'`);
    await evaluate('fixture.finishRetain()');
    await wait(`fixture.voice.state.get().phase==='idle'`);
    assert.deepEqual(await evaluate('fixture.sends'),[{id:'stored',text:'@file:attachments/ui.wav'}]);
    const cancel=await evaluate(`(()=>{const b=[...document.querySelectorAll('#voice button')].find(b=>b.textContent==='Отмена');return b?{disabled:b.disabled,tabIndex:b.tabIndex,hidden:b.getAttribute('aria-hidden'),visibility:getComputedStyle(b).visibility}:null;})()`);
    assert.ok(cancel,'Cancel must remain mounted for a stable transition');
    assert.equal(cancel.disabled,true);assert.equal(cancel.tabIndex,-1);assert.equal(cancel.hidden,'true');
    await delay(250);
    await evaluate('primary.click()');
    await wait(`fixture.voice.state.get().phase==='starting'`);
    // A changed OS preference must cancel even an already-running plugin animation.
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await evaluate(`[...document.querySelectorAll('.hermes-voice-note, .hermes-voice-note *')].every(e=>{const s=getComputedStyle(e);return s.animationName==='none' && s.transitionDuration.split(',').every(d=>parseFloat(d)===0);})`),true,'Reduced motion must stop every plugin/SDK animation and transition');
    const isolation=await evaluate(`({animation:getComputedStyle(document.querySelector('#outside')).animationName,transition:getComputedStyle(document.querySelector('#outside')).transitionDuration})`);
    assert.deepEqual(isolation,{animation:'fixture-outside',transition:'1s'});
    await evaluate(`document.querySelectorAll('#voice button')[1].click()`);
    await wait(`fixture.voice.state.get().phase==='idle'`);
    assert.equal(await evaluate('fixture.formSubmits'),0);
    assert.equal(await evaluate(`document.querySelector('textarea').value`),'Этот черновик не нужно отправлять');
    assert.equal(await evaluate(`[...document.querySelectorAll('#voice button')].every(b=>b.type==='button')`),true);
    await evaluate('fixture.dispose()');
    reports.push({motion,passed:true,animation,recording,dimensions,isolation,form_submits:0,explicit_voice_submits:1});
  }
  const report={passed:true,scope:'Chrome, real React DOM and SDK Button; fixture theme/capture device/host only, not active Hermes Desktop E2E',production_plugin_sha256:createHash('sha256').update(source).digest('hex'),provider_calls:0,reports};
  await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  clearTimeout(watchdog);ws?.close();
  if(chrome.pid && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit',resolve));
    try {process.kill(-chrome.pid,'SIGTERM');} catch {}
    await exited;
  }
  await writeFile(join(out,'chrome.stderr.log'),stderr);
  await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
