// 调用 Claude Code CLI（headless `-p` 模式），返回适合朗读的短答案。
import { spawn } from 'node:child_process';
import { CONFIG } from './config';

// 清理"嵌套 Claude Code 会话"标记，让 spawn 出的 claude 以干净的顶层身份启动。
// 否则若本应用是在某个 Claude Code 会话终端里启动的，子进程会继承 CLAUDECODE=1
// 等标记，可能触发 403「Request not allowed」（嵌套调用保护）。
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_EFFORT', 'AI_AGENT',
  ]) {
    delete env[k];
  }
  return env;
}

/**
 * 调用 claude。
 * @param question 用户的问题/任务
 * @param skill    可选：要让 claude 跑的 skill 名（如 'openapi'）。headless 不能用 /skill，
 *                 这里改用"明确要求使用该技能 + 预批工具 + 非交互权限模式"来触发。
 */
export function askClaude(question: string, skill?: string): Promise<string> {
  let prompt: string;
  const args: string[] = ['-p', '--model', CONFIG.CLAUDE_MODEL];

  // 字数上限（>0 才追加；0 = 不限制）。普通问答和 skill 两种提示都加上。
  const lenClause = CONFIG.ANSWER_MAX_CHARS > 0
    ? `\n\n请把答案控制在 ${CONFIG.ANSWER_MAX_CHARS} 字以内。`
    : '';

  if (skill) {
    // 用自然语言明确要求使用该 skill（headless 下靠描述匹配 + 显式指令触发）
    prompt =
      `请使用 \`${skill}\` 技能来完成下面的任务。完成后，用口语化的中文给出一段可朗读的结论` +
      `（不要 Markdown / 代码块 / 列表 / 表情）。\n\n任务：${question}${lenClause}`;
    args.push(prompt);
    args.push('--permission-mode', CONFIG.SKILL_PERMISSION_MODE);
    args.push('--allowedTools', CONFIG.SKILL_ALLOWED_TOOLS); // 末位变长参数，单 token 不会吞掉别的
  } else {
    prompt = CONFIG.SPOKEN_STYLE + question + lenClause;
    args.push(prompt);
  }

  const timeoutMs = skill ? CONFIG.SKILL_TIMEOUT_MS : CONFIG.CLAUDE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(CONFIG.CLAUDE_BIN, args, {
      cwd: CONFIG.CLAUDE_WORKDIR,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      resolve('抱歉，处理超时了。');
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.error('[claude] spawn error:', e.message);
      resolve('抱歉，调用失败了。');
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = out.trim();
      if (!text) {
        if (err.trim()) console.error('[claude] stderr:', err.trim().slice(0, 300));
        resolve(code === 0 ? '（没有得到答案）' : '抱歉，出了点问题。');
        return;
      }
      resolve(text);
    });
  });
}
