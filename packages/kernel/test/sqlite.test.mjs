import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Kernel } from '../dist/index.js';
import { SqliteNoteStore } from '../dist/node.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mivw-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'memory.sqlite');
}
const makeKernel = (store) => new Kernel({ store, permissions: { a: ['notes.read', 'notes.create'] }, approveCreate: () => true });
const backup = (notes) => JSON.stringify({ format: 'mivw.notes', version: 1, notes });

test('approved notes survive closing and reopening in a separate process', async (t) => {
  const file = fixture(t);
  const store = new SqliteNoteStore(file);
  const result = await makeKernel(store).run('a', [{ kind: 'notes.create', text: 'بيانات دائمة' }]);
  assert.equal(result.status, 'completed');
  assert.equal(result.observations[0].note.id, '1');
  store.close();
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);
  const modulePath = resolve('dist/node.js');
  const script = `import { SqliteNoteStore } from ${JSON.stringify('file://' + modulePath)}; const s = new SqliteNoteStore(process.argv[1]); console.log(JSON.stringify(await s.read('1'))); s.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { id: '1', text: 'بيانات دائمة' });
  const reopened = new SqliteNoteStore(file);
  assert.equal((await reopened.create('ثانية')).id, '2');
  reopened.close();
});

test('exports and restores a versioned backup into an empty store', async (t) => {
  const source = new SqliteNoteStore(fixture(t));
  await source.create('one'); await source.create('اثنان');
  const exported = source.exportBackup();
  const target = new SqliteNoteStore(':memory:');
  target.restoreBackup(exported);
  assert.equal(target.exportBackup(), exported);
  assert.equal((await target.create('three')).id, '3');
  assert.throws(() => target.restoreBackup(exported), /empty store/);
  assert.equal((await target.read('1')).text, 'one');
  source.close(); target.close();
});

test('rejects malformed, unsupported, oversized, duplicate and extra data without writing', (t) => {
  const target = new SqliteNoteStore(fixture(t));
  for (const value of [
    'invalid', JSON.stringify({ format: 'mivw.notes', version: 2, notes: [] }),
    backup([{ id: '1', text: 'a' }, { id: '1', text: 'b' }]),
    backup([{ id: '0', text: 'a' }]), backup([{ id: '1', text: '' }]),
    backup([{ id: '1', text: 'ok', secret: 'hidden' }]),
    ' '.repeat(50 * 1024 * 1024 + 1),
  ]) assert.throws(() => target.restoreBackup(value));
  assert.equal(target.exportBackup(), backup([]));
  target.close();
});

test('a database error during import rolls back every inserted note', (t) => {
  const file = fixture(t);
  const store = new SqliteNoteStore(file);
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON notes WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => store.restoreBackup(backup([{ id: '1', text: 'first' }, { id: '2', text: 'fail' }])));
  assert.equal(store.exportBackup(), backup([]));
  db.close(); store.close();
});

test('storage errors fail closed without falling back to memory', async () => {
  const store = { create: async () => { throw new Error('private error'); }, read: async () => { throw new Error('private error'); } };
  const kernel = makeKernel(store);
  const created = await kernel.run('a', [{ kind: 'notes.create', text: 'test' }]);
  const read = await kernel.run('a', [{ kind: 'notes.read', id: '1' }]);
  assert.equal(created.status, 'failed'); assert.equal(read.status, 'failed');
  assert.equal(JSON.stringify([created, read, kernel.audit()]).includes('private error'), false);
});

test('rejects an unrelated existing database and unknown versions', (t) => {
  const file = fixture(t);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE other (id INTEGER)'); db.close();
  assert.throws(() => new SqliteNoteStore(file), /not empty/);
  const unknown = fixture(t);
  const db2 = new DatabaseSync(unknown); db2.exec('PRAGMA user_version = 99'); db2.close();
  assert.throws(() => new SqliteNoteStore(unknown), /Unsupported/);
});

test('permission and approval denial never write to persistent storage', async (t) => {
  const store = new SqliteNoteStore(fixture(t));
  const noPermission = new Kernel({ store, permissions: { a: ['notes.read'] }, approveCreate: () => true });
  const noApproval = new Kernel({ store, permissions: { a: ['notes.create'] }, approveCreate: () => false });
  assert.equal((await noPermission.run('a', [{ kind: 'notes.create', text: 'no' }])).status, 'denied');
  assert.equal((await noApproval.run('a', [{ kind: 'notes.create', text: 'no' }])).status, 'denied');
  assert.equal(store.exportBackup(), backup([]));
  store.close();
});
