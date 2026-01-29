import path from 'path';
import { ethers } from 'ethers';
import fs from 'fs';

import { loadConfig, loadEnv } from './config';
import { LidoService } from './services/lido.service';
import { PriceService } from './services/price.service';
import { StorageService } from './services/storage.service';
import { StrategyRunner } from './strategy/runner';

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function loadAbi(name: string): string[] {
  const filePath = path.resolve(process.cwd(), 'src', 'abi', name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ABI file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const cleaned = raw.replace(/^\uFEFF/, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`ABI file is empty: ${filePath}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  loadEnv(path.resolve(process.cwd(), '.env'));
  const config = loadConfig();

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const privateKey = config.privateKey.startsWith('0x')
    ? config.privateKey
    : `0x${config.privateKey}`;
  const wallet = new ethers.Wallet(privateKey, provider);

  const stethAbi = loadAbi('steth.json');
  const erc20Abi = loadAbi('erc20.json');
  const withdrawalQueueAbi = loadAbi('withdrawal-queue.json');
  const poolAbi = loadAbi('uniswap-v3-pool.json');

  const lido = new LidoService({
    provider,
    wallet,
    stethAddress: config.addresses.stethAddress,
    withdrawalQueueAddress: config.addresses.withdrawalQueueAddress,
    stethAbi,
    erc20Abi,
    withdrawalQueueAbi
  });

  const priceService = new PriceService({
    provider,
    poolAddress: config.addresses.stethWethPoolAddress,
    poolAbi,
    stethAddress: config.addresses.stethAddress,
    wethAddress: WETH_ADDRESS
  });

  const storage = new StorageService();

  const runner = new StrategyRunner({
    config,
    lido,
    prices: priceService,
    storage
  });

  await runner.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
