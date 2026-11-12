// Builds the whole page into one self-contained file: dist/index.html
// (JS bundled by esbuild, CSS and fonts inlined, deployment details embedded).
//
//   node scripts/build-web.mjs --name arf-pup
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from './lib/testnet.mjs';

const i = process.argv.indexOf('--name');
const name = i > 0 ? process.argv[i + 1] : 'arf-pup';
const d = readJson(join(ROOT, 'deployments', name + '.json'));
if (!d) throw new Error(`no deployments/${name}.json; run scripts/deploy.mjs first`);

const config = {
  contract: d.contract,
  colony_dao: d.colony_dao,
  rpc: d.rpc,
  explorer: d.explorer,
  preset: d.preset,
  // Public by design: this key can only call `welcome_guest` on the contract.
  doorman_key: d.doorman_key,
  source: 'https://github.com/chinesepowered/hack-nearhacks2',
};

const font = (pkg, file, family, weight) => {
  const data = readFileSync(join(ROOT, 'node_modules/@fontsource', pkg, 'files', file)).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2')}`;
};
const fonts = [
  font('fredoka', 'fredoka-latin-500-normal.woff2', 'Fredoka', 500),
  font('fredoka', 'fredoka-latin-600-normal.woff2', 'Fredoka', 600),
  font('fredoka', 'fredoka-latin-700-normal.woff2', 'Fredoka', 700),
  font('nunito', 'nunito-latin-600-normal.woff2', 'Nunito', 600),
  font('nunito', 'nunito-latin-700-normal.woff2', 'Nunito', 700),
  font('nunito', 'nunito-latin-800-normal.woff2', 'Nunito', 800),
].join('\n');

const js = (await build({ entryPoints: [join(ROOT, 'web/app.js')], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', legalComments: 'none' })).outputFiles[0].text;
const css = readFileSync(join(ROOT, 'web/style.css'), 'utf8');
const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8')
  .replace('/*__FONTS__*/', () => fonts)
  .replace('/*__CSS__*/', () => css)
  .replace('/*__CONFIG__*/null', () => JSON.stringify(config))
  .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
mkdirSync(join(ROOT, 'dist'), { recursive: true });
writeFileSync(join(ROOT, 'dist/index.html'), html);
console.log(`dist/index.html for ${d.contract}: ${(html.length / 1024).toFixed(0)} KB`);
