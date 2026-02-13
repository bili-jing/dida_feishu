import { test, expect, beforeAll, afterAll } from "bun:test";
import { DidaClient } from "../dida/client.ts";
import { getDb, closeDb } from "../db/index.ts";
import type { UserConfig } from "../types.ts";

// 需要真实凭证才能运行，跳过无凭证的环境
const user: UserConfig | null = await (async () => {
  const file = Bun.file("./users.json");
  if (!(await file.exists())) return null;
  const users = await file.json() as UserConfig[];
  return users[0] ?? null;
})();

const describeIf = user ? test : test.skip;

let client: DidaClient;

beforeAll(() => {
  if (user) {
    getDb();
    client = new DidaClient(user);
  }
});

afterAll(() => {
  closeDb();
});

describeIf("login 登录成功", async () => {
  await client.login();
  // 如果没有抛错就是成功
  expect(true).toBe(true);
});

describeIf("getUserProfile 返回用户信息", async () => {
  await client.login();
  const profile = await client.getUserProfile();
  expect(profile.username).toBeDefined();
  expect(profile.displayName || profile.name).toBeTruthy();
});

describeIf("getProjects 返回清单列表", async () => {
  await client.login();
  const projects = await client.getProjects();
  expect(Array.isArray(projects)).toBe(true);
  for (const p of projects) {
    expect(p.id).toBeDefined();
    expect(p.name).toBeDefined();
  }
});

describeIf("getBatchData 返回全量数据", async () => {
  await client.login();
  const data = await client.getBatchData();
  expect(data.projectProfiles).toBeDefined();
  expect(data.syncTaskBean).toBeDefined();
  expect(data.inboxId).toBeDefined();
  expect(Array.isArray(data.syncTaskBean.update)).toBe(true);
});

describeIf("getCompletedTasks 返回已完成任务", async () => {
  await client.login();
  const tasks = await client.getCompletedTasks();
  expect(Array.isArray(tasks)).toBe(true);
  for (const t of tasks) {
    expect(t.id).toBeDefined();
    expect(t.status).toBe(2);
  }
});

describeIf("getAbandonedTasks 返回已放弃任务", async () => {
  await client.login();
  const tasks = await client.getAbandonedTasks();
  expect(Array.isArray(tasks)).toBe(true);
});

describeIf("getTrashTasks 返回垃圾桶任务", async () => {
  await client.login();
  const tasks = await client.getTrashTasks();
  expect(Array.isArray(tasks)).toBe(true);
});
