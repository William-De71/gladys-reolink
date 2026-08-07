import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryRequest,
  parseDiscoveryReply,
  discoverCameras,
} from '../src/reolink/discovery.js';
import { fakeGladys } from './helpers/fakeGladys.js';

test('buildDiscoveryRequest sends the magic the devices answer to', () => {
  assert.equal(buildDiscoveryRequest().toString('ascii'), 'aaaa0000');
});

test('parseDiscoveryReply reads a JSON reply', () => {
  const payload = Buffer.from(
    JSON.stringify({ uid: '95270005ZBCDEFGH', mac: 'EC:71:DB:11:22:33', name: 'Garden' }),
  );
  assert.deepEqual(parseDiscoveryReply(payload), {
    uid: '95270005ZBCDEFGH',
    mac: 'EC:71:DB:11:22:33',
    name: 'Garden',
    ip: null,
  });
});

test('parseDiscoveryReply reads a reply wrapped in a binary header', () => {
  // Firmwares disagree on the envelope, so the fields are pulled out of the
  // decoded text rather than parsed from a shape that varies.
  const payload = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x01, 0xff]),
    Buffer.from('<uid>95270005ZBCDEFGH</uid><ip>192.168.1.42</ip> ec:71:db:aa:bb:cc'),
  ]);
  const parsed = parseDiscoveryReply(payload);
  assert.equal(parsed.uid, '95270005ZBCDEFGH');
  assert.equal(parsed.ip, '192.168.1.42');
  assert.equal(parsed.mac, 'EC:71:DB:AA:BB:CC');
});

test('parseDiscoveryReply does not take a longer key ending in "uid" for the UID', () => {
  // An unanchored `uid` also matched `deviceuid`, `puid`… — fields that may hold
  // the SAME value on every camera of a model. Two cameras then shared one
  // external id, and Gladys, which upserts on it, kept only the last one.
  const first = parseDiscoveryReply(
    Buffer.from('<devName>Entrance</devName><deviceuid>ABCDEFGH12345678</deviceuid>'),
  );
  const second = parseDiscoveryReply(
    Buffer.from('<devName>Garden</devName><deviceuid>ABCDEFGH12345678</deviceuid>'),
  );
  assert.equal(first.uid, null);
  assert.equal(second.uid, null);
});

test('parseDiscoveryReply still reads a UID announced under its own key', () => {
  // The anchoring must not cost the real field, in either envelope.
  assert.equal(
    parseDiscoveryReply(Buffer.from('{"uid":"95270005ZBCDEFGH"}')).uid,
    '95270005ZBCDEFGH',
  );
  assert.equal(
    parseDiscoveryReply(Buffer.from('<uid>95270005ZBCDEFGH</uid>')).uid,
    '95270005ZBCDEFGH',
  );
  assert.equal(parseDiscoveryReply(Buffer.from('uid=95270005ZBCDEFGH')).uid, '95270005ZBCDEFGH');
  // A UID first in the payload has no character before it to anchor on.
  assert.equal(parseDiscoveryReply(Buffer.from('UID:95270005ZBCDEFGH')).uid, '95270005ZBCDEFGH');
});

test('parseDiscoveryReply reports nothing rather than guessing', () => {
  const parsed = parseDiscoveryReply(Buffer.from('unrelated udp traffic'));
  assert.deepEqual(parsed, { uid: null, mac: null, name: null, ip: null });
});

test('discoverCameras prefers the source address over the announced one', async () => {
  // A camera behind a NAT, or with a stale configuration, announces an address
  // Gladys cannot reach — while the datagram demonstrably came from the other.
  const gladys = fakeGladys({
    scanResults: [
      {
        source_ip: '192.168.1.42',
        payload_base64: Buffer.from(
          JSON.stringify({ uid: 'UID1234567890ABC', ip: '10.0.0.5' }),
        ).toString('base64'),
      },
    ],
  });

  const cameras = await discoverCameras(gladys);
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].ip, '192.168.1.42');
  assert.equal(cameras[0].uid, 'UID1234567890ABC');
});

test('discoverCameras collapses a device that answers twice', async () => {
  const reply = {
    source_ip: '192.168.1.42',
    payload_base64: Buffer.from(JSON.stringify({ uid: 'UID1234567890ABC' })).toString('base64'),
  };
  const gladys = fakeGladys({ scanResults: [reply, reply] });

  const cameras = await discoverCameras(gladys);
  assert.equal(cameras.length, 1);
});

test('discoverCameras degrades to an empty list when the scan is refused', async () => {
  // Discovery is a convenience over the manual address list, so a filtered
  // broadcast or a stale manifest must never break the whole publish.
  const error = new Error('forbidden');
  error.status = 403;
  const gladys = fakeGladys({ scanError: error });

  assert.deepEqual(await discoverCameras(gladys), []);
});

test('discoverCameras ignores a reply carrying no usable address', async () => {
  const gladys = fakeGladys({
    scanResults: [{ source_ip: '', payload_base64: Buffer.from('nothing').toString('base64') }],
  });
  assert.deepEqual(await discoverCameras(gladys), []);
});
