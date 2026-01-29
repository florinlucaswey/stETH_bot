const fs = require('fs');
const path = require('path');
const BlocknativeSdk = require('bnc-sdk');
const { ethers } = require('ethers');
const WebSocket = require('ws');

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const STETH_ADDRESS = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const Q192 = 2n ** 192n;
const SLIPPAGE_BPS_SCALE = 10000n;
const ERC20_DECIMALS = 18;
const DEFAULT_MAX_GAS = 500000;
const MAX_HISTORY_ENTRIES = 500;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];

const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
];

const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)'
];

const UNISWAP_V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

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

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function normalizePrivateKey(rawKey) {
  return rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
}

function getEnvNumber(key, fallback) {
  const value = process.env[key] ?? fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${key} value: ${value}`);
  }
  return parsed;
}

function getEnvString(key, fallback) {
  return process.env[key] ?? fallback;
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
  if (!raw.trim()) {
    return fallback;
  }

  return JSON.parse(raw);
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeDecimal(value, label) {
  if (typeof value === 'number') {
    value = value.toString();
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a string or number.`);
  }
  ethers.parseUnits(value, ERC20_DECIMALS);
  return value;
}

function normalizeInt(value, label) {
  if (typeof value === 'string') {
    value = Number(value);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  const numeric = Math.trunc(value);
  if (numeric < 0) {
    throw new Error(`${label} must be >= 0.`);
  }
  return numeric;
}

function getDefaultConfig() {
  return {
    buyBelowWeth: getEnvString('BUY_BELOW_WETH', '0.995'),
    sellAboveWeth: getEnvString('SELL_ABOVE_WETH', '1.005'),
    maxTradeSizeEth: getEnvString('MAX_TRADE_SIZE_ETH', '0.01'),
    minEthForGas: getEnvString('MIN_ETH_FOR_GAS', '0.005'),
    maxTradesPerDay: getEnvNumber('MAX_TRADES_PER_DAY', '5'),
    slippageBps: getEnvNumber('SLIPPAGE_BPS', '50'),
    loopIntervalMs: getEnvNumber('LOOP_INTERVAL_MS', '60000'),
    maxGas: getEnvNumber('MAX_GAS', DEFAULT_MAX_GAS.toString()),
    uniswapV3Fee: getEnvNumber('UNISWAP_V3_FEE', '500')
  };
}

function validateConfig(config) {
  const validated = {
    buyBelowWeth: normalizeDecimal(config.buyBelowWeth, 'buyBelowWeth'),
    sellAboveWeth: normalizeDecimal(config.sellAboveWeth, 'sellAboveWeth'),
    maxTradeSizeEth: normalizeDecimal(config.maxTradeSizeEth, 'maxTradeSizeEth'),
    minEthForGas: normalizeDecimal(config.minEthForGas, 'minEthForGas'),
    maxTradesPerDay: normalizeInt(config.maxTradesPerDay, 'maxTradesPerDay'),
    slippageBps: normalizeInt(config.slippageBps, 'slippageBps'),
    loopIntervalMs: normalizeInt(config.loopIntervalMs, 'loopIntervalMs'),
    maxGas: normalizeInt(config.maxGas, 'maxGas'),
    uniswapV3Fee: normalizeInt(config.uniswapV3Fee, 'uniswapV3Fee')
  };

  if (validated.slippageBps > 10000) {
    throw new Error('slippageBps must be <= 10000.');
  }
  if (validated.loopIntervalMs < 1000) {
    throw new Error('loopIntervalMs must be >= 1000.');
  }
  const buyThreshold = ethers.parseUnits(validated.buyBelowWeth, ERC20_DECIMALS);
  const sellThreshold = ethers.parseUnits(validated.sellAboveWeth, ERC20_DECIMALS);
  if (buyThreshold >= sellThreshold) {
    throw new Error('buyBelowWeth must be less than sellAboveWeth.');
  }

  return validated;
}

function loadConfig() {
  ensureDataDir();
  const rawConfig = readJsonFile(CONFIG_PATH, {});
  const merged = { ...getDefaultConfig(), ...rawConfig };
  const validated = validateConfig(merged);
  if (JSON.stringify(rawConfig) !== JSON.stringify(validated)) {
    writeJsonFile(CONFIG_PATH, validated);
  }
  return validated;
}

function loadHistory() {
  ensureDataDir();
  const history = readJsonFile(HISTORY_PATH, []);
  return Array.isArray(history) ? history : [];
}

function appendHistory(entry) {
  const history = loadHistory();
  history.push(entry);
  const trimmed =
    history.length > MAX_HISTORY_ENTRIES
      ? history.slice(-MAX_HISTORY_ENTRIES)
      : history;
  writeJsonFile(HISTORY_PATH, trimmed);
}

function getBlocknativeNetwork(chainId) {
  switch (chainId) {
    case 1n:
      return 'main';
    case 11155111n:
      return 'sepolia';
    case 100n:
      return 'xdai';
    case 137n:
      return 'matic-main';
    case 80002n:
      return 'matic-amoy';
    default:
      throw new Error(
        `Unsupported chainId ${chainId.toString()} for Blocknative simulation.`
      );
  }
}

function toSafeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function parseDelta(delta, decimals) {
  const trimmed = delta.trim();
  const isNegative = trimmed.startsWith('-');
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;
  const amount = unsigned.includes('.')
    ? ethers.parseUnits(unsigned, decimals)
    : BigInt(unsigned);
  return isNegative ? -amount : amount;
}

function getTokenOutDelta(simResult, address, tokenAddress, decimals) {
  const netBalanceChanges = simResult.netBalanceChanges;
  if (!Array.isArray(netBalanceChanges)) {
    return null;
  }

  const normalizedAddress = address.toLowerCase();
  const normalizedToken = tokenAddress.toLowerCase();

  for (const entry of netBalanceChanges) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const maybeAddress = entry.address;
    const balanceChanges = entry.balanceChanges;
    if (typeof maybeAddress !== 'string' || !Array.isArray(balanceChanges)) {
      continue;
    }

    if (maybeAddress.toLowerCase() !== normalizedAddress) {
      continue;
    }

    for (const change of balanceChanges) {
      if (!change || typeof change !== 'object') {
        continue;
      }

      const asset = change.asset;
      const delta = change.delta;
      if (typeof delta !== 'string' || !asset || typeof asset !== 'object') {
        continue;
      }

      const contractAddress = asset.contractAddress;
      if (typeof contractAddress !== 'string') {
        continue;
      }

      if (contractAddress.toLowerCase() !== normalizedToken) {
        continue;
      }

      return parseDelta(delta, decimals);
    }
  }

  return null;
}

function hasSimulationError(simResult) {
  if (simResult.status && simResult.status !== 'simulated') {
    return true;
  }

  if (simResult.error) {
    return true;
  }

  if (Array.isArray(simResult.internalTransactions)) {
    return simResult.internalTransactions.some(
      (tx) => Boolean(tx.error) || Boolean(tx.errorReason)
    );
  }

  return false;
}

async function ensureApproval(token, owner, spender, amount, label) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    log(`${label} allowance OK: ${ethers.formatEther(allowance)}`);
    return;
  }

  log(`${label} approving ${ethers.formatEther(amount)}...`);
  const approveTx = await token.approve(spender, amount);
  log(`${label} approve tx: ${approveTx.hash}`);
  await approveTx.wait();
}

async function getPoolInfo(provider, fee) {
  const factory = new ethers.Contract(
    UNISWAP_V3_FACTORY,
    UNISWAP_V3_FACTORY_ABI,
    provider
  );
  const poolAddress = await factory.getPool(WETH_ADDRESS, STETH_ADDRESS, fee);
  if (!poolAddress || poolAddress === ethers.ZeroAddress) {
    throw new Error(`No Uniswap v3 pool found for fee ${fee}.`);
  }

  const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
  const [token0, token1, slot0] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.slot0()
  ]);

  return {
    poolAddress,
    token0,
    token1,
    sqrtPriceX96: BigInt(slot0[0].toString())
  };
}

function getPriceStethInWethScaled(sqrtPriceX96, token0, token1) {
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const scale = 10n ** 18n;
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();

  if (
    token0Lower === STETH_ADDRESS.toLowerCase() &&
    token1Lower === WETH_ADDRESS.toLowerCase()
  ) {
    return (numerator * scale) / Q192;
  }

  if (
    token0Lower === WETH_ADDRESS.toLowerCase() &&
    token1Lower === STETH_ADDRESS.toLowerCase()
  ) {
    return (Q192 * scale) / numerator;
  }

  throw new Error('Unexpected pool tokens for stETH/WETH.');
}

function computeExpectedOut(amountIn, tokenIn, tokenOut, sqrtPriceX96, token0, token1) {
  const numerator = sqrtPriceX96 * sqrtPriceX96;
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();

  if (inLower === token0Lower && outLower === token1Lower) {
    return (amountIn * numerator) / Q192;
  }

  if (inLower === token1Lower && outLower === token0Lower) {
    return (amountIn * Q192) / numerator;
  }

  throw new Error('Unexpected token order for expected out calculation.');
}

async function simulateSwap({
  apiKey,
  chainId,
  provider,
  from,
  router,
  params,
  amountOutMinimum,
  tokenOut,
  maxGas
}) {
  const routerAddress = await router.getAddress();
  const txRequest = await router.populateTransaction.exactInputSingle(params);
  if (!txRequest.data) {
    throw new Error('Failed to build swap calldata for simulation.');
  }

  const gasEstimate = await provider.estimateGas({
    to: routerAddress,
    from,
    data: txRequest.data,
    value: 0n
  });
  const gasLimit = (gasEstimate * 12n) / 10n;
  const feeData = await provider.getFeeData();

  const simulationTx = {
    from,
    to: routerAddress,
    value: 0,
    gas: toSafeNumber(gasLimit, 'gas limit'),
    input: txRequest.data
  };

  if (feeData.gasPrice) {
    simulationTx.gasPrice = toSafeNumber(feeData.gasPrice, 'gas price');
  } else {
    if (feeData.maxFeePerGas) {
      simulationTx.maxFeePerGas = toSafeNumber(
        feeData.maxFeePerGas,
        'maxFeePerGas'
      );
    }
    if (feeData.maxPriorityFeePerGas) {
      simulationTx.maxPriorityFeePerGas = toSafeNumber(
        feeData.maxPriorityFeePerGas,
        'maxPriorityFeePerGas'
      );
    }
  }

  const network = getBlocknativeNetwork(chainId);
  const blocknative = new BlocknativeSdk({
    dappId: apiKey,
    networkId: Number(chainId),
    ws: WebSocket
  });

  let simResult;
  try {
    simResult = await blocknative.simulate('ethereum', network, simulationTx);
  } finally {
    blocknative.destroy();
  }

  if (hasSimulationError(simResult)) {
    const errorMessage = simResult.error ? JSON.stringify(simResult.error) : 'unknown';
    throw new Error(`Simulation indicates a revert or failure: ${errorMessage}`);
  }

  const gasUsed = Number(simResult.gasUsed);
  if (Number.isFinite(gasUsed) && gasUsed > maxGas) {
    throw new Error(`Simulation gasUsed ${gasUsed} exceeds max ${maxGas}`);
  }

  if (amountOutMinimum > 0n) {
    const delta = getTokenOutDelta(simResult, from, tokenOut, ERC20_DECIMALS);
    if (delta === null) {
      throw new Error('Simulation output missing token out balance change.');
    }
    if (delta < amountOutMinimum) {
      throw new Error(
        `Simulation output ${ethers.formatUnits(
          delta,
          ERC20_DECIMALS
        )} is below minimum ${ethers.formatUnits(amountOutMinimum, ERC20_DECIMALS)}`
      );
    }
  }

  return simResult;
}

function formatEtherAmount(amount) {
  return ethers.formatUnits(amount, ERC20_DECIMALS);
}

function getDayKey(date) {
  return date.toISOString().slice(0, 10);
}

function createHistoryEntry(params) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    side: params.side,
    amountIn: formatEtherAmount(params.amountIn),
    minOut: formatEtherAmount(params.minOut),
    expectedOut: params.expectedOut ? formatEtherAmount(params.expectedOut) : undefined,
    priceStethInWeth: params.priceStethInWeth
      ? ethers.formatUnits(params.priceStethInWeth, ERC20_DECIMALS)
      : undefined,
    status: 'failed'
  };
}

async function main() {
  loadEnv(path.resolve(process.cwd(), '.env'));

  const rpcUrl = process.env.RPC_URL;
  const rawPrivateKey = process.env.BOT_PRIVATE_KEY;
  const blocknativeApiKey = process.env.BLOCKNATIVE_API_KEY;

  if (!rpcUrl || !rawPrivateKey || !blocknativeApiKey) {
    throw new Error('RPC_URL, BOT_PRIVATE_KEY, and BLOCKNATIVE_API_KEY must be set in .env');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(normalizePrivateKey(rawPrivateKey), provider);
  const address = await wallet.getAddress();
  const network = await provider.getNetwork();
  const router = new ethers.Contract(UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, wallet);

  log(`Bot address: ${address}`);
  log(`Network chainId: ${network.chainId}`);

  let tradesToday = 0;
  let currentDay = getDayKey(new Date());
  let consecutiveFailures = 0;

  while (true) {
    const now = new Date();
    const dayKey = getDayKey(now);
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      tradesToday = 0;
      log('New day: trade counter reset.');
    }

    let tradeAttempted = false;
    let tradeSucceeded = false;
    let historyEntry = null;

    const config = loadConfig();
    const fee = config.uniswapV3Fee;
    const maxGas = config.maxGas;
    const maxTradesPerDay = config.maxTradesPerDay;
    const slippageBps = BigInt(config.slippageBps);
    const loopIntervalMs = config.loopIntervalMs;
    const maxTradeSize = ethers.parseUnits(config.maxTradeSizeEth, ERC20_DECIMALS);
    const buyThreshold = ethers.parseUnits(config.buyBelowWeth, ERC20_DECIMALS);
    const sellThreshold = ethers.parseUnits(config.sellAboveWeth, ERC20_DECIMALS);
    const minEthForGas = ethers.parseUnits(config.minEthForGas, ERC20_DECIMALS);

    try {
      const poolInfo = await getPoolInfo(provider, fee);
      const priceScaled = getPriceStethInWethScaled(
        poolInfo.sqrtPriceX96,
        poolInfo.token0,
        poolInfo.token1
      );
      log(`Price stETH in WETH: ${ethers.formatUnits(priceScaled, 18)}`);

      let decision = 'hold';
      if (priceScaled <= buyThreshold) {
        decision = 'buy';
      } else if (priceScaled >= sellThreshold) {
        decision = 'sell';
      }

      log(`Decision: ${decision}`);

      if (decision === 'hold') {
        await new Promise((resolve) => setTimeout(resolve, loopIntervalMs));
        continue;
      }

      if (tradesToday >= maxTradesPerDay) {
        log('Trade skipped: max trades per day reached.');
        await new Promise((resolve) => setTimeout(resolve, loopIntervalMs));
        continue;
      }

      tradeAttempted = true;

      let amountIn = 0n;
      if (decision === 'buy') {
        const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
        const [wethBalance, ethBalance] = await Promise.all([
          weth.balanceOf(address),
          provider.getBalance(address)
        ]);

        const ethAvailable = ethBalance > minEthForGas ? ethBalance - minEthForGas : 0n;
        const available = wethBalance + ethAvailable;
        amountIn = available < maxTradeSize ? available : maxTradeSize;

        if (amountIn <= 0n) {
          log('Trade skipped: insufficient WETH/ETH balance.');
          await new Promise((resolve) => setTimeout(resolve, loopIntervalMs));
          continue;
        }

        if (amountIn > wethBalance) {
          const wrapAmount = amountIn - wethBalance;
          log(`Wrapping ${formatEtherAmount(wrapAmount)} ETH -> WETH...`);
          const depositTx = await weth.deposit({ value: wrapAmount });
          log(`WETH deposit tx: ${depositTx.hash}`);
          await depositTx.wait();
        }

        await ensureApproval(weth, address, UNISWAP_V3_ROUTER, amountIn, 'WETH');
      } else {
        const steth = new ethers.Contract(STETH_ADDRESS, ERC20_ABI, wallet);
        const stethBalance = await steth.balanceOf(address);
        amountIn = stethBalance < maxTradeSize ? stethBalance : maxTradeSize;

        if (amountIn <= 0n) {
          log('Trade skipped: insufficient stETH balance.');
          await new Promise((resolve) => setTimeout(resolve, loopIntervalMs));
          continue;
        }

        await ensureApproval(steth, address, UNISWAP_V3_ROUTER, amountIn, 'stETH');
      }

      const tokenIn = decision === 'buy' ? WETH_ADDRESS : STETH_ADDRESS;
      const tokenOut = decision === 'buy' ? STETH_ADDRESS : WETH_ADDRESS;
      const expectedOut = computeExpectedOut(
        amountIn,
        tokenIn,
        tokenOut,
        poolInfo.sqrtPriceX96,
        poolInfo.token0,
        poolInfo.token1
      );
      const minOut =
        (expectedOut * (SLIPPAGE_BPS_SCALE - slippageBps)) / SLIPPAGE_BPS_SCALE;

      historyEntry = createHistoryEntry({
        side: decision,
        amountIn,
        minOut,
        expectedOut,
        priceStethInWeth: priceScaled
      });

      log(
        `Swap amountIn=${formatEtherAmount(amountIn)} minOut=${formatEtherAmount(minOut)}`
      );

      const params = {
        tokenIn,
        tokenOut,
        fee,
        recipient: address,
        deadline: Math.floor(Date.now() / 1000) + 300,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0
      };

      const simResult = await simulateSwap({
        apiKey: blocknativeApiKey,
        chainId: network.chainId,
        provider,
        from: address,
        router,
        params,
        amountOutMinimum: minOut,
        tokenOut,
        maxGas
      });
      if (simResult.gasUsed) {
        log(`Simulation gasUsed: ${simResult.gasUsed}`);
        historyEntry.gasUsed = Number(simResult.gasUsed);
      }

      log('Simulation passed. Sending swap...');
      const swapTx = await router.exactInputSingle(params);
      log(`Swap tx: ${swapTx.hash}`);
      const receipt = await swapTx.wait();
      log(`Swap confirmed in block ${receipt.blockNumber}`);

      historyEntry.status = 'confirmed';
      historyEntry.txHash = swapTx.hash;
      appendHistory(historyEntry);

      tradesToday += 1;
      tradeSucceeded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Trade loop error: ${message}`);
      if (historyEntry) {
        historyEntry.status = 'failed';
        historyEntry.error = message;
        appendHistory(historyEntry);
      }
    }

    if (tradeAttempted) {
      if (tradeSucceeded) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        log(`Consecutive failures: ${consecutiveFailures}`);
        if (consecutiveFailures >= 3) {
          log('Circuit breaker tripped: stopping bot.');
          break;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, loopIntervalMs));
  }
}

main().catch((error) => {
  log(`Fatal error: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});
