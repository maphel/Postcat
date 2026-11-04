// Replay regressions and worker boundary states, using the public worker hook and panel DOM.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { buildExtension, launch, openPanel, waitForSendDone } from './harness.js';

const MiB = 1024 * 1024;

function gate() {
  let arrive;
  let response;
  const started = new Promise((resolve) => { arrive = resolve; });
  return {
    started,
    handle: (res) => { response = res; arrive(); },
    release: () => response?.end('finished'),
  };
}

async function newRequest(page, url) {
  await page.click('#newListBtn');
  await page.fill('#url', url);
}

const cancelled = (page) => page.waitForFunction(
  () => document.getElementById('resBody').textContent === 'Request cancelled.', null, { timeout: 1500 });

test('worker replay: cancellation isolation, auth, body limits and cleanup', async (t) => {
  const gates = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (gates.has(req.url)) return gates.get(req.url).handle(res);
    const size = /^\/body\/(text|binary)\/(\d+)$/.exec(req.url);
    if (size) {
      const length = Number(size[2]);
      res.setHeader('content-type', size[1] === 'text' ? 'text/plain' : 'application/octet-stream');
      res.setHeader('content-length', length);
      const chunk = Buffer.alloc(65536, size[1] === 'text' ? 65 : 0);
      let offset = 0;
      const write = () => {
        while (offset < length) {
          const n = Math.min(chunk.length, length - offset);
          offset += n;
          if (!res.write(chunk.subarray(0, n))) return res.once('drain', write);
        }
        res.end();
      };
      return write();
    }
    if (req.url === '/broken') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 100 });
      res.flushHeaders();
      return res.write('partial', () => res.destroy());
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/echo` });
      return res.end();
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, headers: req.headers }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const extension = buildExtension();
  let ctx;
  try {
    const env = await launch(extension.dir);
    ctx = env.ctx;
    const { sw, id } = env;
    const cleanRules = async () => assert.deepEqual(await sw.evaluate(
      () => chrome.declarativeNetRequest.getSessionRules()), []);
    const send = (request) => sw.evaluate((request) => postcatSend(request),
      { method: 'GET', url: `${base}/echo`, headers: [], body: '', ...request });

    await t.test('cancelling one panel leaves another panel send untouched', async () => {
      const [a, b] = await Promise.all([
        openPanel(ctx, id, { width: 1300, height: 600 }),
        openPanel(ctx, id, { width: 1300, height: 600 }),
      ]);
      const hold = gate();
      gates.set('/panel-a', hold);
      try {
        await newRequest(a.page, `${base}/panel-a`);
        await newRequest(b.page, `${base}/panel-b`);
        await a.page.click('#sendBtn');
        await hold.started;
        await b.page.click('#sendBtn');
        await a.page.click('#sendBtn');
        hold.release();
        await b.page.waitForFunction(() => document.getElementById('sendBtn').textContent === 'Send');
        await a.page.waitForFunction(() => document.getElementById('sendBtn').textContent === 'Send');
        assert.equal(await a.page.textContent('#resBody'), 'Request cancelled.');
        assert.equal(JSON.parse(await b.page.textContent('#resBody')).method, 'GET');
        assert.deepEqual([...a.errors, ...b.errors], []);
        await cleanRules();
      } finally {
        hold.release();
        await a.page.close();
        await b.page.close();
      }
    });

    await t.test('queued cancellation responds before the active send finishes', async () => {
      const { page, errors } = await openPanel(ctx, id, { width: 1300, height: 600 });
      const hold = gate();
      gates.set('/queue-blocker', hold);
      try {
        await newRequest(page, `${base}/queue-blocker`);
        await page.click('#sendBtn');
        await hold.started;
        await newRequest(page, `${base}/cancel-queued`);
        await page.click('#sendBtn');
        await page.click('#sendBtn');
        await cancelled(page);
        assert.equal(await page.textContent('#sendBtn'), 'Send');
        assert.equal(seen.includes('/cancel-queued'), false);
        hold.release();
        await newRequest(page, `${base}/after-queued-cancel`);
        await page.click('#sendBtn');
        await waitForSendDone(page);
        assert.equal(seen.includes('/cancel-queued'), false);
        assert.deepEqual(errors, []);
        await cleanRules();
      } finally {
        hold.release();
        await page.close();
      }
    });

    await t.test('URL Basic auth encodes Unicode as UTF-8', async () => {
      for (const credentials of ['€:😀', 'ä:ö']) {
        const [username, password] = credentials.split(':');
        const url = new URL(`${base}/echo`);
        url.username = username;
        url.password = password;
        const result = await send({ url: url.href });
        assert.equal(JSON.parse(result.body).headers.authorization, `Basic ${Buffer.from(credentials).toString('base64')}`);
      }
      await cleanRules();
    });

    await t.test('an explicit Authorization header overrides URL credentials', async () => {
      const url = new URL(`${base}/echo`);
      url.username = 'ignored';
      url.password = 'ignored';
      const result = await send({ url: url.href, headers: [{ name: 'Authorization', value: 'Bearer explicit' }] });
      assert.equal(JSON.parse(result.body).headers.authorization, 'Bearer explicit');
      await cleanRules();
    });

    await t.test('invalid headers, methods and URLs leave the queue usable and rules empty', async () => {
      for (const request of [
        { url: 'not a URL' },
        { url: 'file:///tmp/postcat' },
        { method: 'CONNECT' },
        { headers: [{ name: 'bad name', value: 'x' }] },
        { headers: [{ name: 'X-Test', value: '€' }] },
        { headers: [{ name: 'Cookie', value: 'x=1\r\nInjected: yes' }] },
      ]) {
        await assert.rejects(send(request));
        await cleanRules();
        assert.equal((await send({})).status, 200);
        await cleanRules();
      }
    });

    await t.test('network and body stream failures release rules and unblock later sends', async () => {
      for (const [url, error] of [
        ['http://localhost:1/unreachable', /Failed to fetch/i],
        // Headers and partial bytes were flushed: fetch resolved, then reading the body failed.
        [`${base}/broken`, /network error/i],
      ]) {
        await assert.rejects(send({ url, headers: [{ name: 'Cookie', value: 'secret=1' }] }), error);
        await cleanRules();
        const echo = JSON.parse((await send({})).body);
        assert.equal(echo.headers.cookie, undefined);
      }
    });

    await t.test('already aborted sends do not reach the server or add rules', async () => {
      await assert.rejects(sw.evaluate((url) => {
        const controller = new AbortController();
        controller.abort('cancel');
        return postcatSend({ method: 'GET', url, headers: [], body: '' }, controller);
      }, `${base}/already-cancelled`));
      assert.equal(seen.includes('/already-cancelled'), false);
      await cleanRules();
    });

    await t.test('cross-origin redirects drop editor cookie and Authorization', async () => {
      const result = await send({ url: `${base}/redirect`, headers: [
        { name: 'Cookie', value: 'secret=1' }, { name: 'Authorization', value: 'Bearer secret' },
      ] });
      assert.equal(result.redirected, true);
      assert.equal(new URL(result.url).hostname, '127.0.0.1');
      const echo = JSON.parse(result.body);
      assert.equal(echo.headers.cookie, undefined);
      assert.equal(echo.headers.authorization, undefined);
      await cleanRules();
    });

    await t.test('HEAD and 204 responses have a complete empty body', async () => {
      for (const request of [{ method: 'HEAD' }, { url: `${base}/empty` }]) {
        const result = await send(request);
        assert.equal(result.size, 0);
        assert.equal(result.tooLarge, false);
        assert.equal(result.body, '');
        await cleanRules();
      }
    });

    for (const [kind, length, tooLarge] of [
      ['binary', 25 * MiB, false],
      ['binary', 25 * MiB + 1, true],
      ['text', 25 * MiB + 1, false],
      ['text', 50 * MiB, false],
      ['text', 50 * MiB + 1, true],
    ]) {
      await t.test(`${kind} body of ${length} bytes respects transfer and read caps`, async () => {
        const result = await sw.evaluate(async ({ url }) => {
          const result = await postcatSend({ method: 'GET', url, headers: [], body: '' });
          return { size: result.size, tooLarge: result.tooLarge, textLength: result.body?.length ?? null,
            binaryLength: result.bodyBase64 == null ? null : atob(result.bodyBase64).length };
        }, { url: `${base}/body/${kind}/${length}` });
        assert.equal(result.size, length);
        assert.equal(result.tooLarge, tooLarge);
        assert.equal(result.textLength, kind === 'text' && !tooLarge ? length : null);
        assert.equal(result.binaryLength, kind === 'binary' && !tooLarge ? length : null);
        await cleanRules();
      });
    }
  } finally {
    for (const hold of gates.values()) hold.release();
    await ctx?.close();
    extension.cleanup();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
