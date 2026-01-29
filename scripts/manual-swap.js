const fs = require('fs');
const path = require('path');
const BlocknativeSdk = require('bnc-sdk');
const { ethers } = require('ethers');
const WebSocket = require('ws');

const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const STETH_ADDRESS = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const DEFAULT_MAX_GAS = 500000;
const ERC20_DECIMALS = 18;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
];

const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];

const UNISWAP_V3_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
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

function getArgValue(name, alias) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }

  if (alias) {
    const aliasIndex = process.argv.indexOf(alias);
    if (aliasIndex !== -1 && aliasIndex + 1 < process.argv.length) {
      return process.argv[aliasIndex + 1];
    }
  }

  return undefined;
}

function normalizePrivateKey(rawKey) {
  return rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
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

async function ensureApproval(token, owner, spender, amount, label) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) {
    console.log(`${label} allowance OK: ${ethers.formatEther(allowance)}`);
    return;
  }

  console.log(`${label} approving ${ethers.formatEther(amount)}...`);
  const approveTx = await token.approve(spender, amount);
  console.log(`${label} approve tx: ${approveTx.hash}`);
  await approveTx.wait();
}

async function main() {
  loadEnv(path.resolve(process.cwd(), '.env'));

  const rpcUrl = process.env.RPC_URL;
  const rawPrivateKey = process.env.BOT_PRIVATE_KEY;
  const blocknativeApiKey = process.env.BLOCKNATIVE_API_KEY;
  if (!rpcUrl || !rawPrivateKey || !blocknativeApiKey) {
    throw new Error('RPC_URL, BOT_PRIVATE_KEY, and BLOCKNATIVE_API_KEY must be set in .env');
  }

  const amountArg = getArgValue('--amount', '-a');
  if (!amountArg) {
    throw new Error('Missing required --amount argument (e.g. --amount 0.001)');
  }

  const directionArg =
    (getArgValue('--direction', '-d') ?? 'weth-to-steth').toLowerCase();
  if (directionArg !== 'weth-to-steth' && directionArg !== 'steth-to-weth') {
    throw new Error('Direction must be weth-to-steth or steth-to-weth');
  }

  const feeArg = getArgValue('--fee');
  const fee = feeArg ? Number(feeArg) : Number(process.env.UNISWAP_V3_FEE ?? '500');
  if (!Number.isInteger(fee) || fee <= 0) {
    throw new Error('Invalid Uniswap v3 fee. Use --fee 500 or set UNISWAP_V3_FEE.');
  }

  const amountOutMinArg = getArgValue('--min-out');
  const amountOutMinimum = amountOutMinArg
    ? ethers.parseEther(amountOutMinArg)
    : 0n;

  const maxGasArg = getArgValue('--max-gas');
  const maxGas = maxGasArg ? Number(maxGasArg) : Number(process.env.MAX_GAS ?? DEFAULT_MAX_GAS);
  if (!Number.isFinite(maxGas) || maxGas <= 0) {
    throw new Error('Invalid max gas limit. Use --max-gas or set MAX_GAS.');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(normalizePrivateKey(rawPrivateKey), provider);
  const address = await wallet.getAddress();
  const network = await provider.getNetwork();

  console.log(`Bot address: ${address}`);
  console.log(`Network: ${network.chainId}`);
  console.log(`Direction: ${directionArg} (fee ${fee})`);

  const amountIn = ethers.parseEther(amountArg);
  const router = new ethers.Contract(UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, wallet);

  if (directionArg === 'weth-to-steth') {
    const weth = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);

    console.log(`Wrapping ${amountArg} ETH -> WETH...`);
    const depositTx = await weth.deposit({ value: amountIn });
    console.log(`WETH deposit tx: ${depositTx.hash}`);
    await depositTx.wait();

    await ensureApproval(weth, address, UNISWAP_V3_ROUTER, amountIn, 'WETH');

    console.log('Swapping WETH -> stETH...');
    const params = {
      tokenIn: WETH_ADDRESS,
      tokenOut: STETH_ADDRESS,
      fee,
      recipient: address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };
    const simResult = await simulateSwap({
      apiKey: blocknativeApiKey,
      chainId: network.chainId,
      provider,
      from: address,
      router,
      params,
      amountOutMinimum,
      tokenOut: STETH_ADDRESS,
      maxGas
    });
    if (simResult.gasUsed) {
      console.log(`Simulation gasUsed: ${simResult.gasUsed}`);
    }
    const swapTx = await router.exactInputSingle(params);
    console.log(`Swap tx: ${swapTx.hash}`);
    const receipt = await swapTx.wait();
    console.log(`Swap confirmed in block ${receipt.blockNumber}`);
  } else {
    const steth = new ethers.Contract(STETH_ADDRESS, ERC20_ABI, wallet);
    await ensureApproval(steth, address, UNISWAP_V3_ROUTER, amountIn, 'stETH');

    console.log('Swapping stETH -> WETH...');
    const params = {
      tokenIn: STETH_ADDRESS,
      tokenOut: WETH_ADDRESS,
      fee,
      recipient: address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };
    const simResult = await simulateSwap({
      apiKey: blocknativeApiKey,
      chainId: network.chainId,
      provider,
      from: address,
      router,
      params,
      amountOutMinimum,
      tokenOut: WETH_ADDRESS,
      maxGas
    });
    if (simResult.gasUsed) {
      console.log(`Simulation gasUsed: ${simResult.gasUsed}`);
    }
    const swapTx = await router.exactInputSingle(params);
    console.log(`Swap tx: ${swapTx.hash}`);
    const receipt = await swapTx.wait();
    console.log(`Swap confirmed in block ${receipt.blockNumber}`);
  }
}

main().catch((error) => {
  console.error('Manual swap failed.');
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
