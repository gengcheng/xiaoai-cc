// 全局 `host` 声明：各模块以全局对象方式访问宿主能力（日志、本地存储等）。
// 运行时由 shim.ts 注入到 globalThis。
declare global {
  // eslint-disable-next-line no-var
  var host: {
    log: {
      info: (...a: unknown[]) => void;
      warn: (...a: unknown[]) => void;
      error: (...a: unknown[]) => void;
      debug: (...a: unknown[]) => void;
    };
    storage: {
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string) => Promise<void>;
      delete: (key: string) => Promise<void>;
    };
    plugin: { getToken: () => Promise<string> };
    playlists: { list: () => Promise<unknown[]>; getSongs: () => Promise<unknown[]> };
    songs: { list: () => Promise<unknown[]> };
  };
}

export {};
