import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadPlugin } from './load-plugin.mjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const React = require('react');
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');

test('tiny meter follows captured PCM without rerendering the toolbar and disappears on cancel', async () => {
  const dom = new JSDOM('<div id="voice"></div>');
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true });
  let clock=1000, processor, voice, toolbarReads=0, stopped=0;
  class Clock extends Date { static now() { return clock; } }
  class AudioContext {
    constructor() { this.sampleRate=48000; }
    async resume() {} async close() {}
    createMediaStreamSource() { return {connect(){},disconnect(){}}; }
    createScriptProcessor() { return processor={connect(){},disconnect(){}}; }
    get destination() { return {}; }
  }
  const route={connectionId:'fixture',profile:'default'};
  const host={state:{focusedSessionId:{get:()=> 'live'},focusedStoredSessionId:{get:()=> 'stored'},focusedSessionOwner:{get:()=>route}},profileRoutes:async()=>[route],notify(){},retainProfile(){},requestProfile(){throw new Error('No backend allowed');},composer:{submit(){throw new Error('No submit allowed');}}};
  const plugin=await loadPlugin({ Date:Clock,AudioContext,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){stopped++;}}]})}} },{
    host,useValue:store=>{
      if(store===voice?.state) toolbarReads++;
      return React.useSyncExternalStore(fn=>store.subscribe(fn),()=>store.get());
    },
  },{react:React,'react/jsx-runtime':require('react/jsx-runtime')});
  const contributions=[],dispose=[];
  plugin.default.register({register:c=>contributions.push(c),onDispose:fn=>dispose.push(fn)});
  const view=contributions[0].render(); voice=view.props.voice;
  const root=createRoot(document.querySelector('#voice'));
  const feed=value=>processor.onaudioprocess({inputBuffer:{numberOfChannels:2,getChannelData:channel=>new Float32Array(channel===0?[value,-value,value,-value]:[0,0,0,0])}});
  try {
    await React.act(()=>root.render(view));
    assert.equal(document.querySelector('[role="meter"]'),null,'No decorative idle signal');
    await React.act(()=>voice.start());
    const meter=document.querySelector('[role="meter"]');
    assert.ok(meter,'Recording needs a compact live-input meter');
    assert.equal(meter.getAttribute('aria-label'),'Входной сигнал');
    assert.equal(meter.getAttribute('aria-valuenow'),'0');
    const readsBefore=toolbarReads;
    await React.act(()=>feed(0.05));
    assert.ok(Number(meter.getAttribute('aria-valuenow'))>0,'Nonzero PCM must visibly change the meter');
    const bars=[...meter.querySelectorAll('span')];
    assert.equal(bars.length,3,'Only three small strokes, not a spectrum');
    const activeScale=bars[0].style.transform;
    clock+=100;
    await React.act(()=>feed(0));
    assert.equal(meter.getAttribute('aria-valuenow'),'0','Silence must not keep a fake pulse');
    assert.notEqual(bars[0].style.transform,activeScale);
    assert.equal(toolbarReads,readsBefore,'Only the meter leaf should rerender for audio frames');
    await React.act(()=>voice.cancel());
    assert.equal(document.querySelector('[role="meter"]'),null);
    assert.equal(stopped,1);
  } finally {
    await React.act(()=>{root.unmount();dispose.forEach(fn=>fn());});
    dom.window.close();Object.assign(globalThis,previous);
  }
});
