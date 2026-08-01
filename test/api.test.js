// -----------------------------------------------------------------------------
// The API client is tested against a REAL HTTP server rather than a mocked
// transport: the parts worth testing here — the port probe, the token renewal,
// the retry on a refused token — are exactly the ones a mock would fake away.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ReolinkApi, ReolinkAuthError, errorCodeOf } from '../src/reolink/api.js';

/**
 * Start a camera-like server and return it with its address.
 * @param {(request: object, url: URL, body: object) => object} handler - Answers
 * one request; whatever it returns is sent as the JSON body.
 * @returns {Promise<object>} `{ port, close, requests }`.
 * @example
 * const camera = await fakeCamera(() => [{ cmd: 'Login', code: 0, value: {} }]);
 */
async function fakeCamera(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://localhost');
      const raw = Buffer.concat(chunks).toString('utf-8');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ url, body });

      const answer = handler(request, url, body);
      if (answer && answer.__raw) {
        response.writeHead(answer.status || 200, { 'Content-Type': answer.contentType });
        response.end(answer.body);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A successful Login answer, with the token the client must pick up. */
const loginOk = (name = 'TOKEN1', leaseTime = 3600) => [
  { cmd: 'Login', code: 0, value: { Token: { name, leaseTime } } },
];

test('errorCodeOf prefers the nested rspCode over the top-level code', () => {
  // The firmware reports `code: 1` for every failure and puts the precise reason
  // in `error.rspCode`; acting on the generic 1 would lose the distinction
  // between "token expired" (retry) and "not supported" (give up).
  assert.equal(errorCodeOf({ code: 1, error: { rspCode: -6 } }), -6);
  assert.equal(errorCodeOf({ code: 0 }), 0);
  assert.equal(errorCodeOf({ code: 1 }), 1);
  assert.equal(errorCodeOf(null), 0);
});

test('the client logs in and reuses its token', async () => {
  const camera = await fakeCamera((request, url) => {
    if (url.searchParams.get('cmd') === 'Login') {
      return loginOk();
    }
    return [{ cmd: 'GetDevInfo', code: 0, value: { DevInfo: { model: 'RLC-810A' } } }];
  });

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });

    const first = await api.getDevInfo();
    const second = await api.getDevInfo();

    assert.equal(first.model, 'RLC-810A');
    assert.equal(second.model, 'RLC-810A');
    // One login, two reads: a fresh token per request would exhaust the handful
    // of sessions the firmware allows.
    const logins = camera.requests.filter((entry) => entry.url.searchParams.get('cmd') === 'Login');
    assert.equal(logins.length, 1);
  } finally {
    await camera.close();
  }
});

test('the client sends the token it was given', async () => {
  const camera = await fakeCamera((request, url) =>
    url.searchParams.get('cmd') === 'Login'
      ? loginOk('ABC123')
      : [{ cmd: 'GetDevInfo', code: 0, value: { DevInfo: {} } }],
  );

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    await api.getDevInfo();

    const read = camera.requests.find(
      (entry) => entry.url.searchParams.get('cmd') === 'GetDevInfo',
    );
    assert.equal(read.url.searchParams.get('token'), 'ABC123');
  } finally {
    await camera.close();
  }
});

test('a refused password raises a ReolinkAuthError', async () => {
  const camera = await fakeCamera(() => [{ cmd: 'Login', code: 1, error: { rspCode: -8 } }]);

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'wrong',
    });
    await assert.rejects(() => api.getDevInfo(), ReolinkAuthError);
  } finally {
    await camera.close();
  }
});

test('a token refused mid-flight triggers one clean re-login', async () => {
  let tokensIssued = 0;
  const camera = await fakeCamera((request, url) => {
    if (url.searchParams.get('cmd') === 'Login') {
      tokensIssued += 1;
      return loginOk(`TOKEN${tokensIssued}`);
    }
    // The first read is rejected as if the session had expired, the second
    // succeeds — which is exactly what a camera does after a reboot.
    if (url.searchParams.get('token') === 'TOKEN1') {
      return [{ cmd: 'GetDevInfo', code: 1, error: { rspCode: -6 } }];
    }
    return [{ cmd: 'GetDevInfo', code: 0, value: { DevInfo: { model: 'RLC-520A' } } }];
  });

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    const info = await api.getDevInfo();

    assert.equal(info.model, 'RLC-520A');
    assert.equal(tokensIssued, 2, 'the client must log in again exactly once');
  } finally {
    await camera.close();
  }
});

test('an expiring token is renewed before it is used', async () => {
  let tokensIssued = 0;
  const camera = await fakeCamera((request, url) => {
    if (url.searchParams.get('cmd') === 'Login') {
      tokensIssued += 1;
      // A lease shorter than the renew margin: the token is already considered
      // due for renewal by the time the next call happens.
      return loginOk(`TOKEN${tokensIssued}`, 10);
    }
    return [{ cmd: 'GetDevInfo', code: 0, value: { DevInfo: {} } }];
  });

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    await api.getDevInfo();
    await api.getDevInfo();

    assert.equal(tokensIssued, 2, 'a token close to expiry must be renewed');
  } finally {
    await camera.close();
  }
});

test('send returns null instead of throwing when a command is unsupported', async () => {
  // Capabilities differ across models: "this camera has no battery" is an
  // ordinary answer to GetBatteryInfo, not a failure worth propagating.
  const camera = await fakeCamera((request, url) =>
    url.searchParams.get('cmd') === 'Login'
      ? loginOk()
      : [{ cmd: 'GetBatteryInfo', code: 1, error: { rspCode: -9 } }],
  );

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    assert.equal(await api.send('GetBatteryInfo', { channel: 0 }), null);
  } finally {
    await camera.close();
  }
});

test('a batch is sent as one request and answered in order', async () => {
  const camera = await fakeCamera((request, url, body) => {
    if (url.searchParams.get('cmd') === 'Login') {
      return loginOk();
    }
    return body.map((command) => ({ cmd: command.cmd, code: 0, value: { seen: command.cmd } }));
  });

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    const answers = await api.sendBatch([
      { cmd: 'GetMdState', action: 0, param: { channel: 0 } },
      { cmd: 'GetAiState', action: 0, param: { channel: 0 } },
    ]);

    assert.equal(answers.length, 2);
    assert.equal(answers[0].value.seen, 'GetMdState');
    assert.equal(answers[1].value.seen, 'GetAiState');
    // One round trip for the whole batch: on a battery camera each request is a
    // radio wakeup.
    const reads = camera.requests.filter((entry) => entry.url.searchParams.get('cmd') !== 'Login');
    assert.equal(reads.length, 1);
  } finally {
    await camera.close();
  }
});

test('snapshot returns the JPEG bytes', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const camera = await fakeCamera((request, url) => {
    if (url.searchParams.get('cmd') === 'Login') {
      return loginOk();
    }
    return { __raw: true, contentType: 'image/jpeg', body: jpeg };
  });

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    const image = await api.snapshot({ channel: 0, stream: 'main' });
    assert.deepEqual(image, jpeg);

    const snap = camera.requests.find((entry) => entry.url.searchParams.get('cmd') === 'Snap');
    assert.equal(snap.url.searchParams.get('snapType'), 'main');
    // A cache-busting parameter is mandatory: without it the firmware serves the
    // same frame for minutes and the dashboard image looks frozen.
    assert.ok(snap.url.searchParams.get('rs'), 'the request must carry a cache buster');
  } finally {
    await camera.close();
  }
});

test('snapshot reports a JSON error rather than returning it as an image', async () => {
  // A refused token comes back as JSON with a 200 status, so the content type is
  // what tells success from failure — publishing that body would corrupt the
  // dashboard image.
  const camera = await fakeCamera((request, url) =>
    url.searchParams.get('cmd') === 'Login'
      ? loginOk()
      : [{ cmd: 'Snap', code: 1, error: { rspCode: -6 } }],
  );

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    await assert.rejects(() => api.snapshot(), /REOLINK_SNAP_NO_IMAGE/);
  } finally {
    await camera.close();
  }
});

test('an answer that is not an array is rejected', async () => {
  // Anything else means we are not talking to a Reolink API — a captive portal
  // or another device entirely — and must not be parsed as one.
  const camera = await fakeCamera(() => ({ error: 'not a reolink' }));

  try {
    const api = new ReolinkApi({
      ip: '127.0.0.1',
      port: camera.port,
      https: false,
      username: 'admin',
      password: 'secret',
    });
    await assert.rejects(() => api.getDevInfo(), /REOLINK_UNREACHABLE|REOLINK_UNEXPECTED_ANSWER/);
  } finally {
    await camera.close();
  }
});
