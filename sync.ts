/**
 * 滴答清单 → 飞书多维表格 同步脚本
 *
 * 支持两种模式：
 * - 全量同步：创建新的多维表格，写入全部任务（首次或 --full）
 * - 增量同步：检测新增/修改的任务，只更新变化的记录（默认，需已有配置）
 *
 * 用法:
 *   bun run sync.ts                     # 自动选择（有配置→增量，无配置→全量）
 *   bun run sync.ts --user <id>         # 同步指定用户
 *   bun run sync.ts --full              # 强制全量同步（创建新表格）
 *   bun run sync.ts --no-attachments    # 跳过附件处理
 *   bun run sync.ts --reset             # 清除所有缓存，全量重建
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createBitable,
  createTable,
  createView,
  getFieldMap,
  patchView,
  batchCreateRecords,
  batchUpdateRecords,
  getBitableInfo,
  uploadMedia,
  getFeishuClient,
  setFeishuCredentials,
  clearFeishuCredentials,
  type BitableField,
} from "./feishu/client.ts";
import { DB_FILE, DOWNLOADS_DIR } from "./utils/paths.ts";

// ─── 类型 ────────────────────────────────────────────

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
  raw: string | null;
  project_name: string | null;
}

interface AttachmentInfo {
  id: string;
  path: string;
  fileName: string;
  fileType: string;
  size: number;
}

// ─── 字段定义 ─────────────────────────────────────────

const TASK_FIELDS: BitableField[] = [
  { field_name: "内容标题", type: 1 },
  {
    field_name: "类型",
    type: 3,
    property: {
      options: [
        { name: "纯文本", color: 0 },
        { name: "聊天记录", color: 4 },
        { name: "图片", color: 1 },
        { name: "文件", color: 3 },
        { name: "图文混合", color: 5 },
        { name: "清单", color: 6 },
        { name: "链接", color: 2 },
      ],
    },
  },
  { field_name: "链接", type: 15 },
  { field_name: "内容", type: 1 },
  { field_name: "附件", type: 17 },
  { field_name: "标签", type: 4, property: { options: [] } },
  { field_name: "子任务", type: 1 },
  {
    field_name: "状态",
    type: 3,
    property: {
      options: [
        { name: "进行中", color: 0 },
        { name: "已完成", color: 1 },
        { name: "已放弃", color: 2 },
      ],
    },
  },
  { field_name: "所属清单", type: 3, property: { options: [] } },
  {
    field_name: "优先级",
    type: 3,
    property: {
      options: [
        { name: "无", color: 3 },
        { name: "低", color: 0 },
        { name: "中", color: 4 },
        { name: "高", color: 2 },
      ],
    },
  },
  {
    field_name: "创建时间",
    type: 5,
    property: { date_formatter: "yyyy/MM/dd HH:mm" },
  },
  {
    field_name: "截止时间",
    type: 5,
    property: { date_formatter: "yyyy/MM/dd HH:mm" },
  },
  {
    field_name: "完成时间",
    type: 5,
    property: { date_formatter: "yyyy/MM/dd HH:mm" },
  },
  { field_name: "滴答ID", type: 1 },
];

// ─── 辅助函数 ─────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function statusText(status: number): string {
  switch (status) {
    case 0:
      return "进行中";
    case 2:
      return "已完成";
    case -1:
      return "已放弃";
    default:
      return "进行中";
  }
}

function priorityText(priority: number): string {
  switch (priority) {
    case 0:
      return "无";
    case 1:
      return "低";
    case 3:
      return "中";
    case 5:
      return "高";
    default:
      return "无";
  }
}

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

/** 清洗内容：将附件标记替换为可读文字，将 markdown 链接转为纯文本 */
function cleanContent(content: string | null): string {
  if (!content) return "";
  return content
    // ![image](id/filename.jpg) → [图片: filename.jpg]
    .replace(/!\[image\]\(([^)]+)\)/g, (_m, path: string) => {
      const name = path.includes("/") ? path.split("/").pop()! : path;
      return `[图片: ${decodeURIComponent(name)}]`;
    })
    // ![file](id/filename.pdf) → [文件: filename.pdf]
    .replace(/!\[file\]\(([^)]+)\)/g, (_m, path: string) => {
      const name = path.includes("/") ? path.split("/").pop()! : path;
      return `[文件: ${decodeURIComponent(name)}]`;
    })
    // [链接文字](url) → 链接文字
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 格式化子任务为可读文本 */
function formatItems(itemsJson: string | null): string {
  if (!itemsJson || itemsJson === "null") return "";
  try {
    const items = JSON.parse(itemsJson) as Array<{
      title: string;
      status: number;
    }>;
    if (!items.length) return "";
    return items
      .map((item) => `${item.status === 2 ? "☑" : "☐"} ${item.title}`)
      .join("\n");
  } catch {
    return "";
  }
}

/** 判断标题是否包含链接 */
function titleHasLink(title: string): boolean {
  // markdown link: [text](url) 或标题里直接有 http
  return /\]\(https?:\/\//.test(title) || /https?:\/\//.test(title);
}

/** 提取标题中的纯文字部分（去掉 markdown 链接语法） */
function cleanTitle(title: string): string {
  // [text](url) → text
  return title
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s]*/g, "")
    .trim();
}

/** 从文本中提取第一个链接 URL 和对应的文字 */
function extractLink(text: string): { url: string; text: string } | null {
  // 优先提取 [text](url) 格式
  const mdMatch = text.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (mdMatch) return { text: mdMatch[1], url: mdMatch[2] };
  // 其次提取裸链接
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) return { text: urlMatch[1], url: urlMatch[1] };
  return null;
}

/** 根据内容特征自动判断任务类型 */
function classifyType(task: TaskRow): string {
  const c = task.content || "";
  const hasImage = c.includes("![image]");
  const hasFile = c.includes("![file]");
  const hasLink = /https?:\/\//.test(c) || titleHasLink(task.title);
  const hasItems =
    task.items != null && task.items !== "null" && task.items !== "[]";
  // 聊天记录特征：含时间戳行或微信转发标记
  const isChat =
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n/.test(c) ||
    c.includes("[该消息类型暂不能展示]");
  // 去掉附件标记和链接后的纯文字
  const cleanText = c
    .replace(/!\[(image|file)\]\([^)]+\)/g, "")
    .replace(/https?:\/\/[^\s]*/g, "")
    .trim();

  if (hasItems) return "清单";
  if (isChat) return "聊天记录";
  if (hasImage && hasFile) return "图文混合";
  if ((hasImage || hasFile) && cleanText) return "图文混合";
  if (hasImage && !cleanText) return "图片";
  if (hasFile && !cleanText) return "文件";
  if (hasLink && cleanText) return "图文混合";
  if (hasLink && !cleanText) return "链接";
  return "纯文本";
}

/** 从 raw JSON 解析附件信息 */
function parseAttachments(raw: string | null): AttachmentInfo[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.attachments?.length) return [];
    return parsed.attachments.map((a: any) => ({
      id: a.id,
      path: a.path,
      fileName: a.fileName,
      fileType: a.fileType,
      size: a.size ?? 0,
    }));
  } catch {
    return [];
  }
}

/** 构建记录字段 */
function taskToFields(
  task: TaskRow,
  fileTokens?: Array<{ file_token: string }>
): Record<string, any> {
  // 标题含链接时提取纯文字作为标题
  const hasTitleLink = titleHasLink(task.title);
  const displayTitle = hasTitleLink ? cleanTitle(task.title) || task.title : task.title;

  const contentText = cleanContent(task.content) || task.desc || "";

  const fields: Record<string, any> = {
    内容标题: displayTitle,
    类型: classifyType(task),
    状态: statusText(task.status),
    优先级: priorityText(task.priority),
    所属清单: task.project_name || "",
    内容: contentText,
    滴答ID: task.id,
  };

  // 链接字段：优先从标题提取，其次从内容提取
  const titleLink = hasTitleLink ? extractLink(task.title) : null;
  const contentLink = !titleLink && task.content ? extractLink(task.content) : null;
  const link = titleLink || contentLink;
  if (link) {
    fields["链接"] = { link: link.url, text: link.text };
  }

  if (fileTokens && fileTokens.length > 0) {
    fields["附件"] = fileTokens;
  }

  const subTasks = formatItems(task.items);
  if (subTasks) fields["子任务"] = subTasks;

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

// ─── DB 辅助 ─────────────────────────────────────────

function saveFeishuConfig(
  db: Database,
  userId: string,
  appToken: string,
  tableId: string,
  appUrl?: string
) {
  db.run(
    `INSERT INTO feishu_config (user_id, app_token, table_id, app_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       app_token = excluded.app_token, table_id = excluded.table_id,
       app_url = excluded.app_url, updated_at = datetime('now')`,
    [userId, appToken, tableId, appUrl ?? null]
  );
}

function batchUpsertSyncState(
  db: Database,
  userId: string,
  items: Array<{
    taskId: string;
    recordId: string;
    modifiedTime: string | null;
  }>
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

// ─── 附件缓存 DB ─────────────────────────────────────

function getCachedFileToken(db: Database, attachmentId: string): string | null {
  const row = db
    .query(
      `SELECT feishu_file_token FROM attachment_cache WHERE attachment_id = ? AND feishu_file_token IS NOT NULL`
    )
    .get(attachmentId) as { feishu_file_token: string } | null;
  return row?.feishu_file_token ?? null;
}

function getCachedLocalPath(db: Database, attachmentId: string): string | null {
  const row = db
    .query(
      `SELECT local_path FROM attachment_cache WHERE attachment_id = ? AND local_path IS NOT NULL`
    )
    .get(attachmentId) as { local_path: string } | null;
  return row?.local_path ?? null;
}

function saveDownloadCache(
  db: Database,
  attachmentId: string,
  userId: string,
  taskId: string,
  fileName: string,
  fileType: string,
  fileSize: number,
  localPath: string
) {
  db.run(
    `INSERT INTO attachment_cache (attachment_id, user_id, task_id, file_name, file_type, file_size, local_path, downloaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (attachment_id) DO UPDATE SET
       local_path = excluded.local_path, downloaded_at = datetime('now')`,
    [attachmentId, userId, taskId, fileName, fileType, fileSize, localPath]
  );
}

function saveUploadCache(
  db: Database,
  attachmentId: string,
  fileToken: string
) {
  db.run(
    `UPDATE attachment_cache SET feishu_file_token = ?, uploaded_at = datetime('now')
     WHERE attachment_id = ?`,
    [fileToken, attachmentId]
  );
}

function getTaskFileTokens(
  db: Database,
  taskId: string
): Array<{ file_token: string }> {
  return db
    .query(
      `SELECT feishu_file_token as file_token FROM attachment_cache
       WHERE task_id = ? AND feishu_file_token IS NOT NULL`
    )
    .all(taskId) as any[];
}

// ─── 附件处理流程 ─────────────────────────────────────

async function processAttachments(
  db: Database,
  userId: string,
  tasks: TaskRow[],
  appToken: string,
  didaToken: string
) {
  // 收集所有需要处理的附件
  const allAttachments: Array<{
    taskId: string;
    projectId: string;
    att: AttachmentInfo;
  }> = [];
  for (const task of tasks) {
    const atts = parseAttachments(task.raw);
    for (const att of atts) {
      allAttachments.push({
        taskId: task.id,
        projectId: task.project_id,
        att,
      });
    }
  }

  if (!allAttachments.length) {
    console.log("  没有附件需要处理");
    return;
  }

  console.log(`  共 ${allAttachments.length} 个附件需要处理`);
  await mkdir(DOWNLOADS_DIR, { recursive: true });

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Accept: "*/*",
    Cookie: `t=${didaToken}`,
  };

  let downloaded = 0;
  let uploaded = 0;
  let skippedCached = 0;
  let failed = 0;

  for (let i = 0; i < allAttachments.length; i++) {
    const { taskId, projectId, att } = allAttachments[i];

    // 进度报告
    if ((i + 1) % 100 === 0 || i === 0) {
      console.log(
        `  附件 ${i + 1}/${allAttachments.length} ` +
          `(下载=${downloaded} 上传=${uploaded} 缓存=${skippedCached} 失败=${failed})`
      );
    }

    // 已有 file_token → 跳过
    const cachedToken = getCachedFileToken(db, att.id);
    if (cachedToken) {
      skippedCached++;
      continue;
    }

    try {
      // 1. 下载（或读取本地缓存）
      let localPath = getCachedLocalPath(db, att.id);
      let fileBuffer: Buffer;

      if (localPath && existsSync(localPath)) {
        fileBuffer = Buffer.from(await Bun.file(localPath).arrayBuffer());
      } else {
        // URL 格式: /api/v1/attachment/{projectId}/{taskId}/{attachmentId}{extension}
        const ext = att.fileName.substring(att.fileName.lastIndexOf("."));
        const url = `https://api.dida365.com/api/v1/attachment/${projectId}/${taskId}/${att.id}${ext}`;
        const res = await fetch(url, {
          headers,
          tls: { rejectUnauthorized: false },
        });
        if (!res.ok) {
          console.warn(`  ⚠ 下载失败 ${att.fileName}: ${res.status}`);
          failed++;
          continue;
        }
        fileBuffer = Buffer.from(await res.arrayBuffer());

        // 保存到本地
        const dir = `${DOWNLOADS_DIR}/${att.id}`;
        await mkdir(dir, { recursive: true });
        localPath = `${dir}/${att.fileName}`;
        await Bun.write(localPath, fileBuffer);

        saveDownloadCache(
          db,
          att.id,
          userId,
          taskId,
          att.fileName,
          att.fileType,
          att.size,
          localPath
        );
        downloaded++;
        await sleep(100);
      }

      // 2. 上传到飞书
      const isImage = att.fileType === "IMAGE";
      const fileToken = await uploadMedia(
        appToken,
        att.fileName,
        fileBuffer,
        isImage
      );
      saveUploadCache(db, att.id, fileToken);
      uploaded++;

      await sleep(200); // 5 QPS 限制
    } catch (e) {
      console.warn(
        `  ⚠ 处理附件失败 ${att.fileName}:`,
        (e as Error).message
      );
      failed++;
    }
  }

  console.log(
    `  附件处理完成: 下载=${downloaded} 上传=${uploaded} 缓存=${skippedCached} 失败=${failed}`
  );
}

// ─── DB 查询辅助 ──────────────────────────────────────

export function getFeishuConfigFromDb(db: Database, userId: string) {
  return db
    .query(`SELECT app_token, table_id, app_url FROM feishu_config WHERE user_id = ?`)
    .get(userId) as { app_token: string; table_id: string; app_url: string | null } | null;
}

function getSyncStateMap(db: Database, userId: string) {
  const rows = db
    .query(`SELECT dida_task_id, feishu_record_id, last_modified_time FROM sync_state WHERE user_id = ?`)
    .all(userId) as Array<{ dida_task_id: string; feishu_record_id: string; last_modified_time: string | null }>;
  const map = new Map<string, { recordId: string; modifiedTime: string | null }>();
  for (const r of rows) {
    map.set(r.dida_task_id, { recordId: r.feishu_record_id, modifiedTime: r.last_modified_time });
  }
  return map;
}

// ─── 凭据激活 ─────────────────────────────────────────

/** 从 DB 读取并激活该用户的飞书凭据 */
function activateUserCredentials(db: Database, userId: string) {
  const row = db
    .query(`SELECT app_id, app_secret FROM feishu_credentials WHERE user_id = ?`)
    .get(userId) as { app_id: string; app_secret: string } | null;
  if (row) {
    setFeishuCredentials(row.app_id, row.app_secret);
  } else {
    clearFeishuCredentials(); // 回退到 env
  }
}

// ─── 全量同步 ─────────────────────────────────────────

export async function fullSyncUser(db: Database, userId: string, skipAttachments = false) {
  console.log(`\n--- 同步用户: ${userId} ---`);
  activateUserCredentials(db, userId);

  // 获取显示名称
  const tokenRow = db
    .query(`SELECT extra, token FROM tokens WHERE user_id = ?`)
    .get(userId) as { extra: string; token: string } | null;
  const displayName = tokenRow?.extra
    ? JSON.parse(tokenRow.extra).displayName
    : userId;
  const didaToken = tokenRow?.token;

  // 加载任务
  const tasks = db
    .query(
      `SELECT t.id, t.user_id, t.project_id, t.title, t.content, t."desc",
              t.status, t.priority, t.start_date, t.due_date,
              t.completed_time, t.created_time, t.modified_time,
              t.tags, t.items, t.raw, p.name as project_name
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id AND t.user_id = p.user_id
       WHERE t.user_id = ?
       ORDER BY t.created_time DESC`
    )
    .all(userId) as TaskRow[];

  if (!tasks.length) {
    console.log("  没有任务需要同步");
    return;
  }
  console.log(`  本地任务: ${tasks.length} 条`);

  // 清除旧的同步状态（重建表格）
  db.run(`DELETE FROM feishu_config WHERE user_id = ?`, [userId]);
  db.run(`DELETE FROM sync_state WHERE user_id = ?`, [userId]);
  // 清除旧的 file_token（新表格需要重新上传），但保留 local_path
  db.run(
    `UPDATE attachment_cache SET feishu_file_token = NULL, uploaded_at = NULL WHERE user_id = ?`,
    [userId]
  );

  // 1. 创建飞书多维表格
  console.log("  创建飞书多维表格...");
  const app = await createBitable(`滴答清单 - ${displayName}`);
  console.log(`  链接: ${app.url}`);
  const appToken = app.app_token!;

  // 2. 创建数据表
  console.log("  创建任务数据表...");
  const { tableId } = await createTable(appToken, "任务列表", TASK_FIELDS);

  // 3. 获取字段 ID 映射并创建视图
  try {
    const fieldMap = await getFieldMap(appToken, tableId);
    const statusField = fieldMap["状态"];

    // 辅助：根据 option name 获取 option id
    const optionId = (field: typeof statusField, name: string) =>
      field?.options?.find(o => o.name === name)?.id;

    // 进行中视图：筛选 状态=进行中
    const optInProgress = optionId(statusField, "进行中");
    if (statusField && optInProgress) {
      const v = await createView(appToken, tableId, "进行中", "grid");
      if (v.view_id) {
        await patchView(appToken, tableId, v.view_id, {
          filter_info: {
            conjunction: "and",
            conditions: [{ field_id: statusField.field_id, operator: "is", value: JSON.stringify([optInProgress]) }],
          },
        });
      }
    }

    // 已完成视图：筛选 状态=已完成
    const optCompleted = optionId(statusField, "已完成");
    if (statusField && optCompleted) {
      const v = await createView(appToken, tableId, "已完成", "grid");
      if (v.view_id) {
        await patchView(appToken, tableId, v.view_id, {
          filter_info: {
            conjunction: "and",
            conditions: [{ field_id: statusField.field_id, operator: "is", value: JSON.stringify([optCompleted]) }],
          },
        });
      }
    }

    // 看板视图（按状态）
    await createView(appToken, tableId, "看板", "kanban");

    console.log("  视图已创建并配置");
  } catch (e) {
    console.warn("  ⚠ 视图配置部分失败:", (e as Error).message);
  }

  // 4. 删除默认空表
  try {
    const client = getFeishuClient();
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    for (const t of tablesRes.data?.items ?? []) {
      if (t.table_id !== tableId && (t.name === "数据表" || t.name === "Table1")) {
        await client.bitable.appTable.delete({
          path: { app_token: appToken, table_id: t.table_id! },
        });
      }
    }
  } catch {}

  // 5. 处理附件（下载 + 上传）
  if (skipAttachments) {
    console.log("  跳过附件处理 (--no-attachments)");
  } else if (didaToken) {
    await processAttachments(db, userId, tasks, appToken, didaToken);
  } else {
    console.log("  ⚠ 无法获取滴答 token，跳过附件处理");
  }

  // 6. 构建记录并写入
  console.log(`  写入 ${tasks.length} 条记录...`);
  const records = tasks.map((task) => {
    const fileTokens = getTaskFileTokens(db, task.id);
    return {
      fields: taskToFields(
        task,
        fileTokens.length > 0 ? fileTokens : undefined
      ),
    };
  });
  const created = await batchCreateRecords(appToken, tableId, records);
  console.log(`  成功写入 ${created.length} 条`);

  // 7. 保存配置和同步状态
  saveFeishuConfig(db, userId, appToken, tableId, app.url);
  const syncItems = tasks.map((t, i) => ({
    taskId: t.id,
    recordId: created[i]?.record_id ?? "",
    modifiedTime: t.modified_time,
  }));
  batchUpsertSyncState(db, userId, syncItems);

  console.log(`\n  ✓ 同步完成！`);
  console.log(`  飞书链接: ${app.url}`);
  return { appToken, tableId, appUrl: app.url };
}

// ─── 增量同步 ─────────────────────────────────────────

export async function incrementalSyncUser(
  db: Database,
  userId: string,
  appToken: string,
  tableId: string,
  appUrl: string | null,
  skipAttachments = false
) {
  console.log(`\n--- 增量同步用户: ${userId} ---`);
  activateUserCredentials(db, userId);
  console.log(`  飞书链接: ${appUrl ?? "未知"}`);

  // 验证飞书表格是否还存在
  try {
    await getBitableInfo(appToken);
  } catch {
    console.log("  ⚠ 飞书表格不可访问，将执行全量同步");
    return null; // 返回 null 表示需要回退到全量
  }

  const tokenRow = db
    .query(`SELECT extra, token FROM tokens WHERE user_id = ?`)
    .get(userId) as { extra: string; token: string } | null;
  const didaToken = tokenRow?.token;

  // 加载任务
  const tasks = db
    .query(
      `SELECT t.id, t.user_id, t.project_id, t.title, t.content, t."desc",
              t.status, t.priority, t.start_date, t.due_date,
              t.completed_time, t.created_time, t.modified_time,
              t.tags, t.items, t.raw, p.name as project_name
       FROM tasks t
       LEFT JOIN projects p ON t.project_id = p.id AND t.user_id = p.user_id
       WHERE t.user_id = ?
       ORDER BY t.created_time DESC`
    )
    .all(userId) as TaskRow[];

  if (!tasks.length) {
    console.log("  没有任务需要同步");
    return { appToken, tableId, appUrl };
  }
  console.log(`  本地任务: ${tasks.length} 条`);

  // 加载已有同步状态
  const syncMap = getSyncStateMap(db, userId);
  console.log(`  已同步记录: ${syncMap.size} 条`);

  // 分类：新增 / 修改 / 未变
  const newTasks: TaskRow[] = [];
  const modifiedTasks: Array<{ task: TaskRow; recordId: string }> = [];
  let unchanged = 0;

  for (const task of tasks) {
    const existing = syncMap.get(task.id);
    if (!existing) {
      newTasks.push(task);
    } else if (task.modified_time !== existing.modifiedTime) {
      modifiedTasks.push({ task, recordId: existing.recordId });
    } else {
      unchanged++;
    }
  }

  console.log(
    `  新增: ${newTasks.length} | 修改: ${modifiedTasks.length} | 未变: ${unchanged}`
  );

  if (newTasks.length === 0 && modifiedTasks.length === 0) {
    console.log("  无需更新，已是最新");
    return { appToken, tableId, appUrl };
  }

  // 处理附件：只处理新增和修改的任务
  const changedTasks = [...newTasks, ...modifiedTasks.map((m) => m.task)];
  if (skipAttachments) {
    console.log("  跳过附件处理 (--no-attachments)");
  } else if (didaToken) {
    await processAttachments(db, userId, changedTasks, appToken, didaToken);
  } else {
    console.log("  ⚠ 无法获取滴答 token，跳过附件处理");
  }

  // 创建新记录
  if (newTasks.length > 0) {
    console.log(`  创建 ${newTasks.length} 条新记录...`);
    const newRecords = newTasks.map((task) => {
      const fileTokens = getTaskFileTokens(db, task.id);
      return {
        fields: taskToFields(task, fileTokens.length > 0 ? fileTokens : undefined),
      };
    });
    const created = await batchCreateRecords(appToken, tableId, newRecords);
    console.log(`  成功创建 ${created.length} 条`);

    // 更新同步状态
    const syncItems = newTasks.map((t, i) => ({
      taskId: t.id,
      recordId: created[i]?.record_id ?? "",
      modifiedTime: t.modified_time,
    }));
    batchUpsertSyncState(db, userId, syncItems);
  }

  // 更新已有记录
  if (modifiedTasks.length > 0) {
    console.log(`  更新 ${modifiedTasks.length} 条记录...`);
    const updateRecords = modifiedTasks.map(({ task, recordId }) => {
      const fileTokens = getTaskFileTokens(db, task.id);
      return {
        record_id: recordId,
        fields: taskToFields(task, fileTokens.length > 0 ? fileTokens : undefined),
      };
    });
    const updated = await batchUpdateRecords(appToken, tableId, updateRecords);
    console.log(`  成功更新 ${updated.length} 条`);

    // 更新同步状态
    const syncItems = modifiedTasks.map(({ task, recordId }) => ({
      taskId: task.id,
      recordId,
      modifiedTime: task.modified_time,
    }));
    batchUpsertSyncState(db, userId, syncItems);
  }

  console.log(`\n  ✓ 增量同步完成！`);
  console.log(`  飞书链接: ${appUrl}`);
  return { appToken, tableId, appUrl };
}

// ─── 主逻辑 ──────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const forceFullSync = args.includes("--full");
  const skipAttachments = args.includes("--no-attachments");

  console.log(
    forceFullSync
      ? "=== 滴答 → 飞书 全量同步（含附件） ==="
      : "=== 滴答 → 飞书 同步 ==="
  );

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
  db.run(`
    CREATE TABLE IF NOT EXISTS attachment_cache (
      attachment_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, task_id TEXT NOT NULL,
      file_name TEXT, file_type TEXT, file_size INTEGER,
      local_path TEXT, feishu_file_token TEXT,
      downloaded_at TEXT, uploaded_at TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS feishu_credentials (
      user_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL, app_secret TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // --reset: 完全清除（含本地下载缓存）
  if (args.includes("--reset")) {
    db.run(`DELETE FROM feishu_config`);
    db.run(`DELETE FROM sync_state`);
    db.run(`DELETE FROM attachment_cache`);
    console.log("已清除所有同步配置和附件缓存");
  }

  const idx = args.indexOf("--user");
  const filterUser = idx !== -1 ? args[idx + 1] : null;

  let users: string[];
  if (filterUser) {
    users = [filterUser];
  } else {
    users = (
      db
        .query("SELECT DISTINCT user_id FROM tasks")
        .all() as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  if (!users.length) {
    console.log("没有找到需要同步的数据，请先运行 bun run index.ts 导出滴答数据");
    db.close();
    return;
  }

  for (const userId of users) {
    try {
      // 检查是否有已存在的飞书配置
      const config = forceFullSync ? null : getFeishuConfigFromDb(db, userId);

      if (config) {
        // 尝试增量同步
        const result = await incrementalSyncUser(
          db, userId, config.app_token, config.table_id, config.app_url, skipAttachments
        );
        if (result === null) {
          // 飞书表格不可访问，回退全量同步
          await fullSyncUser(db, userId, skipAttachments);
        }
      } else {
        // 全量同步
        await fullSyncUser(db, userId, skipAttachments);
      }
    } catch (e) {
      console.error(`  同步用户 ${userId} 失败:`, e);
    }
  }

  db.close();
  console.log("\n=== 同步完成 ===");
}

// 仅当直接执行 sync.ts 时运行 main()
if (import.meta.main) {
  main().catch((err) => {
    console.error("同步失败:", err);
    process.exit(1);
  });
}
