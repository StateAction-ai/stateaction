import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startFixture, PART_BYTES } from './fixture.ts';

test('synthetic owner/cookie/epoch/byte-exact multipart control contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stateaction-android-upload-'));
  const fixture = await startFixture({ directory, urlTtlMs: 1000 });
  const cookies = new Map<string, string>();
  let rotations = 0;
  const request = async (path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stera-Client': 'android-upload-spike', Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split('='); cookies.set(name, value); rotations++; }
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const login = (ownerId = 'synthetic-a') => request('/spike/login', { ownerId });
  try {
    await request('/api/v1/me', undefined, 401); await login();
    assert.equal((await request('/api/v1/me')).userId, 'synthetic-a'); assert.equal(cookies.get('spike_aux'), 'kept');
    const block = Buffer.alloc(PART_BYTES, 0x5a), tail = Buffer.from('stateaction-byte-exact-final-part');
    const sha = createHash('sha256').update(block).update(block).update(tail).digest('hex');
    const input = { clientUploadId: 'control-contract-file', sizeBytes: String(block.length * 2 + tail.length), sha256: sha };
    const plan = await request('/api/v1/uploads', input); const path = `/api/v1/uploads/${plan.fileId}`;
    assert.equal(plan.partCount, 3); assert.equal(plan.partSizeBytes, String(PART_BYTES));
    assert.equal((await request('/api/v1/uploads', input)).fileId, plan.fileId);
    await request('/api/v1/uploads', { ...input, sha256: '0'.repeat(64) }, 409);
    await login('synthetic-b'); await request(path, undefined, 404); await login();
    const epoch = { expectedTransportEpoch: 1 };
    await request(`${path}/parts/sign`, { expectedTransportEpoch: 0, partNumbers: [1] }, 409);
    const stale = await request(`${path}/parts/sign`, { ...epoch, partNumbers: [1] });
    await new Promise(done => setTimeout(done, 1100));
    assert.equal((await fetch(stale.parts[0].url, { method: 'PUT', body: block })).status, 403);
    // Renew without any UI or Dart runtime. Two provider PUTs in flight.
    const signed = await request(`${path}/parts/sign`, { ...epoch, partNumbers: [1, 2, 3] });
    assert.equal(signed.parts[2].lengthBytes, String(tail.length));
    const puts = await Promise.all(signed.parts.slice(0, 2).map((part: any) => fetch(part.url, { method: 'PUT', body: block })));
    puts.forEach(response => assert.equal(response.status, 200));
    assert.equal((await fetch(signed.parts[2].url, { method: 'PUT', body: tail })).status, 200);
    // Simulate process death before receipts: local control recovers all provider parts.
    const recovered = await request(`${path}/reconcile`, epoch);
    assert.equal(recovered.parts.length, 3); assert.equal(recovered.simulatedProviderListPages, 3);
    await request(`${path}/parts/receipts`, { ...epoch, parts: [{ ...recovered.parts[0], sizeBytes: '1' }] }, 409);
    await request(`${path}/parts/receipts`, { ...epoch, parts: recovered.parts });
    await assert.rejects(request(`${path}/complete`, { ...epoch, simulateLostResponse: true }));
    // Lost rotating Set-Cookie response requires same-owner login; it never causes a new file/MPU.
    await login(); assert.equal((await request(`${path}/reconcile`, epoch)).state, 'uploaded');
    const completed = await request(`${path}/complete`, epoch); assert.equal(completed.contentVerifiedByFixture, true);
    await request(`${path}/restart`, epoch, 409);
    assert.equal((await fetch(signed.parts[0].url, { method: 'PUT', body: block })).status >= 400, true);
    const second = await request('/api/v1/uploads', { ...input, clientUploadId: 'restart-contract-file' });
    const secondPath = `/api/v1/uploads/${second.fileId}`;
    await request(`${secondPath}/restart`, epoch, 409);
    await request(`${secondPath}/cancel`, epoch);
    assert.equal((await request(`${secondPath}/restart`, epoch)).transportEpoch, 2);
    await request(`${secondPath}/parts/sign`, { ...epoch, partNumbers: [1] }, 409);
    await request('/spike/logout', {}); await request('/api/v1/me', undefined, 401);
    const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.equal(persisted.uploads[plan.fileId].state, 'uploaded');
    assert.equal(persisted.counters.api_completions, 1);
    assert.ok(rotations >= 20);
    const evidence = { recordedAt: new Date().toISOString(), executionMode: 'node_protocol_test', simulated: true, realGoogle: false, realBetterAuth: false,
      realProvider: false, nativeAndroidExecuted: false, bytesVerified: input.sizeBytes, sha256: sha,
      scenarios: ['cookie_rotation_multiple_headers', 'immutable_replay', 'owner_isolation', 'url_expiry_renewal', 'two_parallel_puts',
        'receipt_loss_reconciliation', 'simulated_paginated_listing', 'lost_completion_response', 'same_owner_relogin', 'epoch_restart', 'logout'],
      counters: persisted.counters };
    await writeFile(new URL('./control-test-result.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
