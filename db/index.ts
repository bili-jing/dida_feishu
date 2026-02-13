import { Database } from "bun:sqlite";
import type { Project, Task } from "../types.ts";

const DB_FILE = "./db/dida.db";

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_FILE);
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      kind TEXT,
      view_mode TEXT,
      raw TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (id, user_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT,
      content TEXT,
      "desc" TEXT,
      status INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      start_date TEXT,
      due_date TEXT,
      completed_time TEXT,
      created_time TEXT,
      modified_time TEXT,
      kind TEXT,
      tags TEXT,
      items TEXT,
      raw TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (id, user_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      user_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      extra TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      dida_task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      feishu_record_id TEXT,
      last_synced_at TEXT,
      last_modified_time TEXT,
      checksum TEXT,
      sync_status TEXT DEFAULT 'pending',
      PRIMARY KEY (dida_task_id, user_id)
    )
  `);

  // 索引：加速常用查询
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks (user_id, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_user_project ON tasks (user_id, project_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_state_user ON sync_state (user_id, sync_status)`);
}

// ─── 缓存的 Prepared Statements ───────────────────────

let _stmtUpsertProject: ReturnType<Database["prepare"]> | null = null;
let _stmtUpsertTask: ReturnType<Database["prepare"]> | null = null;

function getUpsertProjectStmt() {
  if (!_stmtUpsertProject) {
    _stmtUpsertProject = getDb().prepare(`
      INSERT INTO projects (id, user_id, name, kind, view_mode, raw)
      VALUES ($id, $userId, $name, $kind, $viewMode, $raw)
      ON CONFLICT (id, user_id) DO UPDATE SET
        name = excluded.name, kind = excluded.kind,
        view_mode = excluded.view_mode, raw = excluded.raw,
        updated_at = datetime('now')
    `);
  }
  return _stmtUpsertProject;
}

function getUpsertTaskStmt() {
  if (!_stmtUpsertTask) {
    _stmtUpsertTask = getDb().prepare(`
      INSERT INTO tasks (id, user_id, project_id, title, content, "desc", status, priority,
        start_date, due_date, completed_time, created_time, modified_time, kind, tags, items, raw)
      VALUES ($id, $userId, $projectId, $title, $content, $desc, $status, $priority,
        $startDate, $dueDate, $completedTime, $createdTime, $modifiedTime, $kind, $tags, $items, $raw)
      ON CONFLICT (id, user_id) DO UPDATE SET
        project_id = excluded.project_id, title = excluded.title,
        content = excluded.content, "desc" = excluded."desc",
        status = excluded.status, priority = excluded.priority,
        start_date = excluded.start_date, due_date = excluded.due_date,
        completed_time = excluded.completed_time, created_time = excluded.created_time,
        modified_time = excluded.modified_time, kind = excluded.kind,
        tags = excluded.tags, items = excluded.items, raw = excluded.raw,
        updated_at = datetime('now')
    `);
  }
  return _stmtUpsertTask;
}

// ─── 批量操作 ─────────────────────────────────────────

/** 批量 upsert 项目 */
export function upsertProjects(userId: string, projects: Project[]) {
  if (!projects.length) return;
  const stmt = getUpsertProjectStmt();
  const batch = getDb().transaction((items: Project[]) => {
    for (const p of items) {
      stmt.run({
        $id: p.id, $userId: userId, $name: p.name,
        $kind: p.kind ?? null, $viewMode: p.viewMode ?? null,
        $raw: JSON.stringify(p),
      });
    }
  });
  batch(projects);
}

/** 批量 upsert 任务 */
export function upsertTasks(userId: string, tasks: Task[]) {
  if (!tasks.length) return;
  const stmt = getUpsertTaskStmt();
  const batch = getDb().transaction((items: Task[]) => {
    for (const t of items) {
      stmt.run({
        $id: t.id, $userId: userId, $projectId: t.projectId,
        $title: t.title, $content: t.content ?? null, $desc: t.desc ?? null,
        $status: t.status, $priority: t.priority,
        $startDate: t.startDate ?? null, $dueDate: t.dueDate ?? null,
        $completedTime: t.completedTime ?? null, $createdTime: t.createdTime ?? null,
        $modifiedTime: t.modifiedTime ?? null, $kind: t.kind ?? null,
        $tags: t.tags ? JSON.stringify(t.tags) : null,
        $items: t.items ? JSON.stringify(t.items) : null,
        $raw: JSON.stringify(t),
      });
    }
  });
  batch(tasks);
}

// ─── Token 缓存 ──────────────────────────────────────

export function getCachedToken(userId: string): { token: string; extra: any; created_at: number } | null {
  const row = getDb().query(
    `SELECT token, extra, created_at FROM tokens WHERE user_id = ?`
  ).get(userId) as any;
  if (!row) return null;
  return {
    token: row.token,
    extra: row.extra ? JSON.parse(row.extra) : null,
    created_at: row.created_at,
  };
}

export function saveToken(userId: string, token: string, extra: any) {
  getDb().run(`
    INSERT INTO tokens (user_id, token, extra, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      token = excluded.token, extra = excluded.extra, created_at = excluded.created_at
  `, [userId, token, extra ? JSON.stringify(extra) : null, Math.floor(Date.now() / 1000)]);
}

// ─── 统计 ─────────────────────────────────────────────

export function getStats(userId: string) {
  const db = getDb();
  const projectCount = (db.query(
    `SELECT COUNT(*) as c FROM projects WHERE user_id = ?`
  ).get(userId) as any).c;

  const rows = db.query(
    `SELECT status, COUNT(*) as c FROM tasks WHERE user_id = ? GROUP BY status`
  ).all(userId) as { status: number; c: number }[];

  const m = new Map(rows.map(r => [r.status, r.c]));
  const total = rows.reduce((s, r) => s + r.c, 0);

  return { projects: projectCount, active: m.get(0) ?? 0, completed: m.get(2) ?? 0, abandoned: m.get(-1) ?? 0, total };
}

// ─── 生命周期 ─────────────────────────────────────────

export function closeDb() {
  _stmtUpsertProject = null;
  _stmtUpsertTask = null;
  if (_db) { _db.close(); _db = null; }
}
