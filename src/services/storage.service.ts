import fs from 'fs';
import path from 'path';

export type WithdrawalRequestRecord = {
  requestId: string;
  amountSteth: string;
  status: 'pending' | 'ready' | 'claimed';
  txHash: string;
  createdAt: string;
  claimedAt?: string;
};

export type StrategyState = {
  lastAction?: {
    type: 'stake' | 'withdraw';
    timestamp: string;
  };
  consecutive: {
    discount: number;
    premium: number;
  };
  requests: WithdrawalRequestRecord[];
};

export class StorageService {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.resolve(process.cwd(), 'data', 'strategy-state.json');
  }

  loadState(): StrategyState {
    if (!fs.existsSync(this.filePath)) {
      return { consecutive: { discount: 0, premium: 0 }, requests: [] };
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      return { consecutive: { discount: 0, premium: 0 }, requests: [] };
    }
    const parsed = JSON.parse(raw) as StrategyState;
    if (!parsed.consecutive) {
      parsed.consecutive = { discount: 0, premium: 0 };
    }
    if (!Array.isArray(parsed.requests)) {
      parsed.requests = [];
    }
    return parsed;
  }

  saveState(state: StrategyState): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  updateState(updater: (state: StrategyState) => StrategyState): StrategyState {
    const current = this.loadState();
    const next = updater(current);
    this.saveState(next);
    return next;
  }

  addRequests(requests: { requestId: string; amountSteth: string; txHash: string }[]): void {
    if (!requests.length) {
      return;
    }
    const now = new Date().toISOString();
    this.updateState((state) => {
      const next = [...state.requests];
      for (const request of requests) {
        next.push({
          requestId: request.requestId,
          amountSteth: request.amountSteth,
          status: 'pending',
          txHash: request.txHash,
          createdAt: now
        });
      }
      return { ...state, requests: next };
    });
  }

  markRequests(requestIds: string[], status: 'ready' | 'claimed'): void {
    if (!requestIds.length) {
      return;
    }
    const now = new Date().toISOString();
    const idSet = new Set(requestIds);
    this.updateState((state) => ({
      ...state,
      requests: state.requests.map((entry) => {
        if (!idSet.has(entry.requestId)) {
          return entry;
        }
        const update: WithdrawalRequestRecord = { ...entry, status };
        if (status === 'claimed') {
          update.claimedAt = now;
        }
        return update;
      })
    }));
  }
}
