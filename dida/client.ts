import type {
  Task, Project, UserConfig, UserProfile,
  BatchCheckResponse, TrashResponse, TaskSummary,
} from "../types.ts";
import { getCachedToken, saveToken } from "../db/index.ts";

const V2_BASE = "https://api.dida365.com/api/v2";

/** 微信扫码登录进度回调 */
export interface LoginCallbacks {
  onQrUrl?(imageUrl: string, qrData: string): Promise<void>;
  onScanWaiting?(): void;
  onScanScanned?(): void;
  onScanConfirmed?(): void;
}

/** 从 Set-Cookie 中解析 token 对应的过期时间戳（秒） */
function parseCookieExpiry(cookies: string[]): number | null {
  const now = Math.floor(Date.now() / 1000);
  for (const cookie of cookies) {
    // 跳过非 t= 或空值的 cookie（如 t=""; 删除 cookie）
    if (!cookie.startsWith("t=") || cookie.startsWith('t="";') || cookie.startsWith("t=;")) continue;
    const maxAge = cookie.match(/Max-Age=(\d+)/i);
    if (maxAge?.[1]) return now + parseInt(maxAge[1]);
    const expires = cookie.match(/Expires=([^;]+)/i);
    if (expires?.[1]) {
      const ts = new Date(expires[1]).getTime();
      if (!isNaN(ts) && ts / 1000 > now) return Math.floor(ts / 1000);
    }
  }
  return null;
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Origin": "https://dida365.com",
  "Referer": "https://dida365.com/",
  "Sec-Ch-Ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "X-Requested-With": "XMLHttpRequest",
  "X-Csrftoken": "",
  "X-Device": JSON.stringify({
    platform: "web", os: "macOS 10.15.7", device: "Chrome 144.0.0.0",
    name: "", version: 8021, id: "698ef84c2a55c37454df5186",
    channel: "website", campaign: "", websocket: "",
  }),
};

/**
 * 滴答清单 V2 API 客户端
 *
 * 用法:
 *   const client = new DidaClient(user);
 *   await client.login();
 *   const data = await client.getBatchData();
 */
export class DidaClient {
  private token: string | null = null;
  private userId: string;
  /** getBatchData 后缓存的项目 ID 列表 */
  private cachedProjectIds: string[] = [];
  /** getBatchData 后缓存的收集箱 ID */
  private cachedInboxId: string | null = null;

  constructor(private user: UserConfig) {
    this.userId = user.id;
  }

  // ─── 认证 ────────────────────────────────────────────

  /** 登录（自动从 SQLite 读缓存，过期则重新登录） */
  async login(forceLogin = false, callbacks?: LoginCallbacks): Promise<void> {
    if (!forceLogin) {
      const cached = getCachedToken(this.userId);
      if (cached) {
        const now = Math.floor(Date.now() / 1000);
        if (now < cached.expires_at) {
          this.token = cached.token;
          return;
        }
      }
    }

    const authType = this.user.authType ?? "password";
    if (authType === "wechat") {
      return this.wechatLogin(callbacks);
    }
    return this.passwordLogin();
  }

  /** 密码登录 */
  private async passwordLogin(): Promise<void> {
    if (!this.user.username || !this.user.password) {
      throw new Error("密码登录需要 username 和 password");
    }

    const isPhone = /^\d+$/.test(this.user.username);
    const loginData = isPhone
      ? { phone: this.user.username, password: this.user.password }
      : { username: this.user.username, password: this.user.password };

    const res = await fetch(`${V2_BASE}/user/signon?wc=true&remember=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...BROWSER_HEADERS },
      body: JSON.stringify(loginData),
    });

    if (!res.ok) {
      throw new Error(`登录失败: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { token: string; userId: string; inboxId: string };
    this.token = data.token;
    const expiresAt = parseCookieExpiry(res.headers.getSetCookie());
    saveToken(this.userId, data.token, {
      userId: data.userId, inboxId: data.inboxId,
      authType: "password", username: this.user.username,
      password: this.user.password,
    }, expiresAt ?? undefined);
  }

  /** 微信扫码登录 */
  private async wechatLogin(callbacks?: LoginCallbacks): Promise<void> {
    // 1. 获取二维码页面，提取 UUID
    const qrPageUrl = "https://open.weixin.qq.com/connect/qrconnect?"
      + "appid=wxf1429a73d311aad4"
      + "&redirect_uri=" + encodeURIComponent("https://dida365.com/sign/wechat")
      + "&response_type=code&scope=snsapi_login&state=Lw==";

    const pageRes = await fetch(qrPageUrl);
    if (!pageRes.ok) throw new Error(`获取微信二维码页面失败: ${pageRes.status}`);
    const html = await pageRes.text();

    const uuidMatch = html.match(/\/connect\/qrcode\/([a-zA-Z0-9_-]+)/);
    if (!uuidMatch) throw new Error("无法从页面提取微信二维码 UUID");
    const uuid = uuidMatch[1];

    // 2. 显示二维码
    const qrImageUrl = `https://open.weixin.qq.com/connect/qrcode/${uuid}`;
    const qrData = `https://open.weixin.qq.com/connect/confirm?uuid=${uuid}`;
    if (callbacks?.onQrUrl) {
      await callbacks.onQrUrl(qrImageUrl, qrData);
    } else {
      console.log(`\n  请使用微信扫描二维码登录:`);
      console.log(`  ${qrImageUrl}\n`);
    }

    // 3. 轮询扫码状态（超时 5 分钟）
    const deadline = Date.now() + 5 * 60 * 1000;
    let code: string | null = null;
    callbacks?.onScanWaiting?.();

    while (!code) {
      if (Date.now() > deadline) throw new Error("微信扫码超时（5分钟）");

      const pollUrl = `https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=${uuid}&_=${Date.now()}`;
      const pollRes = await fetch(pollUrl);
      const text = await pollRes.text();

      const errCodeMatch = text.match(/wx_errcode=(\d+)/);
      const errCode = errCodeMatch?.[1] ? parseInt(errCodeMatch[1]) : 0;

      if (errCode === 405) {
        const codeMatch = text.match(/wx_code='([^']+)'/);
        if (!codeMatch?.[1]) throw new Error("微信授权成功但未获取到 code");
        code = codeMatch[1];
        callbacks?.onScanConfirmed?.();
      } else if (errCode === 404) {
        callbacks?.onScanScanned?.();
      } else if (errCode === 408) {
        // 等待扫码，继续轮询
      } else if (errCode === 402 || errCode === 403) {
        throw new Error("二维码已过期，请重试");
      }
    }

    // 4. 用 code 向滴答验证，获取 token
    //    validate 可能返回 302 重定向，需手动跟随并收集整条链上的所有 cookie
    const validateUrl = `${V2_BASE}/user/sign/wechat/validate?code=${encodeURIComponent(code)}&state=Lw==`;
    const allCookies: string[] = [];

    let res = await fetch(validateUrl, {
      headers: BROWSER_HEADERS,
      redirect: "manual",
    });
    allCookies.push(...res.headers.getSetCookie());

    // 手动跟随重定向链（最多 5 跳），收集每一跳的 Set-Cookie
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops < 5) {
      const location = res.headers.get("location");
      if (!location) break;
      const nextUrl = location.startsWith("http") ? location : new URL(location, validateUrl).href;
      const cookieHeader = allCookies.map(c => c.split(";")[0]).join("; ");
      res = await fetch(nextUrl, {
        headers: { ...BROWSER_HEADERS, Cookie: cookieHeader },
        redirect: "manual",
      });
      allCookies.push(...res.headers.getSetCookie());
      hops++;
    }

    // 从所有 cookie 中提取 token（跳过 t="" 删除 cookie，取最后一个有效 t=）
    let token: string | null = null;
    let tokenCookies: string[] = [];
    for (const cookie of allCookies) {
      if (cookie.startsWith('t="";') || cookie.startsWith("t=;")) continue;
      const match = cookie.match(/^t=([^;]+)/);
      if (match?.[1]) {
        token = match[1];
        tokenCookies = allCookies;
      }
    }

    // 兜底：从最终响应体取
    if (!token) {
      try {
        const body = await res.json() as Record<string, any>;
        if (body.token) token = body.token as string;
      } catch {}
    }

    if (!token) throw new Error("微信登录验证失败：未获取到 token");

    this.token = token;
    const expiresAt = parseCookieExpiry(tokenCookies);
    saveToken(this.userId, token, { authType: "wechat" }, expiresAt ?? undefined);
  }

  /** 更新用户ID（微信登录后获取到真实ID时使用） */
  updateUserId(newId: string) {
    this.userId = newId;
  }

  // ─── 通用请求 ────────────────────────────────────────

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    if (!this.token) throw new Error("未登录，请先调用 login()");

    let url = `${V2_BASE}${path}`;
    if (params) {
      url += `?${new URLSearchParams(params)}`;
    }

    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Cookie: `t=${this.token}` },
    });

    if (!res.ok) {
      throw new Error(`API 请求失败 ${path}: ${res.status} ${await res.text()}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── 用户 ────────────────────────────────────────────

  /** 获取用户资料 */
  async getUserProfile(): Promise<UserProfile> {
    return this.request<UserProfile>("/user/profile");
  }

  // ─── 项目 ────────────────────────────────────────────

  /** 获取清单列表 */
  async getProjects(): Promise<Project[]> {
    return this.request<Project[]>("/projects");
  }

  // ─── 任务 ────────────────────────────────────────────

  /** 获取全量数据：项目 + 活跃任务 + 标签（同时缓存项目列表供后续使用） */
  async getBatchData(): Promise<BatchCheckResponse> {
    const data = await this.request<BatchCheckResponse>("/batch/check/0");
    this.cachedProjectIds = data.projectProfiles.map((p) => p.id);
    this.cachedInboxId = data.inboxId ?? null;
    return data;
  }

  /**
   * 获取已完成任务（按项目逐个获取）
   *
   * Dida API 的 `to` 游标分页存在服务端 bug（返回 500），
   * 因此按项目逐个获取，每个项目独立 limit=5000，更可靠也能拿到更多数据。
   */
  async getCompletedTasks(): Promise<Task[]> {
    const projectIds = await this.getAllProjectIds();
    const seen = new Set<string>();
    const all: Task[] = [];
    const PER_PROJECT_LIMIT = 5000;

    for (const projectId of projectIds) {
      try {
        const tasks = await this.request<Task[]>(
          `/project/${projectId}/completed/`,
          { from: "", limit: String(PER_PROJECT_LIMIT) },
        );
        if (!tasks?.length) continue;

        for (const t of tasks) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            all.push(t);
          }
        }

        if (tasks.length >= PER_PROJECT_LIMIT) {
          console.warn(`  ⚠ 项目 ${projectId} 已完成任务达到 ${PER_PROJECT_LIMIT} 条上限，可能有遗漏`);
        }
      } catch {
        // 单个项目获取失败不影响整体
      }
    }

    return all;
  }

  /**
   * 获取已放弃任务（批量获取，放弃任务通常很少）
   *
   * 注意：Dida API 的 `to` 游标分页存在服务端 bug（返回 500），
   * 因此使用 `limit` 参数大批量获取，避免依赖游标翻页。
   */
  async getAbandonedTasks(): Promise<Task[]> {
    const BATCH_SIZE = 5000;
    const params: Record<string, string> = { from: "", status: "Abandoned", limit: String(BATCH_SIZE) };

    const tasks = await this.request<Task[]>("/project/all/closed", params);
    if (!tasks?.length) return [];

    if (tasks.length >= BATCH_SIZE) {
      console.warn(`  ⚠ 已放弃任务达到 ${BATCH_SIZE} 条上限，可能有遗漏`);
    }

    return tasks;
  }

  /** 收集所有项目 ID（含收集箱），用于按项目遍历 */
  private async getAllProjectIds(): Promise<string[]> {
    // 优先使用 getBatchData 缓存的数据
    let projectIds = [...this.cachedProjectIds];
    let inboxId = this.cachedInboxId;

    // 如果没有缓存，重新获取
    if (!projectIds.length) {
      const projects = await this.getProjects();
      projectIds = projects.map((p) => p.id);
    }

    // 确保收集箱包含在内
    if (inboxId && !projectIds.includes(inboxId)) {
      projectIds.unshift(inboxId);
    }

    // 兜底：从已有活跃任务中提取可能遗漏的 projectId（如收集箱）
    // 如果 inboxId 未知，尝试通过 getBatchData 的活跃任务推断
    if (!inboxId) {
      try {
        const batch = await this.request<BatchCheckResponse>("/batch/check/0");
        if (batch.inboxId && !projectIds.includes(batch.inboxId)) {
          projectIds.unshift(batch.inboxId);
        }
      } catch {
        // 忽略
      }
    }

    return projectIds;
  }

  /** 获取垃圾桶任务（自动分页） */
  async getTrashTasks(): Promise<Task[]> {
    const all: Task[] = [];
    let start = 0;

    while (true) {
      const params: Record<string, string> = { limit: "50" };
      if (start > 0) params.start = String(start);

      const res = await this.request<TrashResponse>("/project/all/trash/page", params);
      if (!res.tasks?.length) break;

      all.push(...res.tasks);

      if (!res.next || res.tasks.length < 50) break;
      start = res.next;
    }

    return all;
  }

  /** 获取任务统计 */
  async getTaskSummary(): Promise<TaskSummary> {
    return this.request<TaskSummary>("/tasks/summary");
  }

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
}
