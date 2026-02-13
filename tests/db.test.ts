import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { getDb, upsertProjects, upsertTasks, getCachedToken, saveToken, getStats, closeDb } from "../db/index.ts";
import type { Project, Task } from "../types.ts";

// 使用内存数据库测试前，先关闭可能打开的连接
beforeAll(() => {
  closeDb();
});

afterAll(() => {
  closeDb();
});

test("getDb 初始化数据库并创建表", () => {
  const db = getDb();
  expect(db).toBeDefined();

  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const names = tables.map(t => t.name);
  expect(names).toContain("projects");
  expect(names).toContain("tasks");
  expect(names).toContain("tokens");
  expect(names).toContain("sync_state");
});

test("getDb 创建索引", () => {
  const db = getDb();
  const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[];
  const names = indexes.map(i => i.name);
  expect(names).toContain("idx_tasks_user_status");
  expect(names).toContain("idx_tasks_user_project");
  expect(names).toContain("idx_sync_state_user");
});

test("upsertProjects 插入和更新项目", () => {
  const projects: Project[] = [
    { id: "p1", name: "项目A", kind: "TASK", viewMode: "list" },
    { id: "p2", name: "项目B", kind: "NOTE" },
  ];

  upsertProjects("testuser", projects);

  const db = getDb();
  const rows = db.query("SELECT id, name, kind FROM projects WHERE user_id = 'testuser' ORDER BY id").all() as any[];
  expect(rows).toHaveLength(2);
  expect(rows[0].name).toBe("项目A");
  expect(rows[1].name).toBe("项目B");

  // 更新
  upsertProjects("testuser", [{ id: "p1", name: "项目A改名" }]);
  const updated = db.query("SELECT name FROM projects WHERE id = 'p1' AND user_id = 'testuser'").get() as any;
  expect(updated.name).toBe("项目A改名");
});

test("upsertProjects 空数组不报错", () => {
  expect(() => upsertProjects("testuser", [])).not.toThrow();
});

test("upsertTasks 插入和更新任务", () => {
  const tasks: Task[] = [
    { id: "t1", projectId: "p1", title: "任务1", priority: 0, status: 0 },
    { id: "t2", projectId: "p1", title: "任务2", priority: 1, status: 2, tags: ["tag1"], completedTime: "2026-01-01" },
  ];

  upsertTasks("testuser", tasks);

  const db = getDb();
  const rows = db.query("SELECT id, title, status, tags FROM tasks WHERE user_id = 'testuser' ORDER BY id").all() as any[];
  expect(rows).toHaveLength(2);
  expect(rows[0].title).toBe("任务1");
  expect(rows[1].status).toBe(2);
  expect(JSON.parse(rows[1].tags)).toEqual(["tag1"]);
});

test("upsertTasks 空数组不报错", () => {
  expect(() => upsertTasks("testuser", [])).not.toThrow();
});

test("upsertTasks upsert 去重", () => {
  upsertTasks("testuser", [
    { id: "t1", projectId: "p1", title: "任务1-更新", priority: 3, status: 0 },
  ]);

  const db = getDb();
  const row = db.query("SELECT title, priority FROM tasks WHERE id = 't1' AND user_id = 'testuser'").get() as any;
  expect(row.title).toBe("任务1-更新");
  expect(row.priority).toBe(3);
});

test("saveToken 和 getCachedToken", () => {
  saveToken("testuser", "fake-token-123", { userId: "u1", inboxId: "inbox1" });

  const cached = getCachedToken("testuser");
  expect(cached).not.toBeNull();
  expect(cached!.token).toBe("fake-token-123");
  expect(cached!.extra.userId).toBe("u1");
  expect(cached!.created_at).toBeGreaterThan(0);
});

test("getCachedToken 不存在用户返回 null", () => {
  expect(getCachedToken("nonexistent")).toBeNull();
});

test("getStats 返回正确统计", () => {
  const stats = getStats("testuser");
  expect(stats.projects).toBeGreaterThanOrEqual(2);
  expect(stats.active).toBeGreaterThanOrEqual(1);
  expect(stats.completed).toBeGreaterThanOrEqual(1);
  expect(stats.total).toBe(stats.active + stats.completed + stats.abandoned);
});

test("多用户数据隔离", () => {
  upsertTasks("user_a", [{ id: "t99", projectId: "p1", title: "A的任务", priority: 0, status: 0 }]);
  upsertTasks("user_b", [{ id: "t99", projectId: "p1", title: "B的任务", priority: 0, status: 0 }]);

  const db = getDb();
  const a = db.query("SELECT title FROM tasks WHERE id = 't99' AND user_id = 'user_a'").get() as any;
  const b = db.query("SELECT title FROM tasks WHERE id = 't99' AND user_id = 'user_b'").get() as any;
  expect(a.title).toBe("A的任务");
  expect(b.title).toBe("B的任务");
});
