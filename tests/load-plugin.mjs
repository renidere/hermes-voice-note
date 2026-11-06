import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadPlugin(overrides = {}, sdkOverrides = {}, moduleOverrides = {}) {
  const context = vm.createContext({
    Blob, ArrayBuffer, Uint8Array, Float32Array, Int16Array, DataView, Date,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(buffer => {
          this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
          this.onload?.();
        }).catch(error => { this.error = error; this.onerror?.(); });
      }
    },
    navigator: {}, ...overrides,
  });
  const sdk = {
    atom(initial) {
      let value = initial;
      const listeners = new Set();
      return { get: () => value, set(v) { value = v; for (const fn of listeners) fn(v); },
        subscribe(fn) { listeners.add(fn); fn(value); return () => listeners.delete(fn); } };
    },
    host: {}, COMPOSER_AREAS: { actions: 'composer.actions' }, Button: 'button',
    useValue: store => store.get(), ...sdkOverrides,
  };
  const modules = {
    '@hermes/plugin-sdk': sdk,
    'react': { useEffect() {}, useState(value) { return [value, () => {}]; } },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    ...moduleOverrides,
  };
  let source = '';
  try { source = await readFile(process.env.PLUGIN_SOURCE || new URL('../plugin.js', import.meta.url), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const module = new vm.SourceTextModule(source, { context, identifier: 'voice-note/plugin.js' });
  await module.link(name => {
    const values = modules[name];
    if (!values) throw new Error(`Unsupported plugin import: ${name}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
