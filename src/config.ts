// 应用配置：内置默认值 + 可选的本地 JSON 覆盖。
//
// 用户改触发词 / skill 映射等，不用动代码、不用重新 build：
// 在运行目录放一个 config.local.json（可从 config.example.json 复制），改完重启即可。
// 路径优先级：环境变量 XIAOAI_CONFIG > <运行目录>/config.local.json
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 一条触发规则：命中 keywords 任一词即触发；
//  - 带 skill：把触发词后面的文字当参数，直接让 claude 跑这个 skill
//  - 不带 skill：普通问答，触发词后面的文字当问题
export interface TriggerRule {
  keywords: string[];
  skill?: string;
}

export interface AppConfig {
  TRIGGERS: TriggerRule[];
  CLAUDE_BIN: string;
  CLAUDE_MODEL: string;
  CLAUDE_WORKDIR: string;
  CLAUDE_TIMEOUT_MS: number;
  SPOKEN_STYLE: string;
  ANSWER_MAX_CHARS: number;
  THINKING_PROMPT: string;
  THINKING_REPEAT_MS: number;
  SKILL_PERMISSION_MODE: string;
  SKILL_ALLOWED_TOOLS: string;
  SKILL_TIMEOUT_MS: number;
  POLL_INTERVAL_MS: number;
}

const DEFAULTS: AppConfig = {
  // 触发规则：每条 = 一组触发词 + 可选 skill。命中触发词后，后面的文字当参数/问题。
  // 例：{ keywords:['问问贾维斯'], skill:'news' } → 说「问问贾维斯 特斯拉」就跑 news 扫特斯拉
  // 匹配时取"最具体"的触发词（更长优先），所以可以长短词共存。
  TRIGGERS: [
    { keywords: ["问问贾维斯", "贾维斯"], skill: "news" }, // 触发词直接绑 skill
    { keywords: ["问问克劳德", "克劳德", "帮我问"] }, // 不带 skill = 普通问答
  ],

  // Claude Code CLI
  // 默认按 PATH 找 `claude`；装在非标准位置时用 CLAUDE_BIN 环境变量或 config.local.json 指定绝对路径
  CLAUDE_BIN: process.env.CLAUDE_BIN || "claude",
  // 模型：默认 haiku（语音问答又快又省）；可填 'sonnet' / 'opus' 或完整模型 ID
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || "haiku",
  CLAUDE_WORKDIR: process.env.CLAUDE_WORKDIR || process.cwd(),
  CLAUDE_TIMEOUT_MS: 120_000,

  // 拼在问题前，约束答案适合朗读
  SPOKEN_STYLE:
    "请用口语化的中文回答下面的问题，答案会被小爱音箱朗读出来，" +
    "所以不要用 Markdown、代码块、列表或表情符号。\n\n问题：",

  // 答案字数上限：>0 时在提示词里要求"控制在 N 字以内"；0 = 不限制。
  // 对普通问答和 skill 两种提示都生效。
  ANSWER_MAX_CHARS: 0,

  // 命中触发词后立刻播报的提示语（同时起到打断小爱、告知"在处理中"的作用）
  THINKING_PROMPT: "正在思考中，请稍后",

  // 等待 claude 返回期间，每隔多少毫秒重复播一次 THINKING_PROMPT（填空档，避免长时间静默）。
  // 设为 0 关闭重复，只在命中时播一次。建议 ≥6s，太短会和上一句 TTS 互相打断。
  THINKING_REPEAT_MS: 8_000,

  // 跑 skill 时给 claude 的权限模式（语音无人审批，必须非交互）
  SKILL_PERMISSION_MODE: "bypassPermissions",
  SKILL_ALLOWED_TOOLS: "Bash,Read,Write,Edit,WebFetch,WebSearch,Skill",
  SKILL_TIMEOUT_MS: 240_000,

  // 对话轮询间隔（毫秒）——对齐 xiaomusic 的 1s（云端轮询的实际天花板）
  POLL_INTERVAL_MS: 1_000,
};

function loadOverrides(): { cfg: AppConfig; source: string } {
  const path =
    process.env.XIAOAI_CONFIG || join(process.cwd(), "config.local.json");
  if (!existsSync(path)) {
    return { cfg: DEFAULTS, source: "内置默认值（未找到 config.local.json）" };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
    // 浅合并：JSON 里出现的键覆盖默认值；未出现的保留默认
    const merged: AppConfig = { ...DEFAULTS, ...raw };
    return { cfg: merged, source: path };
  } catch (e) {
    console.error(
      `[config] 解析 ${path} 失败，回退默认值：`,
      (e as Error).message,
    );
    return { cfg: DEFAULTS, source: `内置默认值（${path} 解析失败）` };
  }
}

const loaded = loadOverrides();
export const CONFIG: AppConfig = loaded.cfg;
export const CONFIG_SOURCE: string = loaded.source;
