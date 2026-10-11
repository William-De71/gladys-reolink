import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  classifyTopic,
  parsePullMessages,
  clockOffsetFrom,
  faultSummary,
  buildSecurityHeader,
  isBenignDisconnect,
  ReolinkOnvif,
} from '../src/reolink/onvif.js';

/**
 * Build a `PullMessages` answer carrying the given notifications, shaped like
 * what a Reolink RLC-810A sends.
 * @param {Array<{ topic: string, name: string, value: string, operation?: string }>} messages -
 * The notifications.
 * @returns {string} The SOAP body.
 */
function pullAnswer(messages) {
  const notifications = messages
    .map(
      ({ topic, name, value, operation = 'Changed' }) =>
        `<wsnt:NotificationMessage>` +
        `<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic>` +
        `<wsnt:Message><tt:Message UtcTime="2026-10-11T10:00:00Z" PropertyOperation="${operation}">` +
        `<tt:Source><tt:SimpleItem Name="Source" Value="000"/></tt:Source>` +
        `<tt:Data><tt:SimpleItem Name="${name}" Value="${value}"/></tt:Data>` +
        `</tt:Message></wsnt:Message></wsnt:NotificationMessage>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">` +
    `<SOAP-ENV:Body><tev:PullMessagesResponse>${notifications}</tev:PullMessagesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

test('the Reolink topics map onto the detections the integration publishes', () => {
  assert.equal(classifyTopic('tns1:RuleEngine/CellMotionDetector/Motion'), 'motion');
  assert.equal(classifyTopic('tns1:VideoSource/MotionAlarm'), 'motion');
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/PeopleDetect'), 'people');
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/VehicleDetect'), 'vehicle');
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/DogCatDetect'), 'animal');
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/Visitor'), 'doorbell');
});

test('an unknown topic is ignored rather than guessed as a motion', () => {
  // A false motion firing a scene is worse than a missed one.
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/FaceDetect'), null);
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/Package'), null);
  assert.equal(classifyTopic(''), null);
});

test('both edges of a detection are read from the Data block, not the Source', () => {
  // The Source carries `Value="000"` and comes first: reading it would decode
  // every event as "ended".
  const events = parsePullMessages(
    pullAnswer([
      { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', name: 'IsMotion', value: 'true' },
      { topic: 'tns1:RuleEngine/MyRuleDetector/PeopleDetect', name: 'State', value: 'false' },
    ]),
  );
  assert.deepEqual(events, [
    { kind: 'motion', active: true, initial: false },
    { kind: 'people', active: false, initial: false },
  ]);
});

test('the snapshot sent right after subscribing is flagged as initial', () => {
  const [event] = parsePullMessages(
    pullAnswer([
      {
        topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
        name: 'IsMotion',
        value: 'false',
        operation: 'Initialized',
      },
    ]),
  );
  assert.equal(event.initial, true);
});

test('an empty pull yields no event', () => {
  assert.deepEqual(parsePullMessages(pullAnswer([])), []);
  assert.deepEqual(parsePullMessages(''), []);
});

test('the camera clock offset is read from GetSystemDateAndTime', () => {
  const xml =
    '<tt:UTCDateTime><tt:Time><tt:Hour>10</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>30</tt:Second></tt:Time>' +
    '<tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>11</tt:Day></tt:Date></tt:UTCDateTime>';
  const now = Date.UTC(2026, 9, 11, 10, 0, 0);
  assert.equal(clockOffsetFrom(xml, now), 30_000);
  assert.equal(clockOffsetFrom('<nothing/>', now), 0);
});

test('the digest is computed on the camera clock', () => {
  // A camera that never synchronised its clock rejects a digest stamped on
  // ours; the offset moves `Created` onto its time.
  const header = buildSecurityHeader('admin', 'secret', 3_600_000);
  const created = /<wsu:Created>([^<]+)<\/wsu:Created>/.exec(header)[1];
  const drift = Date.parse(created) - Date.now();
  assert.ok(Math.abs(drift - 3_600_000) < 2_000, `created ${created} is not one hour ahead`);

  const nonce = Buffer.from(/<wsse:Nonce[^>]*>([^<]+)</.exec(header)[1], 'base64');
  const expected = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from('secret')]))
    .digest('base64');
  assert.match(header, new RegExp(`>${expected.replace(/[+/]/g, '\\$&')}<`));
});

test('a SOAP fault is summarized by its innermost subcode', () => {
  const xml =
    '<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>ter:NotAuthorized</env:Value>' +
    '</env:Subcode></env:Code><env:Reason><env:Text>Sender not Authorized</env:Text></env:Reason></env:Fault>';
  assert.equal(faultSummary(xml), 'ter:NotAuthorized: Sender not Authorized');
});

test('only a closed connection or a timeout counts as a quiet pull', () => {
  assert.equal(isBenignDisconnect(new Error('socket hang up')), true);
  assert.equal(isBenignDisconnect(new Error('ONVIF_TIMEOUT')), true);
  assert.equal(isBenignDisconnect(new Error('ONVIF_HTTP_400:ter:NotAuthorized')), false);
  assert.equal(isBenignDisconnect(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
});

/**
 * Start a fake Reolink ONVIF server on a free port.
 * @param {object} [options] - How the fake behaves.
 * @param {boolean} [options.refuse] - Answer every authenticated call with a fault.
 * @returns {Promise<object>} `{ port, calls, close }`.
 */
async function fakeCamera({ refuse = false } = {}) {
  const calls = [];
  let pulls = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const call = /<s:Body><(?:\w+:)?(\w+)/.exec(body)?.[1];
      calls.push({ call, path: request.url, authenticated: body.includes('UsernameToken') });
      const send = (status, xml) => {
        response.writeHead(status, { 'Content-Type': 'application/soap+xml' });
        response.end(`<s:Envelope><s:Body>${xml}</s:Body></s:Envelope>`);
      };
      if (call === 'GetSystemDateAndTime') {
        send(200, '<tds:GetSystemDateAndTimeResponse/>');
        return;
      }
      if (refuse) {
        send(
          400,
          '<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code></s:Fault>',
        );
        return;
      }
      if (call === 'GetCapabilities') {
        // The camera announces ITS idea of its address: only the path is kept.
        send(
          200,
          '<tt:Events><tt:XAddr>http://10.9.9.9:8000/onvif/event_service</tt:XAddr>' +
            '<tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>',
        );
        return;
      }
      if (call === 'CreatePullPointSubscription') {
        send(200, '<wsa:Address>http://10.9.9.9:8000/onvif/Subscription?Idx=7</wsa:Address>');
        return;
      }
      if (call === 'PullMessages') {
        pulls += 1;
        send(
          200,
          pulls === 1
            ? pullAnswer([
                {
                  topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
                  name: 'IsMotion',
                  value: 'true',
                },
              ])
            : '',
        );
        return;
      }
      send(200, '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the client subscribes on the path the camera announced and delivers its events', async () => {
  const camera = await fakeCamera();
  const client = new ReolinkOnvif({
    ip: '127.0.0.1',
    port: camera.port,
    username: 'admin',
    password: 'secret',
  });

  const event = await new Promise((resolve) => client.start(resolve));
  client.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await camera.close();

  assert.deepEqual(event, { kind: 'motion', active: true, initial: false });
  const subscribe = camera.calls.find((entry) => entry.call === 'CreatePullPointSubscription');
  assert.equal(subscribe.path, '/onvif/event_service');
  const pull = camera.calls.find((entry) => entry.call === 'PullMessages');
  assert.equal(pull.path, '/onvif/Subscription?Idx=7');
  assert.equal(pull.authenticated, true);
  assert.equal(
    camera.calls.find((entry) => entry.call === 'GetSystemDateAndTime').authenticated,
    false,
    'the clock is read without credentials',
  );
  assert.ok(
    camera.calls.some((entry) => entry.call === 'Unsubscribe'),
    'the subscription is released on stop',
  );
});

test('a camera refusing the account is never reported as live', async () => {
  const camera = await fakeCamera({ refuse: true });
  const client = new ReolinkOnvif({
    ip: '127.0.0.1',
    port: camera.port,
    username: 'admin',
    password: 'wrong',
  });
  client.start(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.isLive(), false);
  assert.ok(client.failures >= 1);
  client.stop();
  await camera.close();
});
