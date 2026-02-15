/**
 * 增量同步脚本：从 SQLite 读取滴答任务 → 写入飞书多维表格
 *
 * - 首次同步：创建多维表格 + 写入全部任务
 * - 后续同步：只处理新增和变更的任务，已同步的不重复写入
 *
 * 用法:
 *   bun run sync.ts                     # 同步所有用户
 *   bun run sync.ts --user test         # 同步指定用户
 *   bun run sync.ts --reset             # 清除飞书配置，强制全量重建
 */

import { Database } from "bun:sqlite";
import {
  createBitable,
  createTable,
  createView,
  batchCreateRecords,
  batchUpdateRecords,
  getBitableInfo,
  type BitableField,
} from "./feishu/client.ts";

const DB_FILE = "./db/dida.db";

interface TaskRow {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  content: string | null;
  desc: string | null;
  status: number;
  priority: number;
  start_date: string | null;
  due_date: string | null;
  completed_time: string | null;
  created_time: string | null;
  modified_time: string | null;
  tags: string | null;
  items: string | null;
  project_name: string | null;
}

// ─── 字段定义 ─────────────────────────────────────────

const TASK_FIELDS: BitableField[] = [
  { field_name: "任务名称", type: 1 },
  { field_name: "状态", type: 3, property: {
    options: [
      { name: "进行中", color: 0 },
      { name: "已完成", color: 1 },
      { name: "已放弃", color: 2 },
    ],
  }},
  { field_name: "优先级", type: 3, property: {
    options: [
      { name: "无", color: 3 },
      { name: "低", color: 0 },
      { name: "中", color: 4 },
      { name: "高", color: 2 },
    ],
  }},
  { field_name: "所属清单", type: 1 },
  { field_name: "内容", type: 1 },
  { field_name: "标签", type: 4, property: { options: [] }},
  { field_name: "创建时间", type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm" }},
  { field_name: "截止时间", type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm" }},
  { field_name: "完成时间", type: 5, property: { date_formatter: "yyyy/MM/dd HH:mm" }},
  { field_name: "滴答ID", type: 1 },
];

// ─── 辅助函数 ─────────────────────────────────────────

function statusText(status: number): string {
  switch (status) {
    case 0: return "进行中";
    case 2: return "已完成";
    case -1: return "已放弃";
    default: return "进行中";
  }
}

function priorityText(priority: number): string {
  switch (priority) {
    case 0: return "无";
    case 1: return "低";
    case 3: return "中";
    case 5: return "高";
    default: return "无";
  }
}

function parseDate(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const ts = new Date(dateStr).getTime();
  return isNaN(ts) ? null : ts;
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson || tagsJson === "null") return [];
  try { return JSON.parse(tagsJson); } catch { return []; }
}

function taskToFields(task: TaskRow): Record<string, any> {
  const fields: Record<string, any> = {
    "任务名称": task.title,
    "状态": statusText(task.status),
    "优先级": priorityText(task.priority),
    "所属清单": task.project_name || task.project_id || "",
    "内容": task.content || task.desc || "",
    "滴答ID": task.id,
  };
  const tags = parseTags(task.tags);
  if (tags.length > 0) fields["标签"] = tags;
  const createdTime = parseDate(task.created_time);
  if (createdTime) fields["创建时间"] = createdTime;
  const dueDate = parseDate(task.due_date);
  if (dueDate) fields["截止时间"] = dueDate;
  const completedTime = parseDate(task.completed_time);
  if (completedTime) fields["完成时间"] = completedTime;
  return fields;
}

// ─── DB 辅助（直接操作，不依赖 db/index.ts 避免单例冲突） ─

function getFeishuConfig(db: Database, userId: string) {
  return db.query(
    `SELECT app_token, table_id, app_url FROM feishu_config WHERE user_id = ?`
  ).get(userId) as { app_token: string; table_id: string; app_url: string | null } | null;
}

function saveFeishuConfig(db: Database, userId: string, appToken: string, tableId: string, appUrl?: string) {
  db.run(`
    INSERT INTO feishu_config (user_id, app_token, table_id, app_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      app_token = excluded.app_token, table_id = excluded.table_id,
      app_url = excluded.app_url, updated_at = datetime('now')
  `, [userId, appToken, tableId, appUrl ?? null]);
}

interface SyncRecord {
  dida_task_id: string;
  feishu_record_id: string | null;
  last_modified_time: string | null;
}

function getSyncMap(db: Database, userId: string): Map<string, SyncRecord> {
  const rows = db.query(
    `SELECT dida_task_id, feishu_record_id, last_modified_time FROM sync_state WHERE user_id = ? AND sync_status = 'synced'`
  ).all(userId) as SyncRecord[];
  return new Map(rows.map(r => [r.dida_task_id, r]));
}

function batchUpsertSyncState(
  db: Database, userId: string,
  items: Array<{ taskId: string; recordId: string; modifiedTime: string | null }>
) {
  const stmt = db.prepare(`
    INSERT INTO sync_state (dida_task_id, user_id, feishu_record_id, last_synced_at, last_modified_time, sync_status)
    VALUES (?, ?, ?, datetime('now'), ?, 'synced')
    ON CONFLICT (dida_task_id, user_id) DO UPDATE SET
      feishu_record_id = excluded.feishu_record_id,
      last_synced_at = datetime('now'),
      last_modified_time = excluded.last_modified_time,
      sync_status = 'synced'
  `);
  db.transaction(() => {
    for (const item of items) {
      stmt.run(item.taskId, userId, item.recordId, item.modifiedTime);
    }
  })();
}

// ─── 首次同步 ────────────────────────────────────────

async function initialSync(db: Database, userId: string, tasks: TaskRow[]) {
  // 1. 创建多维表格
  console.log("  创建飞书多维表格...");
  const app = await createBitable(`滴答清单 - ${userId}`);
  console.log(`  链接: ${app.url}`);
  const appToken = app.app_token!;

  // 2. 创建数据表
  console.log("  创建任务数据表...");
  const { tableId } = await createTable(appToken, "任务列表", TASK_FIELDS);

  // 3. 创建视图
  try {
    await createView(appToken, tableId, "进行中", "grid");
    await createView(appToken, tableId, "已完成", "grid");
    await createView(appToken, tableId, "看板", "kanban");
    console.log("  视图: 全部任务、进行中、已完成、看板");
  } catch {}

  // 4. 删除默认空表
  try {
    const { getFeishuClient } = await import("./feishu/client.ts");
    const client = getFeishuClient();
    const tablesRes = await client.bitable.appTable.list({ path: { app_token: appToken } });
    for (const t of tablesRes.data?.items ?? []) {
      if (t.table_id !== tableId && t.name === "Table1") {
        await client.bitable.appTable.delete({ path: { app_token: appToken, table_id: t.table_id! } });
      }
    }
  } catch {}

  // 5. 写入全部记录
  console.log(`  写入 ${tasks.length} 条记录...`);
  const records = tasks.map(t => ({ fields: taskToFields(t) }));
  const created = await batchCreateRecords(appToken, tableId, records);
  console.log(`  成功写入 ${created.length} 条`);

  // 6. 保存配置和同步状态
  saveFeishuConfig(db, userId, appToken, tableId, app.url);

  const syncItems = tasks.map((t, i) => ({
    taskId: t.id,
    recordId: created[i]?.record_id ?? "",
    modifiedTime: t.modified_time,
  }));
  batchUpsertSyncState(db, userId, syncItems);

  console.log(`  飞书配置已保存，后续同步将增量更新`);
  return { appToken, tableId, appUrl: app.url };
}

// ─── 增量同步 ────────────────────────────────────────

async function incrementalSync(
  db: Database, userId: string, tasks: TaskRow[],
  config: { app_token: string; table_id: string; app_url: string | null }
) {
  const { app_token: appToken, table_id: tableId } = config;

  // 验证飞书表格是否还存在
  try {
    await getBitableInfo(appToken);
  } catch {
    console.log("  飞书多维表格已不存在，重新创建...");
    db.run(`DELETE FROM sync_state WHERE user_id = ?`, [userId]);
    db.run(`DELETE FROM feishu_config WHERE user_id = ?`, [userId]);
    return initialSync(db, userId, tasks);
  }

  console.log(`  飞书表格: ${config.app_url}`);

  // 获取已同步的映射
  const syncMap = getSyncMap(db, userId);
  console.log(`  已同步: ${syncMap.size} 条`);

  // 分类：新增 / 变更 / 不变
  const toCreate: TaskRow[] = [];
  const toUpdate: { task: TaskRow; recordId: string }[] = [];
  let unchanged = 0;

  for (const task of tasks) {
    const synced = syncMap.get(task.id);
    if (!synced) {
      toCreate.push(task);
    } else if (!synced.feishu_record_id) {
      // 有同步记录但没有 record_id，当作新增
      toCreate.push(task);
    } else if (task.modified_time && task.modified_time !== synced.last_modified_time) {
      toUpdate.push({ task, recordId: synced.feishu_record_id });
    } else {
      unchanged++;
    }
  }

  console.log(`  新增: ${toCreate.length} | 变更: ${toUpdate.length} | 不变: ${unchanged}`);

  // 处理新增
  if (toCreate.length > 0) {
    console.log(`  写入 ${toCreate.length} 条新记录...`);
    const records = toCreate.map(t => ({ fields: taskToFields(t) }));
    const created = await batchCreateRecords(appToken, tableId, records);

    const syncItems = toCreate.map((t, i) => ({
      taskId: t.id,
      recordId: created[i]?.record_id ?? "",
      modifiedTime: t.modified_time,
    }));
    batchUpsertSyncState(db, userId, syncItems);
    console.log(`  新增完成: ${created.length} 条`);
  }

  // 处理变更
  if (toUpdate.length > 0) {
    console.log(`  更新 ${toUpdate.length} 条变更记录...`);
    const records = toUpdate.map(({ task, recordId }) => ({
      record_id: recordId,
      fields: taskToFields(task),
    }));
    const updated = await batchUpdateRecords(appToken, tableId, records);

    const syncItems = toUpdate.map(({ task, recordId }) => ({
      taskId: task.id,
      recordId,
      modifiedTime: task.modified_time,
    }));
    batchUpsertSyncState(db, userId, syncItems);
    console.log(`  更新完成: ${updated.length} 条`);
  }

  if (toCreate.length === 0 && toUpdate.length === 0) {
    console.log("  所有任务已是最新，无需同步");
  }

  return config;
}

// ─── 主逻辑 ──────────────────────────────────────────

async function syncUser(db: Database, userId: string) {
  console.log(`\n--- 同步用户: ${userId} ---`);

  const tasks = db.query(`
    SELECT t.id, t.user_id, t.project_id, t.title, t.content, t."desc",
           t.status, t.priority, t.start_date, t.due_date,
           t.completed_time, t.created_time, t.modified_time,
           t.tags, t.items, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id AND t.user_id = p.user_id
    WHERE t.user_id = ?
    ORDER BY t.created_time DESC
  `).all(userId) as TaskRow[];

  if (!tasks.length) {
    console.log("  没有任务需要同步");
    return;
  }

  console.log(`  本地任务: ${tasks.length} 条`);

  const config = getFeishuConfig(db, userId);

  let result;
  if (config) {
    result = await incrementalSync(db, userId, tasks, config);
  } else {
    result = await initialSync(db, userId, tasks);
  }

  console.log(`\n  ✓ 同步完成！`);
  if (result?.appUrl) console.log(`  飞书链接: ${result.appUrl}`);
}

async function main() {
  console.log("=== 滴答 → 飞书 同步 ===");

  const db = new Database(DB_FILE);
  db.run("PRAGMA journal_mode = WAL");

  // 确保所需表存在
  db.run(`
    CREATE TABLE IF NOT EXISTS feishu_config (
      user_id TEXT PRIMARY KEY, app_token TEXT NOT NULL, table_id TEXT NOT NULL,
      app_url TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      dida_task_id TEXT NOT NULL, user_id TEXT NOT NULL,
      feishu_record_id TEXT, last_synced_at TEXT, last_modified_time TEXT,
      checksum TEXT, sync_status TEXT DEFAULT 'pending',
      PRIMARY KEY (dida_task_id, user_id)
    )
  `);

  const args = process.argv.slice(2);

  // --reset: 清除飞书配置
  if (args.includes("--reset")) {
    db.run(`DELETE FROM feishu_config`);
    db.run(`DELETE FROM sync_state`);
    console.log("已清除所有飞书同步配置，将重新创建");
  }

  const idx = args.indexOf("--user");
  const filterUser = idx !== -1 ? args[idx + 1] : null;

  let users: string[];
  if (filterUser) {
    users = [filterUser];
  } else {
    users = (
      db.query("SELECT DISTINCT user_id FROM tasks").all() as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  if (!users.length) {
    console.log("没有找到需要同步的数据，请先运行 bun run index.ts 导出滴答数据");
    db.close();
    return;
  }

  for (const userId of users) {
    try {
      await syncUser(db, userId);
    } catch (e) {
      console.error(`  同步用户 ${userId} 失败:`, e);
    }
  }

  db.close();
  console.log("\n=== 同步完成 ===");
}

main().catch((err) => {
  console.error("同步失败:", err);
  process.exit(1);
});
