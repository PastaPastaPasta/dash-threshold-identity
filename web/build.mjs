import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { bundleManifest, sha256, MANIFEST } from './manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const out = at('web', 'dist');
const SHELL_SHA256 = '3c918d46cfa1df377ba4805cec5e5582e79de5a918c96fc6e32cb63a2851603a';

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dashhq', 'fonts'), { recursive: true });

const shell = fs.readFileSync(at('web', 'vendor', 'dashhq', 'dashhq-shell.js'));
if (sha256(shell) !== SHELL_SHA256) throw new Error('vendored dashhq-shell.js does not match its pinned hash');
const REGISTRY_ANCHOR = "    yappr:    { name: 'Yappr',";
const REGISTRY_ENTRY = "    multisig: { name: 'Multisig',      url: 'https://new-multisig.dashhq.org', door: 'platform', only: 'Testnet' },\n";
if (!shell.includes(REGISTRY_ANCHOR)) throw new Error('dashhq-shell.js registry anchor moved');
fs.writeFileSync(path.join(out, 'dashhq', 'dashhq-shell.js'), shell.toString().replace(REGISTRY_ANCHOR, REGISTRY_ENTRY + REGISTRY_ANCHOR));
for (const f of ['dashhq-tokens.css', 'dashhq-shell.css', 'dashhq-components.css', 'fonts/archivo-latin-var.woff2', 'fonts/OFL.txt']) {
  fs.copyFileSync(at('web', 'vendor', 'dashhq', f), path.join(out, 'dashhq', f));
}
fs.copyFileSync(at('src', 'ui', 'static', 'style.css'), path.join(out, 'style.css'));
fs.copyFileSync(at('web', 'static', 'web.css'), path.join(out, 'web.css'));
fs.copyFileSync(at('web', 'static', 'icon.svg'), path.join(out, 'icon.svg'));

const replace = (s, from, to) => {
  if (!from || !s.includes(from)) throw new Error(`index.html no longer contains: ${from.slice(0, 80)}`);
  return s.split(from).join(to);
};

let html = fs.readFileSync(at('web', 'static', 'index.html'), 'utf8');
if (/<option[^>]*>\s*mainnet|value="mainnet"/i.test(html)) throw new Error('the hosted page must not offer mainnet');

const require = createRequire(import.meta.url);
const shims = {
  name: 'browser-shims',
  setup(build) {
    build.onResolve({ filter: /^\.\/transport\.js$/ }, (args) => (args.importer.endsWith(path.join('ui', 'static', 'app.js')) ? { path: at('web', 'src', 'transport.mjs') } : undefined));
    build.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: at('web', 'src', 'shims', 'crypto.mjs') }));
    build.onResolve({ filter: /^(fs|path)$/ }, (args) => (args.importer.includes(path.join('@dashevo', 'bls')) ? { path: args.path, namespace: 'empty' } : undefined));
    build.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default {}', loader: 'js' }));
    for (const name of ['buffer', 'events', 'util', 'assert', 'url']) {
      build.onResolve({ filter: new RegExp(`^(node:)?${name}/?$`) }, () => ({ path: require.resolve(`${name}/`) }));
    }
  },
};
const result = await esbuild.build({
  entryPoints: { main: at('web', 'src', 'main.mjs') },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir: out,
  entryNames: '[name]-[hash]',
  minify: true,
  sourcemap: false,
  metafile: true,
  legalComments: 'none',
  inject: [at('web', 'src', 'shims', 'globals.mjs')],
  define: { 'process.browser': 'true', 'process.env.NODE_DEBUG': 'false' },
  plugins: [shims],
  logLevel: 'warning',
});
const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint)?.[0];
if (!entry) throw new Error('no entry chunk');
html = replace(html, 'src="main.js"', `src="${path.basename(entry)}"`);
const manifest = bundleManifest(out);
fs.writeFileSync(path.join(out, MANIFEST), manifest);
const bundleHash = sha256(manifest);
html = replace(html, '__BUNDLE_HASH_SHORT__', bundleHash.slice(0, 12));
html = replace(html, '__BUNDLE_HASH__', bundleHash);
fs.writeFileSync(path.join(out, 'index.html'), html);
const sizes = Object.entries(result.metafile.outputs).map(([f, o]) => `${path.relative(out, f)} ${(o.bytes / 1e6).toFixed(2)} MB`);
console.log(sizes.join('\n'));
console.log(`bundle sha256 ${bundleHash}\nindex.html sha256 ${sha256(html)}`);
