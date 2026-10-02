import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { extractStaticAssets } from '../src/assets.mjs';
import { runChecks } from '../src/checker.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/proddoctor.mjs', import.meta.url));
test('CLI --version matches package.json without network', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
});

for (const args of [
  ['https://example.com', '--statuz', '200'],
  ['https://example.com', '--status'],
  ['https://example.com', '--status', '200', '--status', '404'],
  ['https://example.com', '--timeout', '100.5'],
  ['https://example.com', '--json-file'],
  ['https://example.com', '--max-body-bytes', '-1'],
  ['--bad-option']
]) {
  test('CLI rejects invalid arguments before requests: ' + args.join(' '), () => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  });
}

test('asset parser handles quoted/unquoted attributes without data-src false positives', () => {
  const assets = extractStaticAssets(
    '<script data-src="/lazy.js" src=/app.js></script><link rel=stylesheet href=/app.css>',
    'https://example.com/'
  );
  assert.deepEqual(assets.map(x => x.url), ['https://example.com/app.js', 'https://example.com/app.css']);
  assert.deepEqual(extractStaticAssets('<script data-src="/lazy.js"></script>', 'https://example.com'), []);
});

test('optional response body limit fails clearly, unlimited default remains compatible', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<p>' + 'x'.repeat(4096) + '</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const limited = await runChecks(url, {retries: 0, maxBodyBytes: 100});
  assert.equal(limited.ok, false);
  assert.match(limited.page.error, /exceeds max_body_bytes/);
  const legacy = await runChecks(url, {retries: 0});
  assert.equal(legacy.ok, true);
});

test('asset parser honors base href, ignores comments and decodes numeric entities', () => {
  const assets = extractStaticAssets(
    '<base href="/static/"><!-- <script src="/missing.js"></script> --><script src="app.js?a=1&#38;b=2"></script>',
    'https://example.com/page'
  );
  assert.deepEqual(assets, [{kind: 'script', url: 'https://example.com/static/app.js?a=1&b=2'}]);
  assert.deepEqual(extractStaticAssets('<base href="https://cdn.example.com/"><script src=app.js></script>', 'https://example.com'), []);
});

test('unexpected MIME is visible but does not introduce a breaking default failure', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'image/png' : 'text/html');
    res.end(req.url === '/app.js' ? 'not JavaScript' : '<script src=/app.js></script>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const result = await runChecks(url, { retries: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.assets.count, 1);
  assert.match(result.warnings.join('\n'), /Unexpected script Content-Type: image\/png/);

  // Actual CLI happy path, including the optional empty expect value.
  const child = spawn(process.execPath, [cli, url, '--expect', '', '--status', '200', '--json']);
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).ok, true);
});

test('help values cannot bypass checks and inline markup is not a real asset', async t => {
  let requests = 0;
  const markup = `<script>const snippet = '<script src="/missing.js">';
    const css = '<link rel="stylesheet" href="/missing.css">';
    const base = '<base href="/wrong/">'; const comment = '<!--';</script>
    <template><script src="/missing.js"></script><template><link rel=stylesheet href=/missing.css></template></template>
    <textarea><script src="/missing.js"></script></textarea>
    <script data-description="a > b" src="/app.js"></script><link rel="stylesheet" href="/app.css">`;
  assert.deepEqual(extractStaticAssets(markup, 'https://example.com/').map(x => x.url),
    ['https://example.com/app.js', 'https://example.com/app.css']);
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(''); }
    if (req.url === '/app.css') { res.setHeader('Content-Type', 'text/css'); return res.end(''); }
    if (req.url.startsWith('/missing')) { res.statusCode = 404; return res.end('missing'); }
    res.setHeader('Content-Type', 'text/html');
    res.end(markup);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await runChecks(url, { retries: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.assets.count, 2);
  for (const flag of ['--expect', '--browser-expect', '--json-file', '--timeout']) {
    const before = requests;
    const child = spawnSync(process.execPath, [cli, url, flag, '--help'], { encoding: 'utf8' });
    assert.equal(child.status, 2, child.stdout + child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(requests, before);
  }
  const child = spawn(process.execPath, [cli, url, '--expect', '-h', '--retries', '0', '--json']);
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).page.expectedOk, false);
  for (const args of [['--help'], [url, '--help']]) {
    const help = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
  }
});
