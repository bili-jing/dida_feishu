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

  db.run(`
    CREATE TABLE IF NOT EXISTS feishu_config (
      user_id TEXT PRIMARY KEY,
      app_token TEXT NOT NULL,
      table_id TEXT NOT NULL,
      app_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attachment_cache (
      attachment_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      local_path TEXT,
      feishu_file_token TEXT,
      downloaded_at TEXT,
      uploaded_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS feishu_credentials (
      user_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      app_secret TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 迁移：给旧 tokens 表加 expires_at 列，并回填默认值
  try { db.run(`ALTER TABLE tokens ADD COLUMN expires_at INTEGER`); } catch {}
  db.run(`UPDATE tokens SET expires_at = created_at + 2592000 WHERE expires_at IS NULL`);

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

export function getCachedToken(userId: string): { token: string; extra: any; created_at: number; expires_at: number } | null {
  const row = getDb().query(
    `SELECT token, extra, created_at, expires_at FROM tokens WHERE user_id = ?`
  ).get(userId) as any;
  if (!row) return null;
  return {
    token: row.token,
    extra: row.extra ? JSON.parse(row.extra) : null,
    created_at: row.created_at,
    expires_at: row.expires_at ?? (row.created_at + 86400),
  };
}

export function saveToken(userId: string, token: string, extra: any, expiresAt?: number) {
  const now = Math.floor(Date.now() / 1000);
  getDb().run(`
    INSERT INTO tokens (user_id, token, extra, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      token = excluded.token, extra = excluded.extra,
      created_at = excluded.created_at, expires_at = excluded.expires_at
  `, [userId, token, extra ? JSON.stringify(extra) : null, now, expiresAt ?? (now + 30 * 86400)]);
}

/** 获取所有未过期的缓存用户 */
export function getValidUsers(): { user_id: string; extra: any; expires_at: number }[] {
  const now = Math.floor(Date.now() / 1000);
  return (getDb().query(
    `SELECT user_id, extra, expires_at FROM tokens WHERE expires_at > ? ORDER BY created_at DESC`
  ).all(now) as any[]).map(r => ({
    user_id: r.user_id,
    extra: r.extra ? JSON.parse(r.extra) : null,
    expires_at: r.expires_at,
  }));
}

/** 删除用户的所有数据（token + 项目 + 任务 + 同步状态 + 飞书配置 + 飞书凭据） */
export function deleteUser(userId: string) {
  const db = getDb();
  db.run(`DELETE FROM tokens WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM projects WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM tasks WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM sync_state WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM feishu_config WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM feishu_credentials WHERE user_id = ?`, [userId]);
}

// ─── 飞书配置 ────────────────────────────────────────

export interface FeishuConfig {
  user_id: string;
  app_token: string;
  table_id: string;
  app_url: string | null;
}

export function getFeishuConfig(userId: string): FeishuConfig | null {
  const row = getDb().query(
    `SELECT user_id, app_token, table_id, app_url FROM feishu_config WHERE user_id = ?`
  ).get(userId) as any;
  return row ?? null;
}

export function saveFeishuConfig(userId: string, appToken: string, tableId: string, appUrl?: string) {
  getDb().run(`
    INSERT INTO feishu_config (user_id, app_token, table_id, app_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      app_token = excluded.app_token, table_id = excluded.table_id,
      app_url = excluded.app_url, updated_at = datetime('now')
  `, [userId, appToken, tableId, appUrl ?? null]);
}

// ─── 飞书凭据（per-user app_id/app_secret） ─────────

export interface FeishuCredentials {
  user_id: string;
  app_id: string;
  app_secret: string;
}

export function getFeishuCredentials(userId: string): FeishuCredentials | null {
  const row = getDb().query(
    `SELECT user_id, app_id, app_secret FROM feishu_credentials WHERE user_id = ?`
  ).get(userId) as any;
  return row ?? null;
}

export function saveFeishuCredentials(userId: string, appId: string, appSecret: string) {
  getDb().run(`
    INSERT INTO feishu_credentials (user_id, app_id, app_secret)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      app_id = excluded.app_id, app_secret = excluded.app_secret,
      updated_at = datetime('now')
  `, [userId, appId, appSecret]);
}

export function deleteFeishuCredentials(userId: string) {
  getDb().run(`DELETE FROM feishu_credentials WHERE user_id = ?`, [userId]);
}

// ─── 同步状态查询 ────────────────────────────────────

export interface SyncRecord {
  dida_task_id: string;
  feishu_record_id: string | null;
  last_modified_time: string | null;
  sync_status: string;
}

/** 获取用户所有已同步记录的映射 { dida_task_id → SyncRecord } */
export function getSyncMap(userId: string): Map<string, SyncRecord> {
  const rows = getDb().query(
    `SELECT dida_task_id, feishu_record_id, last_modified_time, sync_status
     FROM sync_state WHERE user_id = ?`
  ).all(userId) as SyncRecord[];
  return new Map(rows.map(r => [r.dida_task_id, r]));
}

/** 批量更新同步状态 */
export function batchUpsertSyncState(
  userId: string,
  items: Array<{ taskId: string; recordId: string; modifiedTime: string | null }>
) {
  const stmt = getDb().prepare(`
    INSERT INTO sync_state (dida_task_id, user_id, feishu_record_id, last_synced_at, last_modified_time, sync_status)
    VALUES (?, ?, ?, datetime('now'), ?, 'synced')
    ON CONFLICT (dida_task_id, user_id) DO UPDATE SET
      feishu_record_id = excluded.feishu_record_id,
      last_synced_at = datetime('now'),
      last_modified_time = excluded.last_modified_time,
      sync_status = 'synced'
  `);
  const batch = getDb().transaction(() => {
    for (const item of items) {
      stmt.run(item.taskId, userId, item.recordId, item.modifiedTime);
    }
  });
  batch();
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

// ─── 附件缓存 ────────────────────────────────────────

export interface AttachmentCacheRow {
  attachment_id: string;
  user_id: string;
  task_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  local_path: string | null;
  feishu_file_token: string | null;
  downloaded_at: string | null;
  uploaded_at: string | null;
}

/** 获取已缓存的附件信息 */
export function getAttachmentCache(attachmentId: string): AttachmentCacheRow | null {
  return getDb().query(
    `SELECT * FROM attachment_cache WHERE attachment_id = ?`
  ).get(attachmentId) as AttachmentCacheRow | null;
}

/** 保存附件下载信息 */
export function saveAttachmentDownload(
  attachmentId: string, userId: string, taskId: string,
  fileName: string, fileType: string, fileSize: number, localPath: string
) {
  getDb().run(`
    INSERT INTO attachment_cache (attachment_id, user_id, task_id, file_name, file_type, file_size, local_path, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (attachment_id) DO UPDATE SET
      local_path = excluded.local_path, downloaded_at = datetime('now')
  `, [attachmentId, userId, taskId, fileName, fileType, fileSize, localPath]);
}

/** 保存附件上传后的 file_token */
export function saveAttachmentUpload(attachmentId: string, fileToken: string) {
  getDb().run(`
    UPDATE attachment_cache SET feishu_file_token = ?, uploaded_at = datetime('now')
    WHERE attachment_id = ?
  `, [fileToken, attachmentId]);
}

/** 获取任务的所有已上传附件 token */
export function getTaskFileTokens(taskId: string): Array<{ file_token: string; file_name: string }> {
  return getDb().query(
    `SELECT feishu_file_token as file_token, file_name FROM attachment_cache
     WHERE task_id = ? AND feishu_file_token IS NOT NULL`
  ).all(taskId) as any[];
}

/** 清除用户的附件缓存 */
export function clearAttachmentCache(userId: string) {
  getDb().run(`DELETE FROM attachment_cache WHERE user_id = ?`, [userId]);
}

// ─── 同步对比 ─────────────────────────────────────────

export interface SyncComparison {
  total: number;
  synced: number;
  newTasks: number;
  modified: number;
  unchanged: number;
}

/** 对比本地任务与飞书同步状态 */
export function getSyncComparison(userId: string): SyncComparison {
  const db = getDb();
  const total = (db.query(
    `SELECT COUNT(*) as c FROM tasks WHERE user_id = ?`
  ).get(userId) as any).c;

  const synced = (db.query(
    `SELECT COUNT(*) as c FROM sync_state WHERE user_id = ? AND sync_status = 'synced'`
  ).get(userId) as any).c;

  // 新增：在 tasks 中但不在 sync_state 中
  const newTasks = (db.query(
    `SELECT COUNT(*) as c FROM tasks t
     WHERE t.user_id = ? AND NOT EXISTS (
       SELECT 1 FROM sync_state s WHERE s.dida_task_id = t.id AND s.user_id = t.user_id
     )`
  ).get(userId) as any).c;

  // 修改：modified_time 不一致
  const modified = (db.query(
    `SELECT COUNT(*) as c FROM tasks t
     JOIN sync_state s ON t.id = s.dida_task_id AND t.user_id = s.user_id
     WHERE t.user_id = ? AND t.modified_time != s.last_modified_time`
  ).get(userId) as any).c;

  return { total, synced, newTasks, modified, unchanged: synced - modified };
}

// ─── 任务搜索 ─────────────────────────────────────────

export interface TaskSearchResult {
  id: string;
  title: string;
  status: number;
  project_name: string | null;
  modified_time: string | null;
  sync_status: string | null;  // 'synced' | null (未同步)
}

/** 搜索任务（标题/内容模糊匹配），返回匹配结果 */
export function searchTasks(userId: string, keyword: string, limit = 20): TaskSearchResult[] {
  const pattern = `%${keyword}%`;
  return getDb().query(
    `SELECT t.id, t.title, t.status, p.name as project_name, t.modified_time,
            s.sync_status
     FROM tasks t
     LEFT JOIN projects p ON t.project_id = p.id AND t.user_id = p.user_id
     LEFT JOIN sync_state s ON t.id = s.dida_task_id AND t.user_id = s.user_id
     WHERE t.user_id = ? AND (t.title LIKE ? OR t.content LIKE ?)
     ORDER BY t.modified_time DESC
     LIMIT ?`
  ).all(userId, pattern, pattern, limit) as TaskSearchResult[];
}

/** 获取任务详情 */
export function getTaskDetail(userId: string, taskId: string) {
  return getDb().query(
    `SELECT t.*, p.name as project_name, s.sync_status, s.feishu_record_id, s.last_synced_at
     FROM tasks t
     LEFT JOIN projects p ON t.project_id = p.id AND t.user_id = p.user_id
     LEFT JOIN sync_state s ON t.id = s.dida_task_id AND t.user_id = s.user_id
     WHERE t.user_id = ? AND t.id = ?`
  ).get(userId, taskId) as any;
}

/** 获取未同步的任务列表 */
export function getUnsyncedTasks(userId: string, limit = 20): TaskSearchResult[] {
  return getDb().query(
    `SELECT t.id, t.title, t.status, p.name as project_name, t.modified_time,
            NULL as sync_status
     FROM tasks t
     LEFT JOIN projects p ON t.project_id = p.id AND t.user_id = p.user_id
     WHERE t.user_id = ? AND NOT EXISTS (
       SELECT 1 FROM sync_state s WHERE s.dida_task_id = t.id AND s.user_id = t.user_id
     )
     ORDER BY t.modified_time DESC
     LIMIT ?`
  ).all(userId, limit) as TaskSearchResult[];
}

/** 获取已修改（需重新同步）的任务列表 */
export function getModifiedTasks(userId: string, limit = 20): TaskSearchResult[] {
  return getDb().query(
    `SELECT t.id, t.title, t.status, p.name as project_name, t.modified_time,
            s.sync_status
     FROM tasks t
     JOIN sync_state s ON t.id = s.dida_task_id AND t.user_id = s.user_id
     WHERE t.user_id = ? AND t.modified_time != s.last_modified_time
     ORDER BY t.modified_time DESC
     LIMIT ?`
  ).all(userId, limit) as TaskSearchResult[];
}

// ─── 生命周期 ─────────────────────────────────────────

export function closeDb() {
  _stmtUpsertProject = null;
  _stmtUpsertTask = null;
  if (_db) { _db.close(); _db = null; }
}
