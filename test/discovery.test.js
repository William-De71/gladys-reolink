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
