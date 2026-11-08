import test from 'node:test';
import assert from 'node:assert/strict';
import { Kernel } from '../dist/index.js';

function fixture() {
  let approvals = 0;
  const kernel = new Kernel({
    permissions: { agent: ['notes.create', 'notes.read'] },
    approveCreate: () => { approvals++; return true; },
  });
  return { kernel, approvals: () => approvals };
}
const create = (text) => ({ kind: 'notes.create', text });

async function assertDeniedWithoutEffects(kernel, input, approvals) {
  const result = await kernel.run('agent', input);
  assert.equal(result.status, 'denied');
  assert.deepEqual(result.observations, []);
  assert.equal(approvals(), 0);
  assert.deepEqual(kernel.audit(), []);
}

test('rejects changing and throwing getters without calling them', async () => {
  const { kernel, approvals } = fixture();
  let getterCalls = 0;
  const changing = { kind: 'notes.create', get text() { getterCalls++; return getterCalls <= 3 ? 'valid' : ''; } };
  const throwing = { kind: 'notes.create', get text() { getterCalls++; throw new Error('private'); } };
  const kindGetter = { get kind() { getterCalls++; return 'notes.create'; }, text: 'valid' };
  const idGetter = { kind: 'notes.read', get id() { getterCalls++; return '1'; } };
  for (const action of [changing, throwing, kindGetter, idGetter]) {
    await assertDeniedWithoutEffects(kernel, [action], approvals);
  }
  assert.equal(getterCalls, 0);
});

test('rejects array element accessors and sparse arrays without invoking getters', async () => {
  const { kernel, approvals } = fixture();
  let getterCalls = 0;
  const plan = [create('valid')];
  Object.defineProperty(plan, '0', { enumerable: true, get() { getterCalls++; return create('valid'); } });
  await assertDeniedWithoutEffects(kernel, plan, approvals);
  await assertDeniedWithoutEffects(kernel, new Array(1), approvals);
  assert.equal(getterCalls, 0);
});

test('rejects additional, hidden and symbol fields, inherited fields, and array extras', async () => {
  const { kernel, approvals } = fixture();
  const extra = { ...create('valid'), approved: true };
  const hidden = create('valid');
  Object.defineProperty(hidden, 'extra', { value: true });
  const symbol = { ...create('valid'), [Symbol('extra')]: true };
  const inherited = Object.assign(Object.create({ kind: 'notes.create' }), { text: 'valid' });
  const hiddenField = { kind: 'notes.create' };
  Object.defineProperty(hiddenField, 'text', { value: 'valid', enumerable: false });
  const arrayExtra = [create('valid')];
  arrayExtra.extra = true;
  for (const input of [[extra], [hidden], [symbol], [inherited], [hiddenField], arrayExtra]) {
    await assertDeniedWithoutEffects(kernel, input, approvals);
  }
});

test('throwing and revoked proxies are denied without leaking exceptions', async () => {
  const { kernel, approvals } = fixture();
  const thrower = () => { throw new Error('private-proxy-error'); };
  const revokedAction = Proxy.revocable(create('valid'), {});
  revokedAction.revoke();
  const revokedArray = Proxy.revocable([create('valid')], {});
  revokedArray.revoke();
  const badInputs = [
    [new Proxy(create('valid'), { ownKeys: thrower })],
    [new Proxy(create('valid'), { getPrototypeOf: thrower })],
    [new Proxy(create('valid'), { getOwnPropertyDescriptor: thrower })],
    new Proxy([create('valid')], { getOwnPropertyDescriptor: thrower }),
    new Proxy([create('valid')], { ownKeys: thrower }),
    [revokedAction.proxy], revokedArray.proxy,
  ];
  for (const input of badInputs) {
    const result = await kernel.run('agent', input);
    assert.equal(result.status, 'denied');
    assert.equal(JSON.stringify(result).includes('private-proxy-error'), false);
  }
  assert.equal(approvals(), 0);
  assert.deepEqual(kernel.audit(), []);
});

test('snapshots each action value once even when provided through a proxy', async () => {
  const { kernel, approvals } = fixture();
  const counts = { kind: 0, text: 0 };
  const source = create('original');
  const action = new Proxy(source, {
    get() { throw new Error('property get must not be used'); },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'kind' || key === 'text') counts[key]++;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === 'text' && counts.text > 1) return { ...descriptor, value: '' };
      return descriptor;
    },
  });
  const result = await kernel.run('agent', [action]);
  assert.equal(result.status, 'completed');
  assert.equal(result.observations[0].note.text, 'original');
  assert.deepEqual(counts, { kind: 1, text: 1 });
  assert.equal(approvals(), 1);
});

test('valid JSON data and null-prototype records still work; invalid fields fail', async () => {
  const { kernel } = fixture();
  const nullPrototype = Object.assign(Object.create(null), { kind: 'notes.read', id: '1' });
  const result = await kernel.run('agent', [...JSON.parse('[{"kind":"notes.create","text":"hello"}]'), nullPrototype]);
  assert.equal(result.status, 'completed');
  assert.equal(result.observations[1].note.text, 'hello');
  for (const input of [[{ kind: 'notes.create', text: 1 }], [{ kind: 'notes.read', id: '' }], [null], 'not-an-array']) {
    assert.equal((await kernel.run('agent', input)).status, 'denied');
  }
});

test('invalid second action rejects the whole plan before approval', async () => {
  const { kernel, approvals } = fixture();
  const result = await kernel.run('agent', [create('valid'), { kind: 'notes.create', get text() { throw new Error('no'); } }]);
  assert.equal(result.status, 'denied');
  assert.equal(approvals(), 0);
  assert.deepEqual(kernel.audit(), []);
});
