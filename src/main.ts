// 小爱音箱 → Claude Code 独立应用（入口）
// 流程：恢复/扫码登录小米账号 → 列设备并选一台托管 → 轮询对话记录
//       → 命中触发词 → claude -p → 让小爱用 TTS 念出答案
import './shim'; // 必须最先 import：注入全局 host 垫片

import { spawn } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { ConfigManager } from './config/manager';
import { AccountManager } from './account/manager';
import { AuthService } from './auth/service';
import { ConversationMonitor } from './conversation/monitor';
import { MinaHTTPClient } from './mina/client';
import { askClaude } from './claude';
import { CONFIG, CONFIG_SOURCE } from './config';
import type { ConversationMessage, DeviceConfig } from './types';

function log(...a: unknown[]) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }

// ---------- 触发词 ----------
function extractQuestion(msg: ConversationMessage): string {
  try {
    const ans = (msg.message as any)?.response?.answer?.[0];
    return (ans?.question || ans?.intention?.query || '').trim();
  } catch { return ''; }
}

// 匹配触发规则：返回 { rest: 触发词后面的文字, skill?: 绑定的 skill }；无命中返回 null。
// 多条规则/多词命中时，取"最具体"的：触发词更长优先，同长则更靠前。
function matchTrigger(text: string): { rest: string; skill?: string } | null {
  const low = text.toLowerCase();
  let best: { idx: number; kwLen: number; rest: string; skill?: string } | null = null;
  for (const rule of CONFIG.TRIGGERS) {
    for (const kw of rule.keywords) {
      const idx = low.indexOf(kw.toLowerCase());
      if (idx < 0) continue;
      if (!best || kw.length > best.kwLen || (kw.length === best.kwLen && idx < best.idx)) {
        const rest = text.slice(idx + kw.length).replace(/^[，,。.：:、\s]+/, '').trim();
        best = { idx, kwLen: kw.length, rest, skill: rule.skill };
      }
    }
  }
  return best ? { rest: best.rest, skill: best.skill } : null;
}

// ---------- 登录 ----------
async function pickLoggedInAccount(auth: AuthService): Promise<string | null> {
  const all = await auth.getAllAuthStatus();
  const ok = all.find((a) => a.logged_in && a.is_valid);
  return ok ? ok.id : null;
}

async function doQRLogin(auth: AuthService): Promise<string> {
  const tempId = 'login_' + Date.now();
  const qr = await auth.startQRCodeLogin(tempId);
  if (!qr) throw new Error('获取小米登录二维码失败');

  log('请用「米家」或「小米」App 扫码登录：');
  console.log('  扫码链接:', qr.loginUrl);
  console.log('  二维码图片:', qr.qrcodeUrl);
  // macOS 上自动打开二维码图片，方便手机扫
  try { spawn('open', [qr.qrcodeUrl], { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }

  // 轮询扫码状态
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await auth.pollQRCode(tempId);
    if (res.state === 'confirmed') {
      const accountId = (res as any).account_id as string;
      log('登录成功，账号:', accountId);
      return accountId;
    }
    if (res.state === 'expired' || res.state === 'failed') {
      throw new Error('扫码登录失败/超时: ' + (res.message || res.state));
    }
    // waiting / scanned：继续等
  }
}

// ---------- 选设备 ----------
async function chooseDevice(config: ConfigManager, account: AccountManager, accountId: string): Promise<DeviceConfig> {
  // 已有托管设备则直接用第一台
  let managed = await account.getManagedDevices(accountId);
  if (managed.length > 0) return managed[0];

  // 从小米云拉取设备列表并持久化
  const client = account.getMinaClient(accountId) as MinaHTTPClient | null;
  if (client) {
    const apiDevices = await client.getDeviceList();
    await account.updateDeviceList(accountId, apiDevices);
  }
  const devices = await config.getDevices(accountId);
  if (devices.length === 0) throw new Error('该账号下没有发现音箱设备');

  let chosen: DeviceConfig;
  if (devices.length === 1) {
    chosen = devices[0];
    log(`只有一台设备，自动选择：${chosen.device_name}`);
  } else {
    console.log('\n发现多台设备：');
    devices.forEach((d, i) => console.log(`  [${i}] ${d.device_name}  (${d.hardware})`));
    const rl = readline.createInterface({ input, output });
    const ans = await rl.question('选择要用哪一台（输入序号）: ');
    rl.close();
    chosen = devices[Number(ans.trim()) || 0];
  }

  await account.updateDeviceConfig(accountId, chosen.device_id, { managed: true });
  managed = await account.getManagedDevices(accountId);
  return managed.find((d) => d.device_id === chosen.device_id) || chosen;
}

// ---------- 对话回调 ----------
function makeCallback(account: AccountManager) {
  return async (msg: ConversationMessage): Promise<void> => {
    const q = extractQuestion(msg);
    if (!q) return;
    log('听到:', JSON.stringify(q));
    const m = matchTrigger(q);
    if (m === null) return; // 无触发词，忽略
    const { rest: real, skill } = m;
    const client = account.getMinaClient(msg.account_id) as MinaHTTPClient | null;
    if (!client) { log('无可用客户端，跳过'); return; }

    // 普通问答但没带内容 → 反问
    if (!skill && !real) { await client.textToSpeech(msg.device_id, '你想问什么？'); return; }

    // 命中触发词：先播一句"正在思考中"——既打断小爱自己的播报，又告知正在处理
    log(skill ? `命中触发词 → skill: ${skill}，参数: ${JSON.stringify(real)}` : '命中触发词（普通问答）');
    try { await client.textToSpeech(msg.device_id, CONFIG.THINKING_PROMPT); } catch (e) { log('提示播报失败:', String(e)); }

    // 等待期间每隔 THINKING_REPEAT_MS 重复播一次提示，填补长时间静默；答案就绪后立即停。
    let waiting = true;
    let repeatTimer: ReturnType<typeof setInterval> | null = null;
    if (CONFIG.THINKING_REPEAT_MS > 0) {
      repeatTimer = setInterval(() => {
        if (!waiting) return; // 答案已到，跳过这次（避免盖在答案上面）
        client.textToSpeech(msg.device_id, CONFIG.THINKING_PROMPT).catch(() => {});
      }, CONFIG.THINKING_REPEAT_MS);
    }

    log('→ claude:', JSON.stringify(real));
    let answer: string;
    try {
      answer = await askClaude(real, skill);
    } finally {
      waiting = false;
      if (repeatTimer) clearInterval(repeatTimer);
    }
    log('← 回答:', answer);

    let ok = false;
    try {
      ok = await client.textToSpeech(msg.device_id, answer);
    } catch (e) {
      log('TTS 异常:', String(e));
    }
    log(ok ? '✓ 已下发 TTS 播放' : '✗ TTS 调用失败（ubus 返回 null/false）');
  };
}

// ---------- main ----------
async function main(): Promise<void> {
  log('小爱 → Claude Code 启动中…');
  log('配置来源:', CONFIG_SOURCE);
  log('模型:', CONFIG.CLAUDE_MODEL);
  log('触发规则:');
  for (const t of CONFIG.TRIGGERS) {
    log(`  ${t.keywords.join('/')}  →  ${t.skill ? 'skill:' + t.skill : '普通问答'}`);
  }
  const config = new ConfigManager();
  const account = new AccountManager(config);
  await account.init();
  const auth = new AuthService(config, account);

  // 恢复已保存的登录态（避免每次都扫码）
  await auth.autoLoginAll().catch((e) => log('autoLoginAll:', String(e)));

  let accountId = await pickLoggedInAccount(auth);
  if (!accountId) {
    accountId = await doQRLogin(auth);
  } else {
    log('已恢复登录，账号:', accountId);
  }

  const device = await chooseDevice(config, account, accountId);
  log(`使用音箱：${device.device_name} (${device.hardware})`);

  const monitor = new ConversationMonitor(account, config);
  // 覆盖监听器内置的轮询间隔（默认 10s），用我们 config 里的值
  (monitor as any).pollInterval = CONFIG.POLL_INTERVAL_MS;
  monitor.registerCallback('claude', makeCallback(account));
  monitor.start();

  log('就绪。对小爱说「' + CONFIG.TRIGGERS[0].keywords[0] + '，<内容>」试试。');
  log('（小爱会先自己应一句，约几秒后我再用它的声音念出 Claude 的回答）');
}

main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
