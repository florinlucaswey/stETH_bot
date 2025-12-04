import { Injectable } from '@angular/core';
import { ethers } from 'ethers';

@Injectable({
  providedIn: 'root'
})
export class EthService {
  private provider: ethers.JsonRpcProvider;
  private wallet?: ethers.Wallet;

  constructor() {
    // For dev, use an RPC URL from e.g. Infura/Alchemy/Ankr
    const rpcUrl = 'https://mainnet.infura.io/v3/YOUR_KEY';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // DO NOT hardcode private keys in production
    const privateKey = '0xYOUR_PRIVATE_KEY_FOR_TESTING_ONLY';
    this.wallet = new ethers.Wallet(privateKey, this.provider);
  }

  getProvider() {
    return this.provider;
  }

  getWallet() {
    if (!this.wallet) throw new Error('Wallet not initialised');
    return this.wallet;
  }
}
