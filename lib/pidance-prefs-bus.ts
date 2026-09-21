/**
 * 偏好变更的进程内广播（#66）。
 *
 * 用途：同一后端下的多客户端要**亚秒级**看到彼此对偏好的改动。范围明确限定在
 * 「同一个后端进程」——不做跨进程广播，所以不需要 `fs.watch`（写文件的人就是本进程，
 * 它自己知道变了什么）。跨进程/手工编辑文件仍靠下一次 GET。
 *
 * 载荷只带**本次实际变更的键与值**（不是整份偏好），客户端按字段应用即可。
 *
 * revision 是进程内单调计数器，用于客户端对账（只认比自己见过的更新的版本）；
 * `bootId` 每次进程启动随机生成 —— 后端重启后 revision 会从头开始，客户端凭它识别
 * 「换纪元了，需要先全量拉一次」，避免因为版本号回退而忽略后续广播。
 */

export interface PidancePrefsChange {
  /** 本次实际变更的键（顶层键或点路径）。 */
  changed: Record<string, unknown>;
  revision: number;
  bootId: string;
  at: string;
}

export type PidancePrefsListener = (change: PidancePrefsChange) => void;

export interface PidancePrefsBus {
  /** 当前 revision（进程内单调）。 */
  revision(): number;
  /** 本次进程启动的标识。 */
  bootId(): string;
  /** 订阅变更；返回退订函数。 */
  subscribe(listener: PidancePrefsListener): () => void;
  /** 发布一次变更；revision 自增，并把 (bootId, revision) 一起发出去。 */
  publish(changed: Record<string, unknown>): PidancePrefsChange;
  /** 测试用：重置计数器与订阅者。 */
  resetForTests(): void;
}

export function createPidancePrefsBus(): PidancePrefsBus {
  let revision = 0;
  const bootId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const listeners = new Set<PidancePrefsListener>();
  return {
    revision: () => revision,
    bootId: () => bootId,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(changed) {
      revision += 1;
      const change: PidancePrefsChange = { changed, revision, bootId, at: new Date().toISOString() };
      for (const listener of listeners) {
        try {
          listener(change);
        } catch {
          // 单个订阅者出错不影响其它订阅者
        }
      }
      return change;
    },
    resetForTests() {
      revision = 0;
      listeners.clear();
    },
  };
}

/** 进程级单例（Next 的 route 模块之间共享同一份）。 */
export function getPidancePrefsBus(): PidancePrefsBus {
  const holder = globalThis as { __piPrefsBus?: PidancePrefsBus };
  if (!holder.__piPrefsBus) holder.__piPrefsBus = createPidancePrefsBus();
  return holder.__piPrefsBus;
}
