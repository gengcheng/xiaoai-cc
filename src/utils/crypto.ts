// 加密工具 —— 独立版（基于 node:crypto，替代原 QuickJS 全局 crypto）
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

/** MD5 哈希，小写 hex（用于小米登录密码加密） */
export function md5(str: string): string {
  return createHash('md5').update(str, 'utf8').digest('hex');
}

/** 生成随机设备 ID：16 字节随机 hex（32 字符） */
export function generateDeviceId(): string {
  return nodeRandomBytes(16).toString('hex');
}

/** 随机字节的 hex 字符串 */
export function randomHex(size: number): string {
  return nodeRandomBytes(size).toString('hex');
}

/** 随机字节的 base64 字符串 */
export function randomBase64(size: number): string {
  return nodeRandomBytes(size).toString('base64');
}

/** AES-CBC 加密（当前登录流程未用到，保留签名以兼容） */
export function aesEncryptCBC(_data: string, _key: string, _iv: string): string {
  throw new Error('aesEncryptCBC not implemented in standalone build (unused)');
}

/** 生成简单唯一 ID */
export function generateId(prefix?: string): string {
  const timestamp = Date.now().toString();
  const random = nodeRandomBytes(4).toString('hex');
  return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
}
