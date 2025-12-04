import { Component, OnInit } from '@angular/core';
import { EthService } from './services/eth.service';
import { ethers } from 'ethers';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <div>
      <h1>ETH ↔ stETH bot</h1>
      <p>ETH balance: {{ ethBalance }}</p>
    </div>
  `
})
export class AppComponent implements OnInit {
  ethBalance: string = '-';

  constructor(private ethService: EthService) {}

  async ngOnInit() {
    const wallet = this.ethService.getWallet();
    const balance = await wallet.getBalance();
    this.ethBalance = ethers.formatEther(balance);
  }
}