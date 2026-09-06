import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebError, canonical, contentHash, demoResult, digest } from './domain.js';
import type { SavedRequest, Submission } from './domain.js';

export interface Agent {
  id: string;
  username: string;
  passwordHash: string;
  role: 'agent';
  disabled: number;
}
export interface Session {
  userId: string;
  username: string;
  csrf: string;
  expiresAt: number;
}
type Row = Record<string, unknown>;

export class WebStore {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly now: () => number = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'agent' CHECK(role = 'agent'), disabled INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS login_limits (
        bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), reference TEXT NOT NULL,
        submission_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
        content_hash TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(actor_id, submission_key), UNIQUE(actor_id, reference)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS submission_keys (
        actor_id TEXT NOT NULL REFERENCES users(id), submission_key TEXT NOT NULL,
        request_id TEXT NOT NULL REFERENCES requests(id), PRIMARY KEY(actor_id, submission_key)
      ) STRICT;
      INSERT OR IGNORE INTO submission_keys (actor_id,submission_key,request_id)
        SELECT actor_id,submission_key,id FROM requests;
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY, actor_id TEXT, request_id TEXT REFERENCES requests(id),
        action TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL
      ) STRICT;
      -- Reserved for a future, independently authorized worker; V1 never populates these.
      CREATE TABLE IF NOT EXISTS execution_attempts (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), version INTEGER NOT NULL,
        step TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress','uncertain','verified','not_created','failed')),
        content_hash TEXT NOT NULL, started_at INTEGER NOT NULL, reconciled_at INTEGER,
        UNIQUE(request_id, version, step)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS created_records (
        id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
        record_kind TEXT NOT NULL, record_id TEXT NOT NULL, verified_at INTEGER NOT NULL,
        UNIQUE(attempt_id, record_kind, record_id)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS immutable_request BEFORE UPDATE ON requests
        BEGIN SELECT RAISE(ABORT, 'Submitted requests are immutable in V1'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_audit_update BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_audit_delete BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
      PRAGMA user_version = 1;
    `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  audit(actorId: string | null, requestId: string | null, action: string, detail = '') {
    this.db
      .prepare('INSERT INTO audit_events (actor_id,request_id,action,at,detail) VALUES (?,?,?,?,?)')
      .run(actorId, requestId, action, this.now(), detail);
  }
  agent(username: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row) return undefined;
    return {
      id: String(row.id),
      username: String(row.username),
      passwordHash: String(row.password_hash),
      role: 'agent',
      disabled: Number(row.disabled),
    };
  }
  provision(username: string, passwordHash: string, options: { createOnly?: boolean } = {}) {
    this.transaction(() => {
      const existing = this.agent(username);
      if (options.createOnly && existing)
        throw new WebError(
          409,
          'Agent already exists. Run interactive setup to rotate its password.',
        );
      const id = existing?.id ?? randomUUID();
      this.db
        .prepare(`INSERT INTO users (id,username,password_hash) VALUES (?,?,?)
        ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,disabled=0`)
        .run(id, username, passwordHash);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.audit(id, null, existing ? 'agent_password_rotated' : 'agent_provisioned');
    });
  }
  chargeLogin(username: string) {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM login_limits WHERE expires_at <= ?').run(this.now());
      for (const [bucket, max] of [
        [digest(username.toLowerCase()), 10],
        ['global', 100],
      ] as const) {
        const row = this.db.prepare('SELECT count FROM login_limits WHERE bucket = ?').get(bucket);
        if (Number(row?.count ?? 0) >= max) return false;
      }
      for (const bucket of [digest(username.toLowerCase()), 'global']) {
        this.db
          .prepare(`INSERT INTO login_limits VALUES (?,1,?)
          ON CONFLICT(bucket) DO UPDATE SET count=count+1`)
          .run(bucket, this.now() + 15 * 60_000);
      }
      return true;
    });
  }
  newSession(agent: Agent) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    this.transaction(() => {
      // Password verification is asynchronous. Recheck its credential snapshot under the write lock.
      const current = this.db
        .prepare(
          "SELECT id FROM users WHERE id=? AND password_hash=? AND disabled=0 AND role='agent'",
        )
        .get(agent.id, agent.passwordHash);
      if (!current) throw new WebError(401, 'שם המשתמש או הסיסמה אינם נכונים.');
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
      this.db
        .prepare('INSERT INTO sessions VALUES (?,?,?,?)')
        .run(digest(token), agent.id, csrf, this.now() + 8 * 60 * 60_000);
      this.audit(agent.id, null, 'login_succeeded');
    });
    return token;
  }
  session(token: string): Session | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db
      .prepare(`SELECT users.id,users.username,sessions.csrf,sessions.expires_at FROM sessions
      JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? AND disabled=0 AND role='agent'`)
      .get(digest(token), this.now());
    return row
      ? {
          userId: String(row.id),
          username: String(row.username),
          csrf: String(row.csrf),
          expiresAt: Number(row.expires_at),
        }
      : undefined;
  }
  logout(token: string) {
    const session = this.session(token);
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
      if (session) this.audit(session.userId, null, 'logout');
    });
  }
  private requestFromRow(row: Row): SavedRequest {
    return {
      id: String(row.id),
      actorId: String(row.actor_id),
      version: Number(row.version),
      contentHash: String(row.content_hash),
      payload: JSON.parse(String(row.payload)),
      createdAt: Number(row.created_at),
      result: JSON.parse(String(row.result)),
    };
  }
  submit(
    actorId: string,
    key: string,
    payload: Submission,
  ): { request: SavedRequest; duplicate: boolean } {
    return this.transaction(() => {
      const agent = this.db
        .prepare("SELECT id FROM users WHERE id=? AND role='agent' AND disabled=0")
        .get(actorId);
      if (!agent) throw new WebError(403, 'החשבון אינו מורשה לשלוח בקשות.');
      const hash = contentHash(actorId, 1, payload);
      const keyMatch = this.db
        .prepare(`SELECT requests.* FROM submission_keys JOIN requests ON requests.id=submission_keys.request_id
          WHERE submission_keys.actor_id=? AND submission_keys.submission_key=?`)
        .get(actorId, key);
      const refMatch = this.db
        .prepare('SELECT * FROM requests WHERE actor_id=? AND reference=?')
        .get(actorId, payload.reference);
      if (keyMatch || refMatch) {
        const row = keyMatch ?? refMatch;
        if (
          !row ||
          row.content_hash !== hash ||
          (keyMatch && refMatch && keyMatch.id !== refMatch.id)
        ) {
          throw new WebError(
            409,
            'מפתח השליחה או האסמכתה כבר שימשו לתוכן אחר. יש לבדוק את הבקשה הקיימת ברשימת הבקשות.',
          );
        }
        if (!keyMatch)
          this.db.prepare('INSERT INTO submission_keys VALUES (?,?,?)').run(actorId, key, row.id);
        this.audit(actorId, String(row.id), 'duplicate_prevented', hash);
        return { request: this.requestFromRow(row), duplicate: true };
      }
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          actorId,
          payload.reference,
          key,
          1,
          hash,
          canonical(payload),
          JSON.stringify(demoResult),
          this.now(),
        );
      this.db.prepare('INSERT INTO submission_keys VALUES (?,?,?)').run(actorId, key, id);
      this.audit(actorId, id, 'request_saved', hash);
      const request = this.get(actorId, id);
      return { request, duplicate: false };
    });
  }
  get(actorId: string, id: string): SavedRequest {
    const row = this.db
      .prepare('SELECT * FROM requests WHERE id=? AND actor_id=?')
      .get(id, actorId);
    if (!row) throw new WebError(404, 'הבקשה לא נמצאה.');
    return this.requestFromRow(row);
  }
  list(actorId: string, reference = '', page = 0) {
    const rows = reference
      ? this.db
          .prepare(
            'SELECT * FROM requests WHERE actor_id=? AND reference=? ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?',
          )
          .all(actorId, reference, page * 50)
      : this.db
          .prepare(
            'SELECT * FROM requests WHERE actor_id=? ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET ?',
          )
          .all(actorId, page * 50);
    return {
      requests: rows.slice(0, 50).map((row) => this.requestFromRow(row)),
      hasMore: rows.length > 50,
    };
  }
  events(actorId: string, id: string) {
    this.get(actorId, id);
    return this.db
      .prepare('SELECT action,at FROM audit_events WHERE request_id=? ORDER BY id DESC LIMIT 50')
      .all(id);
  }
}
