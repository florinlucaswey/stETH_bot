const fs = require('fs');
const path = require('path');
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

async function main() {
  const envPath = path.resolve(process.cwd(), '.env');
  loadEnv(envPath);

  const requiredKeys = ['RPC_URL', 'BOT_PRIVATE_KEY'];
  const missingKeys = requiredKeys.filter((key) => {
    const value = process.env[key];
    return !value || value.trim() === '';
  });

  if (missingKeys.length) {
    throw new Error(
      `Missing required env vars in ${envPath}: ${missingKeys.join(', ')}`
    );
  }

  const rpcUrl = process.env.RPC_URL;
  const rawPrivateKey = process.env.BOT_PRIVATE_KEY;
  const privateKey = rawPrivateKey.startsWith('0x')
    ? rawPrivateKey
    : `0x${rawPrivateKey}`;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const address = await wallet.getAddress();

  const ethBalance = await provider.getBalance(address);

  const stethAddress = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
  const stethAbi = ['function balanceOf(address owner) view returns (uint256)'];
  const stethContract = new ethers.Contract(stethAddress, stethAbi, provider);
  const stethBalance = await stethContract.balanceOf(address);

  console.log(`Bot address: ${address}`);
  console.log(`ETH balance: ${ethers.formatEther(ethBalance)}`);
  console.log(`stETH balance: ${ethers.formatEther(stethBalance)}`);
}

main().catch((error) => {
  console.error('Sanity check failed.');
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
