import fs from 'fs';
import path from 'path';

export type AddressConfig = {
  stethAddress: string;
  withdrawalQueueAddress: string;
  stethWethPoolAddress: string;
};

export type BotConfig = {
  rpcUrl: string;
  privateKey: string;
  thresholdPct: number;
  safetyBufferEth: string;
  minTradeEth: string;
  minTradeSteth: string;
  loopSeconds: number;
  cooldownMinutes: number;
  confirmationChecks: number;
  minHoldHours: number;
  addresses: AddressConfig;
};

const CONFIG_PATH = path.resolve(process.cwd(), 'src', 'config', 'lido.json');

export function loadEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(): BotConfig {
  const rpcUrl = requiredEnv('RPC_URL');
  const privateKey = requiredEnv('BOT_PRIVATE_KEY');

  const thresholdPct = parseNumberEnv('THRESHOLD_PCT', 0.4);
  const safetyBufferEth = process.env.SAFETY_BUFFER_ETH ?? '0.02';
  const minTradeEth = process.env.MIN_TRADE_ETH ?? '0.01';
  const minTradeSteth = process.env.MIN_TRADE_STETH ?? '0.01';
  const loopSeconds = parseNumberEnv('LOOP_SECONDS', 60);
  const cooldownMinutes = parseNumberEnv('COOLDOWN_MINUTES', 60);
  const confirmationChecks = parseNumberEnv('CONFIRMATION_CHECKS', 3);
  const minHoldHours = parseNumberEnv('MIN_HOLD_HOURS', 1);

  const addresses = loadAddressConfig();

  return {
    rpcUrl,
    privateKey,
    thresholdPct,
    safetyBufferEth,
    minTradeEth,
    minTradeSteth,
    loopSeconds,
    cooldownMinutes,
    confirmationChecks,
    minHoldHours,
    addresses
  };
}

function loadAddressConfig(): AddressConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw) as Partial<AddressConfig>;

  if (!config.stethAddress) {
    throw new Error('stethAddress missing in src/config/lido.json');
  }
  if (!config.withdrawalQueueAddress) {
    throw new Error('withdrawalQueueAddress missing in src/config/lido.json');
  }
  if (!config.stethWethPoolAddress) {
    throw new Error('stethWethPoolAddress missing in src/config/lido.json');
  }

  return {
    stethAddress: config.stethAddress,
    withdrawalQueueAddress: config.withdrawalQueueAddress,
    stethWethPoolAddress: config.stethWethPoolAddress
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} must be set in .env`);
  }
  return value;
}

function parseNumberEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number`);
  }
  return parsed;
}
