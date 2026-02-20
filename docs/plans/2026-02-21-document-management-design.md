# 飞书文档管理功能设计

## 背景

当前每次"全量重建"会在飞书云空间创建一个新的多维表格，但旧表格不会被删除，也不再被程序跟踪。用户无法管理历史创建的文档，导致飞书云空间逐渐积累孤儿表格。

## 目标

1. 用户能查看所有已创建的飞书多维表格（通过云空间扫描 + 本地历史记录）
2. 用户能删除不再需要的旧表格
3. 全量重建前提示用户是否删除旧表格
4. 在飞书配置菜单中展示当前文档信息

## 数据模型

### 新增 `feishu_doc_history` 表

```sql
CREATE TABLE IF NOT EXISTS feishu_doc_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  app_token TEXT NOT NULL,
  table_id TEXT,
  app_url TEXT,
  name TEXT,
  is_current INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_history_user ON feishu_doc_history (user_id, is_current);
```

- `is_current = 1`: 当前正在使用的表格
- `is_current = 0`: 历史表格
- `deleted_at` 非空: 已从飞书删除

## 核心流程

### 1. 文档发现（云空间扫描 + 本地记录合并）

调用 `client.drive.file.list({ params: { folder_token: "", page_size: 200 } })` 扫描根目录，筛选 `type === "bitable"` 且名称包含 `"滴答清单"` 的文档。与本地 `feishu_doc_history` 合并去重（按 `app_token`）。

### 2. 文档管理菜单

**入口 A：用户操作菜单顶层**

新增菜单项 `"文档管理"`，进入后：

1. spinner 提示"扫描飞书云空间..."
2. 列出所有发现的文档，格式：
   - `★ 滴答清单 - 苏沐林  (当前使用)  2024-02-20`
   - `  滴答清单 - 苏沐林  2024-02-15`
   - `  滴答清单 - 苏沐林  2024-02-10`
3. 操作选项：
   - 选择单个文档 → 子菜单：打开链接 / 删除 / 设为当前
   - 批量删除历史文档
   - 返回

**入口 B：飞书配置菜单**

在已有的飞书配置信息中增加：
- 当前文档名称和创建时间
- 历史文档数量提示（如 `"历史文档: 3 个"`）
- 新增菜单项 `"管理文档"` → 跳转到文档管理菜单

### 3. 全量重建流程改造

在 `syncToFeishu` 中选择 `"全量重建"` 后、执行 `fullSyncUser` 前：

1. 检查是否存在当前飞书配置（`getFeishuConfig`）
2. 如果存在，提示用户：
   ```
   检测到旧表格「滴答清单 - xxx」
   ○ 删除旧表格后重建
   ○ 保留旧表格，创建新的
   ○ 取消
   ```
3. 用户选择删除 → 调用飞书删除 API → 更新本地记录 → 执行全量重建
4. 用户选择保留 → 旧记录移入 history → 执行全量重建

### 4. 删除实现

```typescript
await client.drive.file.delete({
  params: { type: "bitable" },
  path: { file_token: appToken },
});
```

删除后文档进入飞书回收站（30 天内可恢复）。本地 `feishu_doc_history` 标记 `deleted_at`。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `db/index.ts` | 新增 `feishu_doc_history` 表、CRUD 函数 |
| `feishu/client.ts` | 新增 `deleteBitable`、`scanBitables` 函数 |
| `index.ts` | 新增文档管理菜单、修改飞书配置菜单、修改全量重建流程 |
| `sync.ts` | `fullSyncUser` 中写入 history 记录 |
