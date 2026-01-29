import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';

export type WithdrawalStatus = {
  requestId: bigint;
  isFinalized: boolean;
  isClaimed: boolean;
};

type TypedContract = Contract & {
  balanceOf: (address: string) => Promise<bigint>;
  allowance: (owner: string, spender: string) => Promise<bigint>;
  approve: (spender: string, amount: bigint) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
  submit: (referral: string, overrides?: { value: bigint }) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
  requestWithdrawals: ((amounts: bigint[], owner: string) => Promise<{ hash: string; wait: () => Promise<unknown> }>) & {
    staticCall?: (amounts: bigint[], owner: string) => Promise<bigint[]>;
  };
  claimWithdrawals: (requestIds: bigint[], hints?: bigint[]) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
  getWithdrawalStatus: (requestIds: bigint[]) => Promise<
    Array<{ isFinalized: boolean; isClaimed: boolean }>
  >;
};

export class LidoService {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly stethSubmit: TypedContract;
  private readonly stethToken: TypedContract;
  private readonly stethRead: TypedContract;
  private readonly withdrawalQueue: TypedContract;

  constructor({
    provider,
    wallet,
    stethAddress,
    withdrawalQueueAddress,
    stethAbi,
    erc20Abi,
    withdrawalQueueAbi
  }: {
    provider: JsonRpcProvider;
    wallet: Wallet;
    stethAddress: string;
    withdrawalQueueAddress: string;
    stethAbi: string[];
    erc20Abi: string[];
    withdrawalQueueAbi: string[];
  }) {
    this.provider = provider;
    this.wallet = wallet;
    this.stethSubmit = new Contract(stethAddress, stethAbi, wallet) as TypedContract;
    this.stethToken = new Contract(stethAddress, erc20Abi, wallet) as TypedContract;
    this.stethRead = new Contract(stethAddress, erc20Abi, provider) as TypedContract;
    this.withdrawalQueue = new Contract(
      withdrawalQueueAddress,
      withdrawalQueueAbi,
      wallet
    ) as TypedContract;
    this.assertAbi();
  }

  getAddress(): string {
    return this.wallet.address;
  }

  async getEthBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  async getStethBalance(address: string): Promise<bigint> {
    return this.stethRead.balanceOf(address);
  }

  async stakeEth(amountWei: bigint): Promise<{ txHash: string }> {
    if (amountWei <= 0n) {
      throw new Error('Stake amount must be greater than 0.');
    }
    const tx = await this.stethSubmit.submit(ethers.ZeroAddress, { value: amountWei });
    await tx.wait();
    return { txHash: tx.hash };
  }

  async requestWithdrawals(amountWei: bigint): Promise<{ txHash: string; requestIds: bigint[] }> {
    if (amountWei <= 0n) {
      throw new Error('Withdrawal amount must be greater than 0.');
    }

    const spender =
      typeof this.withdrawalQueue.target === 'string'
        ? this.withdrawalQueue.target
        : this.withdrawalQueue.target.toString();
    await this.ensureAllowance(spender, amountWei);
    const requestIds =
      typeof this.withdrawalQueue.requestWithdrawals.staticCall === 'function'
        ? await this.withdrawalQueue.requestWithdrawals.staticCall([amountWei], this.wallet.address)
        : [];
    const tx = await this.withdrawalQueue.requestWithdrawals([amountWei], this.wallet.address);
    await tx.wait();
    return { txHash: tx.hash, requestIds };
  }

  async claimWithdrawals(requestIds: bigint[]): Promise<{ txHash: string }> {
    if (!requestIds.length) {
      throw new Error('requestIds must include at least one id.');
    }
    const { fn, argCount } = resolveClaimFunction(this.withdrawalQueue);
    const tx = await fn(...buildClaimArgs(argCount, requestIds));
    await tx.wait();
    return { txHash: tx.hash };
  }

  async getWithdrawalStatuses(requestIds: bigint[]): Promise<WithdrawalStatus[]> {
    if (!requestIds.length) {
      return [];
    }
    if (!hasFunction(this.withdrawalQueue, 'getWithdrawalStatus')) {
      throw new Error('Withdrawal queue ABI missing getWithdrawalStatus.');
    }

    const statuses = await this.withdrawalQueue.getWithdrawalStatus(requestIds);
    return statuses.map((status: { isFinalized: boolean; isClaimed: boolean }, index: number) => ({
      requestId: requestIds[index] ?? 0n,
      isFinalized: Boolean(status?.isFinalized),
      isClaimed: Boolean(status?.isClaimed)
    }));
  }

  private async ensureAllowance(spender: string, amountWei: bigint): Promise<void> {
    const allowance: bigint = await this.stethToken.allowance(this.wallet.address, spender);
    if (allowance >= amountWei) {
      return;
    }
    const tx = await this.stethToken.approve(spender, amountWei);
    await tx.wait();
  }

  private assertAbi(): void {
    if (!hasFunction(this.stethSubmit, 'submit')) {
      throw new Error('stETH ABI missing submit(address).');
    }
    if (!hasFunction(this.stethToken, 'balanceOf')) {
      throw new Error('ERC20 ABI missing balanceOf.');
    }
    if (!hasFunction(this.withdrawalQueue, 'requestWithdrawals')) {
      throw new Error('Withdrawal queue ABI missing requestWithdrawals.');
    }
    if (!hasFunction(this.withdrawalQueue, 'claimWithdrawals')) {
      throw new Error('Withdrawal queue ABI missing claimWithdrawals.');
    }
  }
}

function resolveClaimFunction(queue: TypedContract): {
  fn: (requestIds: bigint[], hints?: bigint[]) => Promise<any>;
  argCount: number;
} {
  if (!hasFunction(queue, 'claimWithdrawals')) {
    throw new Error('Withdrawal queue ABI missing claimWithdrawals.');
  }
  const fragment = queue.interface.getFunction('claimWithdrawals');
  const argCount = fragment?.inputs?.length ?? 1;
  return { fn: queue.claimWithdrawals.bind(queue), argCount };
}

function buildClaimArgs(argCount: number, requestIds: bigint[]): [bigint[], bigint[]?] {
  if (argCount >= 2) {
    return [requestIds, []];
  }
  return [requestIds];
}

function hasFunction(queue: TypedContract, name: string): boolean {
  try {
    queue.interface.getFunction(name);
    return true;
  } catch {
    return false;
  }
}
