import { Contract, JsonRpcProvider } from 'ethers';

type PoolSlot0 = {
  sqrtPriceX96: bigint;
};

type PoolContract = Contract & {
  token0: () => Promise<string>;
  token1: () => Promise<string>;
  slot0: () => Promise<PoolSlot0>;
};

export class PriceService {
  private readonly pool: PoolContract;
  private readonly stethAddress: string;
  private readonly wethAddress: string;

  constructor({
    provider,
    poolAddress,
    poolAbi,
    stethAddress,
    wethAddress
  }: {
    provider: JsonRpcProvider;
    poolAddress: string;
    poolAbi: string[];
    stethAddress: string;
    wethAddress: string;
  }) {
    this.pool = new Contract(poolAddress, poolAbi, provider) as PoolContract;
    this.stethAddress = stethAddress.toLowerCase();
    this.wethAddress = wethAddress.toLowerCase();
  }

  /**
   * Returns priceRatio = price(stETH in ETH), e.g. 0.9960 means 1 stETH = 0.996 ETH.
   * Uses Uniswap V3 slot0 sqrtPriceX96 and converts to a 1e18-scaled ratio:
   *   price(token1/token0) = (sqrtPriceX96^2) / 2^192.
   * Because stETH and WETH both use 18 decimals, no extra decimal adjustment is required.
   */
  async getStethEthPriceRatio(): Promise<number> {
    const [token0, token1, slot0] = await Promise.all([
      this.pool.token0(),
      this.pool.token1(),
      this.pool.slot0()
    ]);

    const normalized0 = token0.toLowerCase();
    const normalized1 = token1.toLowerCase();
    const { sqrtPriceX96 } = slot0 as PoolSlot0;

    const priceToken1PerToken0X18 = priceFromSqrtX96X18(sqrtPriceX96);

    if (normalized0 === this.stethAddress && normalized1 === this.wethAddress) {
      return toRatio(priceToken1PerToken0X18);
    }

    if (normalized0 === this.wethAddress && normalized1 === this.stethAddress) {
      const inverted = invertRatioX18(priceToken1PerToken0X18);
      return toRatio(inverted);
    }

    throw new Error('Uniswap pool tokens do not match stETH/WETH.');
  }
}

const Q192 = 2n ** 192n;
const ONE_X18 = 1_000_000_000_000_000_000n;

function priceFromSqrtX96X18(sqrtPriceX96: bigint): bigint {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  return (squared * ONE_X18) / Q192;
}

function invertRatioX18(ratioX18: bigint): bigint {
  if (ratioX18 === 0n) {
    throw new Error('Cannot invert zero price.');
  }
  return (ONE_X18 * ONE_X18) / ratioX18;
}

function toRatio(valueX18: bigint): number {
  return Number(valueX18) / 1e18;
}
