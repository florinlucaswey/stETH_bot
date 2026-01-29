const fs = require('fs');
const path = require('path');
const BlocknativeSdk = require('bnc-sdk');
const WebSocket = require('ws');
const { ethers } = require('ethers');

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

function normalizePrivateKey(rawKey) {
  return rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
}

async function main() {
  loadEnv(path.resolve(process.cwd(), '.env'));

  const apiKey = process.env.BLOCKNATIVE_API_KEY;
  const chainId = Number(process.env.CHAIN_ID ?? '1');
  const botAddress = process.env.BOT_ADDRESS;
  const botPrivateKey = process.env.BOT_PRIVATE_KEY;

  if (!apiKey) {
    throw new Error('BLOCKNATIVE_API_KEY must be set in .env');
  }

  let address = botAddress;
  if (!address) {
    if (!botPrivateKey) {
      throw new Error('Set BOT_ADDRESS or BOT_PRIVATE_KEY in .env');
    }
    const wallet = new ethers.Wallet(normalizePrivateKey(botPrivateKey));
    address = wallet.address;
  }

  const blocknative = new BlocknativeSdk({
    dappId: apiKey,
    system: 'ethereum',
    networkId: chainId,
    ws: WebSocket
  });

  console.log(`Monitoring address: ${address}`);
  console.log(`Network: ${chainId}`);

  const { emitter } = blocknative.account(address);

  emitter.on('txPool', (tx) => {
    console.log('txPool', tx?.hash ?? tx);
  });

  emitter.on('txConfirmed', (tx) => {
    console.log('txConfirmed', tx?.hash ?? tx);
  });

  emitter.on('txFailed', (tx) => {
    console.log('txFailed', tx?.hash ?? tx);
  });
}

main().catch((error) => {
  console.error('Blocknative monitor failed.');
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
