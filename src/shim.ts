// 宿主能力垫片 —— 注入一个全局 `host` 对象，提供日志与本地存储能力。
// 各模块以 `host.log.*` 与 `host.storage.*` 访问，这里把它们接到 console 和
// 一个本地 JSON 文件存储上。必须在任何业务模块使用前先 import 本文件。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DATA_DIR = process.env.XIAOAI_DATA_DIR || join(process.cwd(), 'data');
const STORE_FILE = join(DATA_DIR, 'store.json');

function loadStore(): Record<string, string> {
  try {
    if (existsSync(STORE_FILE)) return JSON.parse(readFileSync(STORE_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

let _store: Record<string, string> = loadStore();

function persist(): void {
  if (!existsSync(dirname(STORE_FILE))) mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(_store, null, 2), 'utf8');
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

// vendored 模块（对话轮询、mina 客户端等）的 info 日志很吵（每秒数行）。
// 默认静音；想看排查时设环境变量 XIAOAI_VERBOSE=1 或 DEBUG=1 即可全开。
// warn/error 始终打印（如 TTS 失败、ubus 报错）。应用自己的关键日志走 console.log，不受此影响。
const VERBOSE = !!process.env.XIAOAI_VERBOSE || !!process.env.DEBUG;

const host = {
  log: {
    info: (...a: unknown[]) => { if (VERBOSE) console.log(`[${ts()}]`, ...a); },
    warn: (...a: unknown[]) => console.warn(`[${ts()}] WARN`, ...a),
    error: (...a: unknown[]) => console.error(`[${ts()}] ERROR`, ...a),
    debug: (...a: unknown[]) => { if (process.env.DEBUG) console.log(`[${ts()}] DEBUG`, ...a); },
  },
  storage: {
    get: async (key: string): Promise<string | null> => (key in _store ? _store[key] : null),
    set: async (key: string, value: string): Promise<void> => { _store[key] = value; persist(); },
    delete: async (key: string): Promise<void> => { delete _store[key]; persist(); },
  },
  // 以下能力当前未使用，仅作兜底，避免偶发引用时崩溃
  plugin: { getToken: async (): Promise<string> => '' },
  playlists: { list: async () => [], getSongs: async () => [] },
  songs: { list: async () => [] },
};

// 挂到全局，供各模块以 `host.*` 直接访问
(globalThis as Record<string, unknown>).host = host;

export {};
