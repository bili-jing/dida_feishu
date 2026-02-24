import * as lark from "@larksuiteoapi/node-sdk";

// 缓存：按 appId 复用 client 实例
const _clientCache = new Map<string, lark.Client>();

// 当前活跃的 client（通过 setFeishuCredentials 或 env 设置）
let _activeAppId: string | null = null;

/** 设置当前用户的飞书凭据，后续调用 getFeishuClient() 会使用此凭据 */
export function setFeishuCredentials(appId: string, appSecret: string) {
  _activeAppId = appId;
  if (!_clientCache.has(appId)) {
    _clientCache.set(appId, new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    }));
  }
}

/** 清除当前活跃凭据，回退到 env 配置 */
export function clearFeishuCredentials() {
  _activeAppId = null;
}

export function getFeishuClient(): lark.Client {
  // 优先使用 setFeishuCredentials 设置的凭据
  if (_activeAppId) {
    const client = _clientCache.get(_activeAppId);
    if (client) return client;
  }

  // 回退到环境变量
  const envAppId = Bun.env.FEISHU_APP_ID;
  const envAppSecret = Bun.env.FEISHU_APP_SECRET;
  if (!envAppId || !envAppSecret) {
    throw new Error("未配置飞书凭据，请先绑定飞书应用或在 .env 中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET");
  }

  if (!_clientCache.has(envAppId)) {
    _clientCache.set(envAppId, new lark.Client({
      appId: envAppId,
      appSecret: envAppSecret,
      domain: lark.Domain.Feishu,
    }));
  }
  return _clientCache.get(envAppId)!;
}

/** 延迟，避免限流 */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Bitable 操作 ─────────────────────────────────────

export interface BitableField {
  field_name: string;
  type: number;
  property?: any;
}

/** 创建多维表格（自动设置链接可编辑权限） */
export async function createBitable(name: string, folderToken?: string) {
  const client = getFeishuClient();
  const res = await client.bitable.app.create({
    data: {
      name,
      folder_token: folderToken,
      time_zone: "Asia/Shanghai",
    },
  });
  if (res.code !== 0) throw new Error(`创建多维表格失败: ${res.msg}`);
  const app = res.data!.app!;

  // 设置链接分享权限：互联网上获得链接的任何人可编辑（支持外部用户访问）
  try {
    await client.drive.permissionPublic.patch({
      path: { token: app.app_token! },
      params: { type: "bitable" },
      data: {
        external_access: true,
        link_share_entity: "anyone_editable",
        comment_entity: "anyone_can_edit",
      },
    });
  } catch {}

  return app;
}

/** 更新已有多维表格的分享权限（支持外部用户访问） */
export async function ensureBitablePermission(appToken: string) {
  const client = getFeishuClient();
  await client.drive.permissionPublic.patch({
    path: { token: appToken },
    params: { type: "bitable" },
    data: {
      external_access: true,
      link_share_entity: "anyone_editable",
      comment_entity: "anyone_can_edit",
    },
  });
}

/** 创建数据表（含字段定义） */
export async function createTable(
  appToken: string,
  tableName: string,
  fields: BitableField[]
) {
  const client = getFeishuClient();
  const res = await client.bitable.appTable.create({
    data: {
      table: {
        name: tableName,
        default_view_name: "全部任务",
        fields: fields as any,
      },
    },
    path: { app_token: appToken },
  });
  if (res.code !== 0) throw new Error(`创建数据表失败: ${res.msg}`);
  return {
    tableId: res.data!.table_id!,
    defaultViewId: res.data!.default_view_id,
    fieldIds: res.data!.field_id_list,
  };
}

/** 创建视图 */
export async function createView(
  appToken: string,
  tableId: string,
  viewName: string,
  viewType: string
) {
  const client = getFeishuClient();
  const res = await client.bitable.appTableView.create({
    data: {
      view_name: viewName,
      view_type: viewType,
    },
    path: { app_token: appToken, table_id: tableId },
  });
  if (res.code !== 0) throw new Error(`创建视图失败: ${res.msg}`);
  return res.data!.view!;
}

export interface FieldInfo {
  field_id: string;
  options?: Array<{ name: string; id: string }>;
}

/** 获取数据表的字段列表，返回 { field_name → FieldInfo } 映射 */
export async function getFieldMap(
  appToken: string,
  tableId: string
): Promise<Record<string, FieldInfo>> {
  const client = getFeishuClient();
  const res = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  const map: Record<string, FieldInfo> = {};
  for (const f of res.data?.items ?? []) {
    if (f.field_name && f.field_id) {
      map[f.field_name] = {
        field_id: f.field_id,
        options: f.property?.options?.map((o: any) => ({ name: o.name, id: o.id })),
      };
    }
  }
  return map;
}

/** 更新视图属性（筛选、分组等） */
export async function patchView(
  appToken: string,
  tableId: string,
  viewId: string,
  property: Record<string, any>
) {
  const client = getFeishuClient();
  const res = await client.bitable.appTableView.patch({
    path: { app_token: appToken, table_id: tableId, view_id: viewId },
    data: { property },
  });
  if (res.code !== 0) throw new Error(`更新视图失败: ${res.msg}`);
  return res.data;
}

/** 批量创建记录（每批最多 500 条） */
export async function batchCreateRecords(
  appToken: string,
  tableId: string,
  records: Array<{ fields: Record<string, any> }>
) {
  const client = getFeishuClient();
  const results: any[] = [];

  // 分批处理，每批 500 条
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const res = await client.bitable.appTableRecord.batchCreate({
      data: { records: batch },
      path: { app_token: appToken, table_id: tableId },
    });
    if (res.code !== 0) throw new Error(`批量创建记录失败: ${res.msg}`);
    results.push(...(res.data!.records ?? []));

    if (i + 500 < records.length) await sleep(300); // 避免限流
  }

  return results;
}

/** 批量更新记录（每批最多 500 条） */
export async function batchUpdateRecords(
  appToken: string,
  tableId: string,
  records: Array<{ record_id: string; fields: Record<string, any> }>
) {
  const client = getFeishuClient();
  const results: any[] = [];

  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    const res = await client.bitable.appTableRecord.batchUpdate({
      data: { records: batch },
      path: { app_token: appToken, table_id: tableId },
    });
    if (res.code !== 0) throw new Error(`批量更新记录失败: ${res.msg}`);
    results.push(...(res.data!.records ?? []));

    if (i + 500 < records.length) await sleep(300);
  }

  return results;
}

/** 获取数据表中所有记录的 record_id 集合 */
export async function listRecordIds(
  appToken: string,
  tableId: string
): Promise<Set<string>> {
  const client = getFeishuClient();
  const ids = new Set<string>();
  let pageToken: string | undefined;

  do {
    const res = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: {
        page_size: 500,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0) throw new Error(`获取记录列表失败: ${res.msg}`);
    for (const r of res.data?.items ?? []) {
      if (r.record_id) ids.add(r.record_id);
    }
    pageToken = res.data?.page_token ?? undefined;
  } while (pageToken);

  return ids;
}

/** 获取多维表格信息 */
export async function getBitableInfo(appToken: string) {
  const client = getFeishuClient();
  const res = await client.bitable.app.get({
    path: { app_token: appToken },
  });
  if (res.code !== 0) throw new Error(`获取多维表格信息失败: ${res.msg}`);
  return res.data!.app!;
}

/** 删除飞书多维表格（移入回收站） */
export async function deleteBitable(appToken: string) {
  const client = getFeishuClient();
  const res = await client.drive.file.delete({
    params: { type: "bitable" },
    path: { file_token: appToken },
  });
  if (res.code !== 0) throw new Error(`删除多维表格失败: ${res.msg}`);
  return res.data;
}

/** 扫描飞书云空间，查找名称包含指定前缀的多维表格 */
export async function scanBitables(namePrefix: string = "滴答清单"): Promise<Array<{
  token: string;
  name: string;
  type: string;
  created_time: string;
  modified_time: string;
  url: string;
}>> {
  const client = getFeishuClient();
  const results: Array<{
    token: string;
    name: string;
    type: string;
    created_time: string;
    modified_time: string;
    url: string;
  }> = [];

  let pageToken: string | undefined;
  do {
    const res = await client.drive.file.list({
      params: {
        folder_token: "",
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0) throw new Error(`扫描云空间失败: ${res.msg}`);

    for (const file of res.data?.files ?? []) {
      if (file.type === "bitable" && file.name?.includes(namePrefix)) {
        results.push({
          token: file.token!,
          name: file.name!,
          type: file.type!,
          created_time: file.created_time ?? "",
          modified_time: file.modified_time ?? "",
          url: file.url ?? `https://feishu.cn/base/${file.token}`,
        });
      }
    }
    pageToken = res.data?.next_page_token;
  } while (pageToken);

  return results;
}

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
      file: fileBuffer,
    },
  });
  const fileToken = res?.file_token ?? (res as any)?.data?.file_token;
  if (!fileToken) {
    throw new Error(`上传文件失败: ${fileName}, response: ${JSON.stringify(res)}`);
  }
  return fileToken;
}

// ─── 文档操作 ─────────────────────────────────────────

/** 创建文档 */
export async function createDocument(title: string, folderToken?: string) {
  const client = getFeishuClient();
  const res = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (res.code !== 0) throw new Error(`创建文档失败: ${res.msg}`);
  return res.data!.document!;
}

/** 向文档添加内容块 */
export async function addDocumentBlocks(
  documentId: string,
  blockId: string,
  children: any[],
  index?: number
) {
  const client = getFeishuClient();
  const res = await client.docx.documentBlockChildren.create({
    data: {
      children,
      index,
    },
    params: {
      document_revision_id: -1,
    },
    path: {
      document_id: documentId,
      block_id: blockId,
    },
  });
  if (res.code !== 0) throw new Error(`添加文档内容失败: ${res.msg}`);
  return res.data!;
}

// ─── 云空间操作 ──────────────────────────────────────

/** 创建文件夹 */
export async function createFolder(name: string, parentFolderToken: string) {
  const client = getFeishuClient();
  const res = await client.drive.file.createFolder({
    data: { name, folder_token: parentFolderToken },
  });
  if (res.code !== 0) throw new Error(`创建文件夹失败: ${res.msg}`);
  return res.data!;
}

/** 列出文件夹内容 */
export async function listFiles(folderToken: string) {
  const client = getFeishuClient();
  const res = await client.drive.file.list({
    params: { folder_token: folderToken, page_size: 50 },
  });
  if (res.code !== 0) throw new Error(`列出文件失败: ${res.msg}`);
  return res.data!.files ?? [];
}

/** 获取根文件夹 token */
export async function getRootFolderToken() {
  const client = getFeishuClient();
  const res = await client.drive.file.list({
    params: { folder_token: "", page_size: 1 },
  });
  // 根文件夹可以通过创建文件夹在空 folder_token 下来使用
  return "";
}
