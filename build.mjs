// Dependency-free bundler: transpiles TypeScript with the compiler API, resolves relative imports into one IIFE,
// and inlines CSS and candle data into a single HTML file.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); } catch { ts = require(process.env.TS_PATH || '/home/claude/.npm-global/lib/node_modules/typescript'); }
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(root, 'src/ui/app.ts');
const mods = new Map(); // abs path -> {id, code}
const order = [];

function resolve(from, spec) {
  const p = path.resolve(path.dirname(from), spec.replace(/\.js$/, '.ts'));
  if (!fs.existsSync(p)) throw new Error(`Cannot resolve ${spec} from ${from}`);
  return p;
}
function visit(file) {
  if (mods.has(file)) return mods.get(file);
  const m = { id: mods.size, deps: {}, code: '' };
  mods.set(file, m);
  const src = fs.readFileSync(file, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: false },
    fileName: file,
  }).outputText;
  const re = /require\("([^"]+)"\)/g;
  let x;
  while ((x = re.exec(out))) m.deps[x[1]] = visit(resolve(file, x[1])).id;
  m.code = out;
  order.push(m);
  return m;
}
visit(entry);
const body = order
  .map((m) => `${m.id}:[function(exports,require){${m.code}\n},${JSON.stringify(m.deps)}]`)
  .join(',\n');
const js = `(function(){var D={${body}};var C={};function load(i){if(C[i])return C[i].exports;var m=C[i]={exports:{}};var d=D[i];d[0](m.exports,function(s){return load(d[1][s]);});return m.exports;}load(${mods.get(entry).id});})();`;
const css = fs.readFileSync(path.join(root, 'src/ui/style.css'), 'utf8');
const data = fs.readFileSync(path.join(root, 'data/candles.json'), 'utf8').trim();
let html = fs.readFileSync(path.join(root, 'src/index.template.html'), 'utf8');
html = html.replace('/*CSS*/', () => css).replace('/*DATA*/', () => data).replace('/*JS*/', () => js.replace(/<\/script/gi, '<\\/script'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), html);
// Installable-app files, served next to index.html by the Python server.
const ver = String(html.length) + '-' + Date.now().toString(36);
fs.writeFileSync(path.join(root, 'dist/sw.js'), fs.readFileSync(path.join(root, 'src/sw.js'), 'utf8').replace('__V__', ver));
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) fs.copyFileSync(path.join(root, 'src', f), path.join(root, 'dist', f));
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
