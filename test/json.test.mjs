import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../src/checker.mjs';
import { localizeResult, toEnglishReport, toChineseReport, toMarkdownSummary } from '../src/report.mjs';
import { toHtmlReport } from '../src/html-report.mjs';

test('critical API JSON assertions, retries, reports and CLI exit codes', async t => {
  let requests = 0;
  let retryRequests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/invalid') return res.end('<h1>SPA fallback</h1>');
    if (req.url === '/unsafe') return res.end('{"id":9007199254740993,"healthy":true}');
    if (req.url === '/overflow') return res.end('{"value":1e400}');
    if (req.url === '/large-string') return res.end('{"id":"9007199254740993"}');
    if (req.url === '/error') res.statusCode = 500;
    if (req.url === '/retry') return res.end(JSON.stringify({ healthy: ++retryRequests > 1 }));
    res.end(JSON.stringify({ healthy: true, ready: false, count: 0, empty: null,
      dependencies: { database: 'ready' }, items: [{ id: 7 }], 'a/b': { '~key': 'ok' },
      message: '<script>alert(1)</script>' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { retries: 0, timeoutMs: 1000, checkAssets: false, expectedStatus: 200 };
  const check = (route, expectedJson, extra = {}) => runChecks(url + route, { ...options, expectedJson, ...extra });

  const good = await check('/api', { '/healthy': true, '/dependencies/database': 'ready', '/items/0/id': 7,
    '/ready': false, '/count': 0, '/empty': null, '/a~1b/~0key': 'ok', '/items': [{ id: 7 }] });
  assert.equal(good.ok, true);
  assert.equal(good.json.assertions.length, 8);
  assert.equal((await check('/api', { '/healthy': 'true' })).ok, false);
  assert.equal((await check('/api', { '/items': [{ id: '7' }] })).ok, false);
  assert.equal((await check('/api', { '/items/00/id': 7 })).ok, false);
  assert.equal((await check('/api', { '/items/length': 1 })).ok, false);
  assert.equal((await check('/api', { '/toString': null })).json.assertions[0].found, false);
  const missing = await check('/api', { '/missing': null });
  assert.equal(missing.ok, false);
  assert.equal(missing.json.assertions[0].found, false);
  assert.equal(Object.hasOwn(missing.json.assertions[0], 'actual'), false);
  assert.match(toEnglishReport(missing), /missing field/);
  assert.match(toChineseReport(missing), /字段缺失/);
  assert.equal((await check('/error', { '/healthy': true })).ok, false);
  assert.equal((await check('/api', null)).json.checked, false);
  assert.equal((await check('/api', { '': { healthy: true } })).ok, false);
  for (const [route, expectedJson] of [['/unsafe', { '/id': 0 }], ['/unsafe', { '': {} }], ['/overflow', { '/value': 0 }]]) {
    const result = await check(route, expectedJson);
    assert.equal(result.ok, false);
    assert.match(toEnglishReport(result), /non-finite number or unsafe integer/);
    assert.equal(result.json.assertions.length, 0); // Do not serialize Infinity as a misleading null.
  }
  assert.equal((await check('/unsafe', { '/healthy': true })).ok, true);
  assert.equal((await check('/large-string', { '/id': '9007199254740993' })).ok, true);

  const invalid = await check('/invalid', { '/healthy': true });
  assert.equal(invalid.ok, false);
  assert.match(toEnglishReport(invalid), /Response body is not valid JSON/);
  assert.equal(localizeResult(invalid).json.error, 'Response body is not valid JSON');
  assert.equal((await check('/invalid', null)).ok, true); // Existing opt-out behavior stays unchanged.
  const retried = await check('/retry', { '/healthy': true }, { retries: 1 });
  assert.equal(retried.ok, true);
  assert.equal(retried.page.attempts, 2);
  assert.equal(retryRequests, 2);
  const limited = await check('/api', { '/healthy': true }, { maxBodyBytes: 10 });
  assert.equal(limited.ok, false);
  assert.match(limited.page.error, /max_body_bytes/);
  assert.match(toEnglishReport(limited), /Request failed/);

  const escaped = await check('/api', { '/message': 'expected' });
  for (const report of [toHtmlReport(escaped), toMarkdownSummary(escaped)]) {
    assert.match(report, /&lt;script&gt;/);
    assert.doesNotMatch(report, /<script>/);
  }
  assert.match(toHtmlReport(escaped, { language: 'zh-CN' }), /JSON 断言/);
  assert.match(toMarkdownSummary(escaped), /JSON assertion failed/);
  const unsafePointer = await check('/api', { '/<script>': true });
  assert.doesNotMatch(toMarkdownSummary(unsafePointer), /<script>/);

  for (const expectedJson of [{}, [], true, 'bad', { healthy: true }, { '/bad~2': true },
    { '/id': 9007199254740992 }, { '/nested': [{ value: Infinity }] }]) {
    const before = requests;
    await assert.rejects(check('/api', expectedJson), /expect_json/);
    assert.equal(requests, before);
  }

  const cli = fileURLToPath(new URL('../bin/proddoctor.mjs', import.meta.url));
  const invoke = async (route, flags) => {
    const child = spawn(process.execPath, [cli, url + route, '--retries', '0', '--status', '200', '--json', ...flags]);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  for (const [route, value, code] of [
    ['/api', '{"/healthy":true}', 0], ['/api', '{"/healthy":false}', 1],
    ['/error', '{"/healthy":true}', 1], ['/invalid', '{"/healthy":true}', 1]
  ]) {
    const result = await invoke(route, ['--expect-json', value]);
    assert.equal(result.code, code, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, code === 0);
  }
  for (const flags of [
    ['--expect-json', '{}'], ['--expect-json', 'null'], ['--expect-json', 'broken'],
    ['--expect-json', '{"bad":true}'], ['--expect-json'],
    ['--expect-json', '{"/id":9007199254740993}'], ['--expect-json', '{"/value":1e400}'],
    ['--expect-json', '{"/healthy":true}', '--expect-json', '{"/healthy":true}']
  ]) {
    const before = requests;
    const result = await invoke('/api', flags);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(requests, before);
  }
});
