import { ethers } from 'ethers';

import { BotConfig } from '../config';
import { LidoService } from '../services/lido.service';
import { PriceService } from '../services/price.service';
import { StorageService } from '../services/storage.service';

type ActionDecision =
  | { action: 'stake'; reason: string }
  | { action: 'withdraw'; reason: string }
  | { action: 'none'; reason: string };

export class StrategyRunner {
  private readonly config: BotConfig;
  private readonly lido: LidoService;
  private readonly prices: PriceService;
  private readonly storage: StorageService;
  private readonly loopMs: number;
  private readonly cooldownMs: number;
  private readonly minHoldMs: number;

  constructor({
    config,
    lido,
    prices,
    storage
  }: {
    config: BotConfig;
    lido: LidoService;
    prices: PriceService;
    storage: StorageService;
  }) {
    this.config = config;
    this.lido = lido;
    this.prices = prices;
    this.storage = storage;
    this.loopMs = Math.max(1000, config.loopSeconds * 1000);
    this.cooldownMs = Math.max(0, config.cooldownMinutes * 60 * 1000);
    this.minHoldMs = Math.max(0, config.minHoldHours * 60 * 60 * 1000);
  }

  async start(): Promise<void> {
    let backoffMs = 5000;
    const maxBackoffMs = 5 * 60 * 1000;

    while (true) {
      try {
        await this.runOnce();
        backoffMs = 5000;
        await sleep(this.loopMs);
      } catch (error) {
        logEvent('loop_error', {
          error: formatError(error)
        });
        await sleep(backoffMs);
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      }
    }
  }

  private async runOnce(): Promise<void> {
    const priceRatio = await this.prices.getStethEthPriceRatio();
    const discountPct = (1 - priceRatio) * 100;
    const premiumPct = (priceRatio - 1) * 100;

    const [ethBalance, stethBalance] = await Promise.all([
      this.lido.getEthBalance(),
      this.lido.getStethBalance(this.lido.getAddress())
    ]);

    const state = this.storage.loadState();
    const nowIso = new Date().toISOString();
    const updatedState = this.updateConsecutive(state, discountPct, premiumPct, nowIso);
    this.storage.saveState(updatedState);

    logEvent('tick', {
      priceRatio,
      discountPct,
      premiumPct,
      ethBalance: ethers.formatEther(ethBalance),
      stethBalance: ethers.formatEther(stethBalance)
    });

    await this.claimReadyWithdrawals(updatedState);

    const decision = this.decideAction(updatedState, discountPct, premiumPct);
    if (decision.action === 'none') {
      logEvent('decision', { action: decision.action, reason: decision.reason });
      return;
    }

    if (decision.action === 'stake') {
      await this.stakeAll(ethBalance, priceRatio, decision.reason);
      return;
    }

    await this.withdrawAll(stethBalance, priceRatio, decision.reason);
  }

  private updateConsecutive(
    state: ReturnType<StorageService['loadState']>,
    discountPct: number,
    premiumPct: number,
    lastTick: string
  ) {
    const threshold = this.config.thresholdPct;
    const discount = discountPct > threshold ? state.consecutive.discount + 1 : 0;
    const premium = premiumPct > threshold ? state.consecutive.premium + 1 : 0;
    return { ...state, lastTick, consecutive: { discount, premium } };
  }

  private decideAction(
    state: ReturnType<StorageService['loadState']>,
    discountPct: number,
    premiumPct: number
  ): ActionDecision {
    const threshold = this.config.thresholdPct;
    const now = Date.now();
    const lastAction = state.lastAction;
    const inCooldown =
      lastAction && now - Date.parse(lastAction.timestamp) < this.cooldownMs;

    if (inCooldown) {
      return { action: 'none', reason: 'cooldown_active' };
    }

    if (discountPct > threshold) {
      if (lastAction?.type === 'withdraw') {
        if (!this.canFlipAction(lastAction, state.consecutive.discount, now)) {
          return { action: 'none', reason: 'stake_waiting_confirmation' };
        }
      }
      return { action: 'stake', reason: 'discount_threshold' };
    }

    if (premiumPct > threshold) {
      if (lastAction?.type === 'stake') {
        if (!this.canFlipAction(lastAction, state.consecutive.premium, now)) {
          return { action: 'none', reason: 'withdraw_waiting_confirmation' };
        }
      }
      return { action: 'withdraw', reason: 'premium_threshold' };
    }

    return { action: 'none', reason: 'no_signal' };
  }

  private canFlipAction(
    lastAction: { type: 'stake' | 'withdraw'; timestamp: string },
    confirmations: number,
    now: number
  ): boolean {
    const elapsed = now - Date.parse(lastAction.timestamp);
    const holdSatisfied = elapsed >= this.minHoldMs;
    const confirmationsSatisfied = confirmations >= this.config.confirmationChecks;
    return holdSatisfied || confirmationsSatisfied;
  }

  private async stakeAll(
    ethBalance: bigint,
    priceRatio: number,
    reason: string
  ): Promise<void> {
    const minTradeWei = ethers.parseEther(this.config.minTradeEth);
    const safetyBufferWei = ethers.parseEther(this.config.safetyBufferEth);
    const spendable = ethBalance > safetyBufferWei ? ethBalance - safetyBufferWei : 0n;

    if (spendable < minTradeWei) {
      logEvent('stake_skipped', {
        reason: 'min_trade_not_met',
        spendableEth: ethers.formatEther(spendable)
      });
      return;
    }

    const result = await this.lido.stakeEth(spendable);
    logEvent('stake_sent', {
      reason,
      txHash: result.txHash,
      amountEth: ethers.formatEther(spendable),
      priceRatio
    });

    this.storage.updateState((state) => ({
      ...state,
      lastAction: { type: 'stake', timestamp: new Date().toISOString() }
    }));
  }

  private async withdrawAll(
    stethBalance: bigint,
    priceRatio: number,
    reason: string
  ): Promise<void> {
    const minTradeWei = ethers.parseEther(this.config.minTradeSteth);
    if (stethBalance < minTradeWei) {
      logEvent('withdraw_skipped', {
        reason: 'min_trade_not_met',
        stethBalance: ethers.formatEther(stethBalance)
      });
      return;
    }

    const result = await this.lido.requestWithdrawals(stethBalance);
    const requestIds = result.requestIds.map((id) => id.toString());
    this.storage.addRequests(
      requestIds.map((id) => ({
        requestId: id,
        amountSteth: ethers.formatEther(stethBalance),
        txHash: result.txHash
      }))
    );

    logEvent('withdraw_requested', {
      reason,
      txHash: result.txHash,
      requestIds,
      amountSteth: ethers.formatEther(stethBalance),
      priceRatio
    });

    this.storage.updateState((state) => ({
      ...state,
      lastAction: { type: 'withdraw', timestamp: new Date().toISOString() }
    }));
  }

  private async claimReadyWithdrawals(state: ReturnType<StorageService['loadState']>): Promise<void> {
    const pending = state.requests.filter((req) => req.status === 'pending' || req.status === 'ready');
    if (!pending.length) {
      return;
    }

    const requestIds = pending.map((req) => BigInt(req.requestId));
    const statuses = await this.lido.getWithdrawalStatuses(requestIds);

    const readyIds = statuses
      .filter((status) => status.isFinalized && !status.isClaimed)
      .map((status) => status.requestId.toString());

    const claimedIds = statuses
      .filter((status) => status.isClaimed)
      .map((status) => status.requestId.toString());

    if (claimedIds.length) {
      this.storage.markRequests(claimedIds, 'claimed');
    }

    if (!readyIds.length) {
      if (claimedIds.length) {
        logEvent('withdrawal_status', { readyIds, claimedIds });
      }
      return;
    }

    this.storage.markRequests(readyIds, 'ready');

    const claimResult = await this.lido.claimWithdrawals(readyIds.map((id) => BigInt(id)));
    this.storage.markRequests(readyIds, 'claimed');

    logEvent('withdraw_claimed', {
      txHash: claimResult.txHash,
      requestIds: readyIds
    });
  }
}

function logEvent(event: string, data: Record<string, unknown>): void {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...data
  };
  console.log(JSON.stringify(payload));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
