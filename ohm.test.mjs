import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { LND_CONNECT_TIMEOUT_MS, lndRequest } from './ohm.mjs';

const KEYS = ['LND_HOST', 'LND_REST_PORT', 'LND_MACAROON_HEX', 'LND_TLS_INSECURE', 'LND_TLS_CERT_BASE64'];

async function withNode(env, run) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { LND_MACAROON_HEX: 'abcd', LND_TLS_INSECURE: 'true', ...env });
  delete process.env.LND_TLS_CERT_BASE64;
  try {
    return await run();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('a node that accepts the connection but never answers fails within 10 seconds', async () => {
  const sockets = new Set();
  const silent = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  silent.listen(0, '127.0.0.1');
  await once(silent, 'listening');
  try {
    await withNode({ LND_HOST: '127.0.0.1', LND_REST_PORT: String(silent.address().port) }, async () => {
      const started = Date.now();
      await assert.rejects(lndRequest('/v1/invoices', 'POST', { value: '1' }), /did not answer within 10 seconds/);
      const took = Date.now() - started;
      assert.equal(LND_CONNECT_TIMEOUT_MS, 10_000);
      assert.ok(took >= LND_CONNECT_TIMEOUT_MS - 100, `gave up too early, after ${took}ms`);
      assert.ok(took < LND_CONNECT_TIMEOUT_MS + 1_000, `took ${took}ms`);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

test('an address that never answers a connection attempt is abandoned at the connect timeout', async () => {
  await withNode({ LND_HOST: '10.255.255.1', LND_REST_PORT: '8080' }, async () => {
    const started = Date.now();
    await assert.rejects(
      lndRequest('/v1/getinfo', 'GET', null, { connectTimeoutMs: 500 }),
      /Lightning node (did not answer within 1 second|could not be reached)/,
    );
    assert.ok(Date.now() - started < 2_000);
  });
});
