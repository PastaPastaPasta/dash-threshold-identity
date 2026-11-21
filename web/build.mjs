import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const at = (...p) => path.join(root, ...p);
const out = at('web', 'dist');
const SHELL_SHA256 = '3c918d46cfa1df377ba4805cec5e5582e79de5a918c96fc6e32cb63a2851603a';

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dashhq', 'fonts'), { recursive: true });

const shell = fs.readFileSync(at('web', 'vendor', 'dashhq', 'dashhq-shell.js'));
if (createHash('sha256').update(shell).digest('hex') !== SHELL_SHA256) throw new Error('vendored dashhq-shell.js does not match its pinned hash');
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
  if (!s.includes(from)) throw new Error(`index.html no longer contains: ${from.slice(0, 80)}`);
  return s.split(from).join(to);
};

let html = fs.readFileSync(at('src', 'ui', 'static', 'index.html'), 'utf8');
const header = html.slice(html.indexOf('  <header>'), html.indexOf('  </header>') + '  </header>\n'.length);
const tabs = header.slice(header.indexOf('<nav id="tabs">'), header.indexOf('</nav>') + '</nav>'.length);
html = replace(html, header, fs.readFileSync(at('web', 'static', 'header.html'), 'utf8').replace('<!--TABS-->', tabs.replace('<nav id="tabs">', '<nav id="tabs" slot="nav" aria-label="Multisig">')));
html = replace(html, '<title>Threshold Identity</title>', '<title>Multisig (Testnet) · dashhq</title>\n  <meta name="referrer" content="no-referrer">\n  <link rel="icon" href="icon.svg" type="image/svg+xml">');
html = replace(html, '  <link rel="stylesheet" href="style.css">\n  <script type="module" src="app.js"></script>\n', [
  '  <script src="dashhq/dashhq-shell.js"></script>',
  '  <link rel="preload" href="dashhq/fonts/archivo-latin-var.woff2" as="font" type="font/woff2" crossorigin>',
  '  <link rel="stylesheet" href="dashhq/dashhq-tokens.css">',
  '  <link rel="stylesheet" href="dashhq/dashhq-shell.css">',
  '  <link rel="stylesheet" href="dashhq/dashhq-components.css">',
  '  <link rel="stylesheet" href="style.css">',
  '  <link rel="stylesheet" href="web.css">',
  '  <script type="module" src="main.js"></script>',
  '',
].join('\n'));
html = replace(html, '<option>mainnet</option>', '');
html = replace(html, '            <input name="relay" placeholder="Relay URL (optional; leave empty to exchange files)">\n', '');
html = replace(html, '            <input name="relay" placeholder="Relay URL (optional)">\n', '');
html = replace(html, '<body>', '<body class="dh-fill">');
html = replace(html, '  <main>', `${fs.readFileSync(at('web', 'static', 'unlock.html'), 'utf8')}  <main data-unlocked hidden>\n    <p class="whoami" id="me"></p>`);
html = replace(html, '<button id="fund-check">Show address and balance</button>', '<button id="fund-check">Show address and balance</button>\n          <a href="https://faucet.dashhq.org/?network=testnet" target="_blank" rel="noopener noreferrer">Get testnet DASH ↗</a>');
html = replace(html, '</body>', `${fs.readFileSync(at('web', 'static', 'footer.html'), 'utf8')}</body>`);
if (/<option[^>]*>\s*mainnet|value="mainnet"/i.test(html)) throw new Error('the hosted page must not offer mainnet');
fs.writeFileSync(path.join(out, 'index.html'), html);

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
  minify: true,
  sourcemap: false,
  metafile: true,
  legalComments: 'none',
  inject: [at('web', 'src', 'shims', 'globals.mjs')],
  define: { 'process.browser': 'true', 'process.env.NODE_DEBUG': 'false' },
  plugins: [shims],
  logLevel: 'warning',
});
const sizes = Object.entries(result.metafile.outputs).map(([f, o]) => `${path.relative(out, f)} ${(o.bytes / 1e6).toFixed(2)} MB`);
console.log(sizes.join('\n'));
