// Opt-in: actual SDK lease + native sync owner ladder/router/guard, loopback HTTP only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPlugin } from './load-plugin.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hermes = process.env.HERMES_SOURCE_ROOT;
assert.ok(hermes, 'Set HERMES_SOURCE_ROOT to a checkout containing host.retainSession');
const out = resolve(process.env.NATIVE_DELIVERY_OUT || join(root, 'evidence/native-delivery'));
await mkdir(out, { recursive: true });
const { build } = createRequire(join(hermes, 'package.json'))('esbuild');
const sdkFile = join(hermes, 'apps/desktop/src/sdk/session-request.ts');
await readFile(sdkFile); // Missing SDK is a prerequisite error, not product RED.
const controlModule = `export const control={owners:new Map(),rows:new Map(),lookups:[],pins:new Map(),calls:[],releases:[],urls:{},topology:true,profiles:[{name:'default'}],primary:'source-b',lookupFails:false};`;
const ownerModule = `import {control} from 'fixture-control';
import {resolveSessionRpcOwner} from ${JSON.stringify(join(hermes, 'apps/desktop/src/app/contrib/wiring-routing.ts'))};
export async function resolveSessionOwner(id){control.lookups.push(id);if(control.lookupFails)throw Error('Synthetic lookup outage');return resolveSessionRpcOwner({routingSessionId:id,tileOwnerRoute:()=>undefined,sessionOwnerHint:()=>undefined,sessionRowOwner:key=>control.rows.get(key),eventOwner:key=>control.owners.get(key)});}`;
const gatewayModule = `import {control} from 'fixture-control';
export const $gateway={get:()=>({request:(...args)=>requestGatewayForAgent(control.primary,'default',...args)})};
export const $activeGatewayProfile={get:()=>'default'};
export async function retainGatewayForAgent(connection,profile){const id=connection??control.primary;const key=id+'::'+profile;control.pins.set(key,(control.pins.get(key)||0)+1);let done=false;return()=>{if(done)return;done=true;control.pins.set(key,control.pins.get(key)-1);control.releases.push(key);};}
export const retainGatewayForSessionTurn=retainGatewayForAgent;
export async function requestGatewayForAgent(connection,profile,method,params){const id=connection??control.primary;if(!(control.pins.get(id+'::'+profile)>0))throw Error('Request without a retained transport');control.calls.push({connectionId:id,profile,method});const response=await fetch(control.urls[id],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})});if(!response.ok)throw Error('Synthetic HTTP transport failure');return response.json();}
export function requestGatewayForProfile(profile,...args){return requestGatewayForAgent(control.primary,profile,...args);}`;
const entry = `export {retainPluginSession} from ${JSON.stringify(sdkFile)}; export {control} from 'fixture-control';`;
const built = await build({ stdin: { contents: entry, resolveDir: hermes }, bundle: true, platform: 'node', format: 'esm', write: false, metafile: true,
  nodePaths: process.env.NODE_PATH?.split(delimiter).filter(Boolean) || [],
  plugins: [{ name: 'native-boundary-fixtures', setup(b) {
    b.onResolve({ filter: /^fixture-control$/ }, () => ({ path: 'control', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:^|\/)use-session-actions\/utils$/ }, () => ({ path: 'owner', namespace: 'fixture' }));
    b.onResolve({ filter: /^(?:@\/store\/gateway|\.\/gateway)$/ }, () => ({ path: 'gateway', namespace: 'fixture' }));
    b.onResolve({ filter: /^(?:@\/store\/profile|\.\/profile)$/ }, () => ({ path: 'profile', namespace: 'fixture' }));
    b.onResolve({ filter: /connection-registry-state$/ }, () => ({ path: 'registry', namespace: 'fixture' }));
    b.onResolve({ filter: /session-gone-latch$/ }, () => ({ path: 'rebind', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'control' ? controlModule : path === 'owner' ? ownerModule : path === 'gateway' ? gatewayModule : path === 'profile' ? `import {control} from 'fixture-control';export const $profiles={get:()=>control.profiles};export const $activeGatewayProfile={get:()=>'default'};` : path === 'registry' ? `import {control} from 'fixture-control';export const hasRegistryTopology=()=>control.topology;` : 'export const resetBackgroundPollingGuardAfterRebind=()=>{};', loader: 'js', resolveDir: hermes }));
    b.onResolve({ filter: /^@\// }, args => ({ path: resolve(hermes, 'apps/desktop/src', args.path.slice(2) + '.ts') }));
  } }] });
const bundle = join(out, 'actual-sdk-fixture.mjs');
await writeFile(bundle, built.outputFiles[0].contents);
await writeFile(join(out, 'bundle-inputs.json'), JSON.stringify(built.metafile.inputs, null, 2));
const { retainPluginSession, control } = await import(pathToFileURL(bundle));
const servers = [];
async function receiver(id) {
  const observed = { id, calls: [], uploads: [], failUpload: false };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; assert.ok(size < 1024 * 1024); chunks.push(chunk); }
      const { method, params } = JSON.parse(Buffer.concat(chunks).toString());
      observed.calls.push(method);
      if (method === 'session.resume') {
        // Both sources deliberately accept this ID: a wrong route must be caught by the test.
        assert.equal(params.session_id, 'stored-a');
        res.writeHead(200).end(JSON.stringify({ session_id: id + ':runtime-a', stored_session_id: 'stored-a' })); return;
      }
      assert.equal(method, 'file.attach'); assert.equal(params.session_id, id + ':runtime-a');
      if (observed.failUpload) { res.writeHead(503).end('Synthetic upload outage'); return; }
      const bytes = Buffer.from(params.data_url.split(',')[1], 'base64');
      assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
      observed.uploads.push(bytes);
      res.writeHead(200).end(JSON.stringify({ attached: true, ref_text: '@file:attachments/' + id + '.wav' }));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server); control.urls[id] = `http://127.0.0.1:${server.address().port}/rpc`;
  return observed;
}
const results = [];
try {
  const a = await receiver('source-a'); const b = await receiver('source-b');
  const route = { connectionId: 'source-a', profile: 'default', mode: 'remote' };
  control.owners.set('stored-a', route); control.rows.set('stored-a', 'default');
  const { VoiceNote, encodeWav } = await loadPlugin();
  const samples = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 16) / 4);
  const wav = encodeWav([[samples, new Float32Array(samples.length)]], 48000);
  const expected = Buffer.from(await wav.arrayBuffer());
  const sends = [];
  const focus = { stored: 'stored-b', owner: { connectionId: 'source-b', profile: 'default' } };
  const host = {
    state: { focusedStoredSessionId: { get: () => focus.stored }, focusedSessionOwner: { get: () => focus.owner } },
    retainSession: retainPluginSession,
    composer: { submit(id, text) { sends.push({ id, text }); return true; } },
    notify() {},
    requestProfile() { throw Error('Legacy route path must not run'); },
  };
  const voice = new VoiceNote(host);
  const recording = () => { voice.target = { stored: 'stored-a', owner: null }; voice.blob = wav; voice.update({ phase: 'ready' }); };
  recording(); await voice.send();
  assert.deepEqual(sends, [{ id: 'stored-a', text: '@file:attachments/source-a.wav' }]);
  assert.deepEqual(a.uploads[0], expected); assert.equal(b.calls.length, 0);
  assert.ok(control.lookups.every(id => id === 'stored-a'));
  assert.ok([...control.pins.values()].every(count => count === 0));
  results.push({ name: 'null public owner → real native event-owner ladder → retained source A → HTTP WAV upload → original composer queue, despite focus/primary B and colliding stored ID', passed: true });
  a.failUpload = true; recording();
  await assert.rejects(voice.send(), /Synthetic HTTP transport failure/);
  assert.equal(voice.state.get().phase, 'ready'); assert.equal(voice.blob, wav); assert.equal(sends.length, 1);
  a.failUpload = false; await voice.send();
  assert.deepEqual(a.uploads.at(-1), expected); assert.equal(sends.length, 2); assert.equal(b.calls.length, 0);
  results.push({ name: 'HTTP upload outage retains byte-identical WAV and retry returns to original source', passed: true });
  control.owners.clear(); control.rows.clear(); recording();
  const before = a.calls.length;
  await assert.rejects(voice.send(), /owner.*resolv/i);
  assert.equal(a.calls.length, before); assert.equal(b.calls.length, 0); assert.equal(voice.blob, wav);
  control.owners.set('stored-a', route); await voice.send();
  assert.equal(sends.length, 3); assert.deepEqual(a.uploads.at(-1), expected);
  assert.ok([...control.pins.values()].every(count => count === 0));
  results.push({ name: 'genuinely unresolved owner fails before HTTP; later native proof recovers the same WAV', passed: true });
  voice.cancel();
  const report = { passed: true, scope: 'Real plugin + actual SDK lease + actual native sync owner ladder, request router and ambiguity guard; native store lookup/pooled-socket I/O are controlled adapters; two real loopback HTTP receivers. Not live Windows/Electron, async REST discovery or final prompt execution.', results, plugin_sha256: createHash('sha256').update(await readFile(join(root, 'plugin.js'))).digest('hex'), sdk_module_sha256: createHash('sha256').update(await readFile(sdkFile)).digest('hex'), wav_sha256: createHash('sha256').update(expected).digest('hex'), wrong_source_calls: b.calls.length, queued_messages: sends, provider_calls: 0 };
  await writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
}
