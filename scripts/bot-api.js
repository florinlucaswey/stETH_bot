const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { LidoService } = require('../src/services/lido-service');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const WITHDRAWALS_PATH = path.join(DATA_DIR, 'withdrawals.json');
const PRICE_HISTORY_PATH = path.join(DATA_DIR, 'price-history.json');
const STRATEGY_STATE_PATH = path.join(DATA_DIR, 'strategy-state.json');
const ABI_DIR = path.resolve(process.cwd(), 'src', 'abi');
const CONFIG_PATH = path.resolve(process.cwd(), 'src', 'config', 'lido.json');
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const Q192 = 2n ** 192n;
const ONE_X18 = 1_000_000_000_000_000_000n;

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const cleaned = raw.replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    return fallback;
  }

  return JSON.parse(cleaned);
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadAbiFile(fileName) {
  const filePath = path.join(ABI_DIR, fileName);
  const abi = readJsonFile(filePath, null);
  if (!Array.isArray(abi)) {
    throw new Error(`ABI ${fileName} must be a JSON array.`);
  }
  return abi;
}

function loadLidoConfig() {
  const config = readJsonFile(CONFIG_PATH, null);
  if (!config || typeof config !== 'object') {
    throw new Error('Lido config file is missing or invalid.');
  }
  return config;
}

function loadWithdrawals() {
  ensureDataDir();
  const data = readJsonFile(WITHDRAWALS_PATH, { requests: [] });
  if (!data || !Array.isArray(data.requests)) {
    return { requests: [] };
  }
  return data;
}

function saveWithdrawals(data) {
  ensureDataDir();
  writeJsonFile(WITHDRAWALS_PATH, data);
}

function loadPriceHistory() {
  ensureDataDir();
  const data = readJsonFile(PRICE_HISTORY_PATH, { points: [] });
  if (!data || !Array.isArray(data.points)) {
    return { points: [] };
  }
  return data;
}

function savePriceHistory(data) {
  ensureDataDir();
  writeJsonFile(PRICE_HISTORY_PATH, data);
}

function loadStrategyState() {
  ensureDataDir();
  const state = readJsonFile(STRATEGY_STATE_PATH, null);
  if (!state || typeof state !== 'object') {
    return {};
  }
  return state;
}

function normalizeAmount(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label} must be a string or number.`);
  }
  const normalized = value.toString().trim();
  if (!normalized) {
    throw new Error(`${label} must be greater than 0.`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
  return normalized;
}

function getBotSettings() {
  const cooldownMinutes = Number(process.env.COOLDOWN_MINUTES ?? '60');
  const minHoldHours = Number(process.env.MIN_HOLD_HOURS ?? '24');
  return {
    cooldownMinutes: Number.isFinite(cooldownMinutes) ? cooldownMinutes : 60,
    minHoldHours: Number.isFinite(minHoldHours) ? minHoldHours : 24,
    minTradeEth: process.env.MIN_TRADE_ETH ?? '0.01',
    minTradeSteth: process.env.MIN_TRADE_STETH ?? '0.01',
    loopSeconds: Number(process.env.LOOP_SECONDS ?? '60')
  };
}

function appendPriceHistory(point) {
  const history = loadPriceHistory();
  history.points.push(point);
  const maxPoints = Number(process.env.PRICE_HISTORY_LIMIT ?? '2000');
  if (Number.isFinite(maxPoints) && maxPoints > 0 && history.points.length > maxPoints) {
    history.points = history.points.slice(history.points.length - maxPoints);
  }
  savePriceHistory(history);
}

async function getStethEthPrice(pool, stethAddress) {
  const [token0, token1, slot0] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.slot0()
  ]);

  const sqrtPriceX96 = slot0.sqrtPriceX96 ?? slot0[0];
  const priceToken1PerToken0X18 = (sqrtPriceX96 * sqrtPriceX96 * ONE_X18) / Q192;

  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();
  const stethLower = stethAddress.toLowerCase();
  const wethLower = WETH_ADDRESS.toLowerCase();

  let priceRatioX18;
  if (token0Lower === stethLower && token1Lower === wethLower) {
    priceRatioX18 = priceToken1PerToken0X18;
  } else if (token0Lower === wethLower && token1Lower === stethLower) {
    priceRatioX18 = (ONE_X18 * ONE_X18) / priceToken1PerToken0X18;
  } else {
    throw new Error('Pool tokens do not match stETH/WETH.');
  }

  const priceRatio = Number(priceRatioX18) / 1e18;
  return {
    priceRatio,
    discountPct: (1 - priceRatio) * 100,
    premiumPct: (priceRatio - 1) * 100
  };
}

async function refreshWithdrawalStatuses(lido, store) {
  if (!store.requests.length) {
    return store;
  }

  const requestIds = store.requests.map((entry) => BigInt(entry.requestId));
  const statuses = await lido.getWithdrawalStatuses(requestIds);
  const statusMap = new Map(
    statuses.map((status) => [status.requestId.toString(), status])
  );

  let changed = false;
  store.requests = store.requests.map((entry) => {
    const status = statusMap.get(entry.requestId);
    if (!status) {
      return entry;
    }
    const nextStatus = status.isClaimed
      ? 'claimed'
      : status.isFinalized
        ? 'ready'
        : 'pending';
    if (entry.status !== nextStatus) {
      changed = true;
    }
    return { ...entry, status: nextStatus };
  });

  if (changed) {
    saveWithdrawals(store);
  }

  return store;
}

function summarizeWithdrawals(store) {
  const pending = [];
  const ready = [];

  for (const entry of store.requests) {
    if (entry.status === 'ready') {
      ready.push(entry);
    } else if (entry.status !== 'claimed') {
      pending.push(entry);
    }
  }

  return { pending, ready };
}

async function main() {
  loadEnv(path.resolve(process.cwd(), '.env'));

  const rpcUrl = process.env.RPC_URL;
  const botPrivateKey = process.env.BOT_PRIVATE_KEY;
  if (!rpcUrl) {
    throw new Error('RPC_URL must be set in .env');
  }
  if (!botPrivateKey) {
    throw new Error('BOT_PRIVATE_KEY must be set in .env');
  }

  const normalizedKey = botPrivateKey.startsWith('0x')
    ? botPrivateKey
    : `0x${botPrivateKey}`;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(normalizedKey, provider);

  const config = loadLidoConfig();
  const stethAbi = loadAbiFile('steth.json');
  const erc20Abi = loadAbiFile('erc20.json');
  const withdrawalQueueAbi = loadAbiFile('withdrawal-queue.json');
  const poolAbi = loadAbiFile('uniswap-v3-pool.json');
  const lido = new LidoService({
    provider,
    wallet,
    stethAddress: config.stethAddress,
    withdrawalQueueAddress: config.withdrawalQueueAddress,
    stethAbi,
    erc20Abi,
    withdrawalQueueAbi
  });
  const pool = new ethers.Contract(config.stethWethPoolAddress, poolAbi, provider);

  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN ?? '*';

  app.use(express.json());
  app.use(
    cors({
      origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((v) => v.trim())
    })
  );

  app.get('/api/status', async (_req, res) => {
    try {
      const [ethBalance, stethBalance] = await Promise.all([
        lido.getEthBalance(),
        lido.getStethBalance(lido.getAddress())
      ]);

      const store = await refreshWithdrawalStatuses(lido, loadWithdrawals());
      const { pending, ready } = summarizeWithdrawals(store);
      const strategyState = loadStrategyState();

      res.json({
        botAddress: lido.getAddress(),
        ethBalance: ethers.formatEther(ethBalance),
        stethBalance: ethers.formatEther(stethBalance),
        pendingWithdrawals: pending,
        readyToClaim: ready,
        config: getBotSettings(),
        serverTime: new Date().toISOString(),
        lastTick: strategyState.lastTick ?? null,
        lastAction: strategyState.lastAction ?? null
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/price/steth-eth', async (_req, res) => {
    try {
      const timestamp = new Date().toISOString();
      const price = await getStethEthPrice(pool, config.stethAddress);
      const response = { ...price, timestamp };
      appendPriceHistory(response);
      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/price/steth-eth/history', (_req, res) => {
    try {
      const history = loadPriceHistory();
      res.json(history.points);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/lido/stake', async (req, res) => {
    try {
      const amountEth = normalizeAmount(req.body?.amountEth, 'amountEth');
      const amountWei = ethers.parseEther(amountEth);
      const result = await lido.stakeEth(amountWei);
      res.json({ txHash: result.txHash });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/lido/withdraw/request', async (req, res) => {
    try {
      const amountSteth = normalizeAmount(req.body?.amountSteth, 'amountSteth');
      const amountWei = ethers.parseEther(amountSteth);
      const result = await lido.requestWithdrawals(amountWei);
      const store = loadWithdrawals();
      const now = new Date().toISOString();
      for (const requestId of result.requestIds) {
        store.requests.push({
          requestId: requestId.toString(),
          amountSteth,
          status: 'pending',
          txHash: result.txHash,
          createdAt: now
        });
      }
      saveWithdrawals(store);
      res.json({
        txHash: result.txHash,
        requestIds: result.requestIds.map((value) => value.toString())
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/lido/withdraw/claim', async (req, res) => {
    try {
      const requestIds = Array.isArray(req.body?.requestIds) ? req.body.requestIds : [];
      const requestIdsBigint = requestIds.map((value) => BigInt(value));
      const result = await lido.claimWithdrawals(requestIdsBigint);

      const store = loadWithdrawals();
      const normalized = new Set(requestIds.map((value) => value.toString()));
      store.requests = store.requests.map((entry) => {
        if (normalized.has(entry.requestId)) {
          return { ...entry, status: 'claimed', claimedAt: new Date().toISOString() };
        }
        return entry;
      });
      saveWithdrawals(store);
      res.json({ txHash: result.txHash });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  const port = Number(process.env.API_PORT ?? '3001');
  app.listen(port, () => {
    console.log(`Bot API listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error('Bot API failed to start.');
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
