import type {
  Task, Project, UserConfig, UserProfile,
  BatchCheckResponse, TrashResponse, TaskSummary,
} from "../types.ts";
import { getCachedToken, saveToken } from "../db/index.ts";

const V2_BASE = "https://api.dida365.com/api/v2";

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

  constructor(private user: UserConfig) {
    this.userId = user.id;
  }

  // ─── 认证 ────────────────────────────────────────────

  /** 登录（自动从 SQLite 读缓存，过期则重新登录） */
  async login(): Promise<void> {
    const cached = getCachedToken(this.userId);
    if (cached) {
      const now = Math.floor(Date.now() / 1000);
      if (now < cached.created_at + 86400) {
        this.token = cached.token;
        return;
      }
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
    saveToken(this.userId, data.token, { userId: data.userId, inboxId: data.inboxId });
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

  /** 获取全量数据：项目 + 活跃任务 + 标签 */
  async getBatchData(): Promise<BatchCheckResponse> {
    return this.request<BatchCheckResponse>("/batch/check/0");
  }

  /** 获取已关闭任务（已完成/已放弃），自动分页 */
  private async getClosedTasks(status: "Completed" | "Abandoned"): Promise<Task[]> {
    const all: Task[] = [];
    let cursor: string | undefined;

    while (true) {
      const params: Record<string, string> = { from: "", status };
      if (cursor) params.to = cursor;

      const tasks = await this.request<Task[]>("/project/all/closed", params);
      if (!tasks?.length) break;

      all.push(...tasks);

      if (tasks.length < 50) break;
      const last = tasks[tasks.length - 1];
      if (!last?.completedTime) break;
      cursor = last.completedTime;
    }

    return all;
  }

  /** 获取所有已完成任务 */
  async getCompletedTasks(): Promise<Task[]> {
    return this.getClosedTasks("Completed");
  }

  /** 获取所有已放弃任务 */
  async getAbandonedTasks(): Promise<Task[]> {
    return this.getClosedTasks("Abandoned");
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
}
