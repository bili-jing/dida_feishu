/**
 * 同步脚本：从 SQLite 读取滴答任务 → 写入飞书多维表格
 *
 * 用法:
 *   bun run sync.ts                     # 同步所有用户
 *   bun run sync.ts --user test         # 同步指定用户
 */

import { Database } from "bun:sqlite";
import {
  createBitable,
  createTable,
  createView,
  batchCreateRecords,
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
  { field_name: "任务名称", type: 1 },              // 多行文本
  { field_name: "状态", type: 3, property: {         // 单选
    options: [
      { name: "进行中", color: 0 },
      { name: "已完成", color: 1 },
      { name: "已放弃", color: 2 },
    ],
  }},
  { field_name: "优先级", type: 3, property: {       // 单选
    options: [
      { name: "无", color: 3 },
      { name: "低", color: 0 },
      { name: "中", color: 4 },
      { name: "高", color: 2 },
    ],
  }},
  { field_name: "所属清单", type: 1 },               // 多行文本
  { field_name: "内容", type: 1 },                   // 多行文本
  { field_name: "标签", type: 4, property: {          // 多选
    options: [],
  }},
  { field_name: "创建时间", type: 5, property: {      // 日期
    date_formatter: "yyyy/MM/dd HH:mm",
  }},
  { field_name: "截止时间", type: 5, property: {      // 日期
    date_formatter: "yyyy/MM/dd HH:mm",
  }},
  { field_name: "完成时间", type: 5, property: {      // 日期
    date_formatter: "yyyy/MM/dd HH:mm",
  }},
  { field_name: "滴答ID", type: 1 },                 // 多行文本（用于回溯）
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

/** 将 "2026-02-12T09:52:58.000+0000" → 毫秒时间戳 */
function parseDate(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const ts = new Date(dateStr).getTime();
  return isNaN(ts) ? null : ts;
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson || tagsJson === "null") return [];
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

/** 将任务行转为飞书 Bitable 记录 */
function taskToRecord(task: TaskRow): { fields: Record<string, any> } {
  const fields: Record<string, any> = {
    "任务名称": task.title,
    "状态": statusText(task.status),
    "优先级": priorityText(task.priority),
    "所属清单": task.project_name || task.project_id || "",
    "内容": task.content || task.desc || "",
    "滴答ID": task.id,
  };

  const tags = parseTags(task.tags);
  if (tags.length > 0) {
    fields["标签"] = tags;
  }

  const createdTime = parseDate(task.created_time);
  if (createdTime) fields["创建时间"] = createdTime;

  const dueDate = parseDate(task.due_date);
  if (dueDate) fields["截止时间"] = dueDate;

  const completedTime = parseDate(task.completed_time);
  if (completedTime) fields["完成时间"] = completedTime;

  return { fields };
}

// ─── 主逻辑 ──────────────────────────────────────────

async function syncUser(db: Database, userId: string) {
  console.log(`\n--- 同步用户: ${userId} ---`);

  // 1. 读取该用户的所有任务
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

  console.log(`  找到 ${tasks.length} 个任务`);

  // 2. 创建飞书多维表格
  console.log("  创建飞书多维表格...");
  const app = await createBitable(`滴答清单同步 - ${userId} - ${new Date().toLocaleDateString("zh-CN")}`);
  console.log(`  多维表格已创建: ${app.name}`);
  console.log(`  链接: ${app.url}`);

  const appToken = app.app_token!;

  // 3. 在默认表中创建字段（删掉默认表，新建带字段的表）
  console.log("  创建任务数据表...");
  const { tableId } = await createTable(appToken, "任务列表", TASK_FIELDS);
  console.log(`  数据表已创建: ${tableId}`);

  // 4. 创建不同视图
  console.log("  创建视图...");
  try {
    await createView(appToken, tableId, "进行中", "grid");
    await createView(appToken, tableId, "已完成", "grid");
    await createView(appToken, tableId, "看板", "kanban");
    console.log("  视图已创建: 进行中、已完成、看板");
  } catch (e) {
    console.warn(`  创建视图时出错(可忽略): ${e}`);
  }

  // 5. 写入任务记录
  console.log("  写入任务记录...");
  const records = tasks.map(taskToRecord);
  const created = await batchCreateRecords(appToken, tableId, records);
  console.log(`  成功写入 ${created.length} 条记录`);

  // 6. 更新 sync_state
  const upsertSync = db.prepare(`
    INSERT INTO sync_state (dida_task_id, user_id, feishu_record_id, last_synced_at, sync_status)
    VALUES (?, ?, ?, datetime('now'), 'synced')
    ON CONFLICT (dida_task_id, user_id) DO UPDATE SET
      feishu_record_id = excluded.feishu_record_id,
      last_synced_at = datetime('now'),
      sync_status = 'synced'
  `);

  const updateBatch = db.transaction(() => {
    for (let i = 0; i < tasks.length; i++) {
      const recordId = created[i]?.record_id ?? null;
      upsertSync.run(tasks[i].id, userId, recordId);
    }
  });
  updateBatch();
  console.log("  同步状态已更新");

  // 7. 尝试删除默认空表
  try {
    const client = (await import("./feishu/client.ts")).getFeishuClient();
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    const tables = tablesRes.data?.items ?? [];
    for (const t of tables) {
      if (t.table_id !== tableId && t.name === "Table1") {
        await client.bitable.appTable.delete({
          path: { app_token: appToken, table_id: t.table_id! },
        });
      }
    }
  } catch {
    // 忽略
  }

  console.log(`\n  ✓ 同步完成！`);
  console.log(`  飞书多维表格链接: ${app.url}`);
  return app;
}

async function main() {
  console.log("=== 滴答 → 飞书 同步 ===");

  const db = new Database(DB_FILE);
  db.run("PRAGMA journal_mode = WAL");

  // 解析 --user 参数
  const idx = process.argv.indexOf("--user");
  const filterUser = idx !== -1 ? process.argv[idx + 1] : null;

  // 获取所有有任务的用户
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
