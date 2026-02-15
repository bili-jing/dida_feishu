# Full Data Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Sync all Dida tasks including attachments (images, PDFs, docs) to Feishu Bitable with full preview support.

**Architecture:** Download attachments from Dida API → cache locally → upload to Feishu Drive → create Bitable records with attachment field (type 17). Content is cleaned of `![image/file](...)` markers. Sub-tasks are formatted as checkbox text.

**Tech Stack:** Bun, SQLite (bun:sqlite), @larksuiteoapi/node-sdk, Dida365 API

---

### Task 1: Add attachment download to Dida client

**Files:**
- Modify: `dida/client.ts` (add `downloadAttachment` method)

**Step 1: Add downloadAttachment method to DidaClient**

Add after line 401 (before closing brace of class):

```typescript
/** 下载附件文件 */
async downloadAttachment(path: string): Promise<Buffer> {
  if (!this.token) throw new Error("未登录，请先调用 login()");
  const url = `https://api.dida365.com${path}`;
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Cookie: `t=${this.token}` },
  });
  if (!res.ok) {
    throw new Error(`下载附件失败 ${path}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
```

**Step 2: Verify it compiles**

Run: `bun build dida/client.ts --no-bundle`
Expected: No errors

**Step 3: Commit**

```bash
git add dida/client.ts
git commit -m "feat: add attachment download to Dida client"
```

---

### Task 2: Add media upload to Feishu client

**Files:**
- Modify: `feishu/client.ts` (add `uploadMedia` function)

**Step 1: Add uploadMedia function**

Add after the `getBitableInfo` function (after line 164):

```typescript
/** 上传文件到飞书，返回 file_token */
export async function uploadMedia(
  appToken: string,
  fileName: string,
  fileBuffer: Buffer,
  isImage: boolean = false,
): Promise<string> {
  const client = getFeishuClient();
  const res = await client.drive.media.uploadAll({
    data: {
      file_name: fileName,
      parent_type: isImage ? "bitable_image" : "bitable_file",
      parent_node: appToken,
      size: fileBuffer.length,
      file: new Blob([fileBuffer]),
    },
  });
  const fileToken = res?.file_token ?? (res as any)?.data?.file_token;
  if (!fileToken) {
    throw new Error(`上传文件失败: ${fileName}, response: ${JSON.stringify(res)}`);
  }
  return fileToken;
}
```

**Step 2: Verify it compiles**

Run: `bun build feishu/client.ts --no-bundle`
Expected: No errors

**Step 3: Commit**

```bash
git add feishu/client.ts
git commit -m "feat: add media upload to Feishu client"
```

---

### Task 3: Add attachment_cache table to DB

**Files:**
- Modify: `db/index.ts` (add table + helper functions)

**Step 1: Add attachment_cache table creation in initSchema**

Add after the `feishu_config` table creation (after line 87):

```typescript
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
```

**Step 2: Add helper functions**

Add before the `closeDb` function:

```typescript
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
```

**Step 3: Commit**

```bash
git add db/index.ts
git commit -m "feat: add attachment_cache table and helpers"
```

---

### Task 4: Rewrite sync.ts with full data support

**Files:**
- Modify: `sync.ts` (major rewrite)

This is the largest task. The new sync.ts must:

1. **New field definitions** with attachment(17) and single-select for 所属清单
2. **Content cleaning** - remove `![image]()` and `![file]()` markers
3. **Sub-task formatting** - parse items JSON into checkbox text
4. **Attachment pipeline** - download → cache → upload → collect file_tokens
5. **Batch record creation** with attachment field values
6. **Progress reporting** - show download/upload progress

Key implementation details:

- Process attachments BEFORE creating records (need file_tokens first)
- Rate limit uploads to 5 QPS (200ms delay between each)
- Rate limit downloads to avoid Dida throttling (100ms delay)
- Skip tasks with no attachments in the attachment pipeline
- Use `--reset` flag to clear attachment_cache too
- Use concurrent download with limit (5 parallel downloads)

**Step 1: Rewrite sync.ts**

Complete rewrite preserving the same CLI interface (`--reset`, `--user`).

**Step 2: Test with small batch first**

Run: `bun run sync.ts --user cqrxr79r@user.dida365.com`
Verify: Creates new bitable, downloads attachments, uploads to Feishu

**Step 3: Open in Chrome to verify**

Use Chrome DevTools MCP to navigate to the Feishu bitable URL and verify:
- Images display in attachment field
- Double-click opens preview
- Filters work on 所属清单 and 标签
- Sub-tasks display correctly

**Step 4: Commit**

```bash
git add sync.ts
git commit -m "feat: full data sync with attachments, sub-tasks, and content cleaning"
```

---

### Task 5: Chrome DevTools verification

**Step 1: Navigate to the Feishu bitable URL**
**Step 2: Take screenshot to verify layout**
**Step 3: Click on an attachment to verify preview works**
**Step 4: Test filter by 所属清单**
