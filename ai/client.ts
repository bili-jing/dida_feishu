/**
 * 豆包 (Doubao / 火山引擎 Ark) AI 客户端
 *
 * 兼容 OpenAI Chat Completions 格式
 */

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

export interface AIConfig {
  apiKey: string;
  model: string;              // 文本模型 (如 doubao-seed-2-0-lite)
  visionModel?: string;       // 视觉模型 (可选)
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string }; file_url?: { url: string } }>;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** 调用 Chat Completions API（含 429 重试 + 指数退避） */
async function chatCompletion(
  config: AIConfig,
  messages: ChatMessage[],
  options?: { model?: string; maxTokens?: number; temperature?: number },
): Promise<string> {
  const model = options?.model ?? config.model;
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${ARK_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options?.maxTokens ?? 300,
        temperature: options?.temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      // 指数退避 + 随机抖动，避免高并发下 thundering herd
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Doubao API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    return data.choices[0]?.message?.content?.trim() ?? "";
  }
  // 理论上不可达：循环内每条路径都会 return 或 throw
  throw new Error("Doubao API: max retries exceeded");
}

/** 从 AI 响应中提取 JSON */
function parseAIJson(raw: string): { title: string; summary: string } {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        title: String(parsed.title || "").slice(0, 50),
        summary: String(parsed.summary || "").slice(0, 500),
      };
    }
  } catch {}
  return { title: "", summary: "" };
}

const SYSTEM_PROMPT = `你是一个信息整理助手。用户会给你一段从手机笔记/备忘录中提取的文本内容。
请根据内容生成：
1. title：一个简短的标题（不超过20个字），概括核心主题
2. summary：一个简洁的摘要（不超过100个字），提取关键信息

请严格按以下 JSON 格式返回，不要包含其他内容：
{"title": "...", "summary": "..."}`;

/** 为任务生成 AI 摘要（标题 + 摘要） */
export async function summarizeTask(
  config: AIConfig,
  content: string,
  taskType: string,
): Promise<{ title: string; summary: string }> {
  const userContent = `内容类型: ${taskType}\n\n${content.slice(0, 4000)}`;

  const result = await chatCompletion(config, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]);

  return parseAIJson(result);
}

/** 为图片内容生成描述（使用视觉模型） */
export async function describeImage(
  config: AIConfig,
  imageBase64: string,
  mimeType = "image/jpeg",
): Promise<{ title: string; summary: string }> {
  if (!config.visionModel) return { title: "", summary: "" };

  const result = await chatCompletion(
    config,
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text", text: "请根据图片内容生成标题和摘要" },
        ],
      },
    ],
    { model: config.visionModel, maxTokens: 300 },
  );

  return parseAIJson(result);
}

/** 为文档文本内容生成摘要 */
export async function summarizeDocument(
  config: AIConfig,
  textContent: string,
): Promise<{ title: string; summary: string }> {
  const trimmed = textContent.slice(0, 6000);
  const result = await chatCompletion(config, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `内容类型: 文档\n\n${trimmed}` },
  ], { maxTokens: 300 });

  return parseAIJson(result);
}

/** 验证 API 配置是否有效 */
export async function validateConfig(config: AIConfig): Promise<boolean> {
  try {
    await chatCompletion(config, [{ role: "user", content: "你好" }], { maxTokens: 5 });
    return true;
  } catch {
    return false;
  }
}
