/** 安全的 localStorage 包裝：私密模式或被封鎖時不會丟錯 */
export function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 忽略：偏好設定僅為便利功能 */
  }
}

export function loadList(key: string, fallback: number[]): number[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? 'null') as unknown;
    return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : fallback;
  } catch {
    return fallback;
  }
}
