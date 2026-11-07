import test from 'node:test';
import assert from 'node:assert/strict';
import { Kernel } from '../dist/index.js';

const create = (text) => ({ kind: 'notes.create', text });
const read = (id) => ({ kind: 'notes.read', id });

test('executes an approved plan and observes actual in-memory data', async () => {
  const approvals = [];
  const kernel = new Kernel({
    permissions: { alice: ['notes.create', 'notes.read'] },
    approveCreate: (request) => { approvals.push(request); return true; },
  });
  const result = await kernel.run('alice', [create('ملاحظة حقيقية'), read('1')]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.phases, ['understand', 'plan', 'act', 'observe', 'reflect']);
  assert.equal(result.observations[1].note.text, 'ملاحظة حقيقية');
  assert.deepEqual(approvals.map((r) => r.action.text), ['ملاحظة حقيقية']);
  assert.deepEqual(kernel.audit().map((e) => e.status), ['completed', 'completed']);
  assert.equal(JSON.stringify(kernel.audit()).includes('ملاحظة حقيقية'), false);
});

test('denies missing capability before approval and stops subsequent actions', async () => {
  let calls = 0;
  const kernel = new Kernel({ permissions: { agent: ['notes.read'] }, approveCreate: () => { calls++; return true; } });
  const result = await kernel.run('agent', [create('secret'), read('1')]);
  assert.equal(result.status, 'denied');
  assert.equal(result.observations.length, 1);
  assert.equal(calls, 0);
  assert.equal(kernel.audit().length, 1);
});

test('defaults to deny without an approval handler', async () => {
  const kernel = new Kernel({ permissions: { agent: ['notes.create', 'notes.read'] } });
  assert.equal((await kernel.run('agent', [create('blocked')])).status, 'denied');
  assert.equal((await kernel.run('agent', [read('1')])).status, 'failed');
});

test('explicit refusal and non-true approval values fail closed', async () => {
  for (const value of [false, undefined, 'yes', 1]) {
    const kernel = new Kernel({ permissions: { agent: ['notes.create'] }, approveCreate: () => value });
    assert.equal((await kernel.run('agent', [create('blocked')])).status, 'denied');
  }
});

test('approval exception is a failure and does not leak its message', async () => {
  const kernel = new Kernel({ permissions: { agent: ['notes.create'] }, approveCreate: () => { throw new Error('token-secret'); } });
  const result = await kernel.run('agent', [create('blocked')]);
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify([result, kernel.audit()]).includes('token-secret'), false);
});

test('validates whole plan before doing any work', async () => {
  let calls = 0;
  const kernel = new Kernel({ permissions: { agent: ['notes.create'] }, approveCreate: () => { calls++; return true; } });
  for (const plan of [[], [create('valid'), { kind: 'network.send', url: 'https://example.com' }], [create('')], [create('x'.repeat(4097))], [{ ...create('valid'), approved: true }], Array(21).fill(create('x'))]) {
    assert.equal((await kernel.run('agent', plan)).status, 'denied');
  }
  assert.equal(calls, 0);
  assert.equal(kernel.audit().length, 0);
});

test('unknown agent is denied; permission configuration is snapshotted', async () => {
  const permissions = { agent: ['notes.read'] };
  const kernel = new Kernel({ permissions, approveCreate: () => true });
  permissions.agent.push('notes.create');
  assert.equal((await kernel.run('impostor', [read('1')])).status, 'denied');
  assert.equal((await kernel.run('agent', [create('blocked')])).status, 'denied');
});

test('missing note is a failure and stops the remaining steps', async () => {
  const kernel = new Kernel({ permissions: { agent: ['notes.create', 'notes.read'] }, approveCreate: () => true });
  const result = await kernel.run('agent', [read('missing'), create('should not be stored')]);
  assert.equal(result.status, 'failed');
  assert.equal(result.observations.length, 1);
  assert.equal((await kernel.run('agent', [read('1')])).status, 'failed');
});

test('approval is bound to a copied, immutable action', async () => {
  let release;
  let request;
  const kernel = new Kernel({ permissions: { agent: ['notes.create', 'notes.read'] }, approveCreate: (value) => {
    request = value;
    return new Promise((resolve) => { release = resolve; });
  } });
  const action = create('original');
  const pending = kernel.run('agent', [action]);
  action.text = 'changed';
  assert.throws(() => { request.action.text = 'tampered'; }, TypeError);
  release(true);
  const result = await pending;
  assert.equal(result.observations[0].note.text, 'original');
});

test('memory is local to a kernel instance and audit snapshots are immutable', async () => {
  const options = { permissions: { agent: ['notes.create', 'notes.read'] }, approveCreate: () => true };
  const first = new Kernel(options);
  await first.run('agent', [create('temporary')]);
  const events = first.audit();
  assert.throws(() => events.push({}), TypeError);
  assert.throws(() => { events[0].status = 'failed'; }, TypeError);
  assert.equal((await new Kernel(options).run('agent', [read('1')])).status, 'failed');
});

test('rejects invalid permission configuration', () => {
  assert.throws(() => new Kernel({ permissions: { agent: ['network.send'] } }), /Invalid permission/);
});
