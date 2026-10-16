import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { handle as filesRoute } from './lib/routes/files.mjs';
import { NEXT } from './lib/http.mjs';

const locales = ['vi', 'en', 'zh', 'ja', 'ko'];
const messages = Object.fromEntries(locales.map(locale => [
  locale,
  JSON.parse(fs.readFileSync(new URL('./public/locales/' + locale + '.json', import.meta.url))),
]));
const base = new Set(Object.keys(messages.en));
assert(base.size > 200, 'locale catalog should cover the studio UI');
for (const locale of locales)
  assert.deepEqual(new Set(Object.keys(messages[locale])), base, locale + ' locale keys differ');
for (const key of ['nav.production', 'command.title', 'queue.title', 'gallery.title', 'workspace.timeline', 'workspace.aria', 'render.version2', 'queue.recoverChatgpt', 'queue.workerAccountsAria', 'stage3d.chooseScene', 'queue.providerFilterAria', 'queue.accountFilterAria', 'queue.projectFilterAria', 'queue.statusFilterAria', 'status.script_completed', 'status.retried'])
  assert.ok(messages.en[key], 'missing required locale key: ' + key);
const commands = fs.readFileSync(new URL('./public/js/commands.js', import.meta.url), 'utf8');
for (const alias of ['生成', '動画', '排序', '並べ替え', '정렬', '连接', '接続', '연결', '撤销'])
  assert.ok(commands.includes(alias), 'missing Command Console alias: ' + alias);
const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
for (const attr of ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria']) {
  for (const key of html.matchAll(new RegExp(attr + '="([^"]+)"', 'g')))
    assert.ok(messages.en[key[1]], 'missing HTML locale key: ' + key[1]);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if ((await filesRoute(req, res, url.pathname, url)) === NEXT) {
      res.writeHead(404);
      res.end();
    }
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
try {
  for (const locale of locales) {
    const response = await fetch(`http://127.0.0.1:${port}/locales/${locale}.json`);
    assert.equal(response.status, 200, locale + ' locale must be served');
    assert.match(response.headers.get('content-type') || '', /^application\/json/);
    const served = await response.json();
    assert.equal(served['status.completed'], messages[locale]['status.completed']);
    assert.equal(served['jobs.downloadResult'], messages[locale]['jobs.downloadResult']);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/locales/unknown.json`)).status, 404);
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log('PASS: ' + locales.length + ' locales, ' + base.size + ' synchronized keys, multilingual command aliases');
