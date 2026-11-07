/** Node-only SQLite adapter. Do not import this entry point into browser bundles. */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync } from 'node:fs';
import type { Note, NoteStore } from './index.js';

const FORMAT = 'mivw.notes';
const VERSION = 1;
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const MAX_NOTES = 10_000;
const MAX_ID = Number.MAX_SAFE_INTEGER - 1;

type Backup = { format: typeof FORMAT; version: typeof VERSION; notes: Note[] };

function validId(id: unknown): id is string {
  return typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) && Number(id) <= MAX_ID;
}
function validText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 4096;
}
function parseBackup(json: string): Backup {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_BACKUP_BYTES) throw new Error('Invalid backup size');
  let parsed: unknown;
  try { parsed = JSON.parse(json) as unknown; } catch { throw new Error('Invalid backup JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid backup');
  const object = parsed as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || object.format !== FORMAT || object.version !== VERSION ||
      !Array.isArray(object.notes) || object.notes.length > MAX_NOTES) throw new Error('Unsupported or invalid backup');
  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const item of object.notes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid note');
    const note = item as Record<string, unknown>;
    if (Object.keys(note).length !== 2 || !validId(note.id) || !validText(note.text) || seen.has(note.id)) throw new Error('Invalid note');
    seen.add(note.id);
    notes.push({ id: note.id, text: note.text });
  }
  return { format: FORMAT, version: VERSION, notes };
}

/** SQLite stored locally; a trusted host must control the path and close the store. */
export class SqliteNoteStore implements NoteStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    // Newly created data files are private by default; existing file modes are not changed.
    if (path !== ':memory:') {
      try { closeSync(openSync(path, 'wx', 0o600)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
        if (version === 0) {
          const existing = this.#db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.count;
          if (existing !== 0) throw new Error('Database is not empty');
          this.#db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL); PRAGMA user_version = 1');
        } else if (version !== VERSION) {
          throw new Error('Unsupported database version');
        }
        // Verify the expected table and columns exist before accepting this database.
        this.#db.prepare('SELECT id, text FROM notes LIMIT 0').all();
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  async create(text: string): Promise<Note> {
    if (!validText(text)) throw new Error('Invalid note');
    // Keep ID within the backup format and avoid claiming success on insert failure.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare('INSERT INTO notes (text) VALUES (?)').run(text);
      const id = String(result.lastInsertRowid);
      if (!validId(id)) throw new Error('Identifier limit reached');
      this.#db.exec('COMMIT');
      return Object.freeze({ id, text });
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async read(id: string): Promise<Note | undefined> {
    if (!validId(id)) return undefined;
    const row = this.#db.prepare('SELECT id, text FROM notes WHERE id = ?').get(id);
    if (!row) return undefined;
    if (!validId(String(row.id)) || !validText(row.text)) throw new Error('Invalid stored note');
    return Object.freeze({ id: String(row.id), text: row.text });
  }

  /** Plaintext; the trusted host must obtain user consent and choose a safe destination. */
  exportBackup(): string {
    const rows = this.#db.prepare('SELECT id, text FROM notes ORDER BY id LIMIT ?').all(MAX_NOTES + 1);
    if (rows.length > MAX_NOTES) throw new Error('Too many notes to export');
    const notes = rows.map((row) => ({ id: String(row.id), text: row.text }));
    const json = JSON.stringify({ format: FORMAT, version: VERSION, notes });
    parseBackup(json); // Validate stored values and ensure the export is restorable.
    return json;
  }

  /** All-or-nothing import into an empty database, called only by a trusted host. */
  restoreBackup(json: string): void {
    const backup = parseBackup(json);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.#db.prepare('SELECT count(*) AS count FROM notes').get()?.count;
      if (count !== 0) throw new Error('Restore requires an empty store');
      const insert = this.#db.prepare('INSERT INTO notes (id, text) VALUES (?, ?)');
      for (const note of backup.notes) insert.run(Number(note.id), note.text);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.#db.close(); }
}
