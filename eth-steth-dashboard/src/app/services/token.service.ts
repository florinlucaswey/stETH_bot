import { Injectable } from '@angular/core';
import { ethers } from 'ethers';
import { EthService } from './eth.service';
import stethAbi from '../abi/steth.json';

@Injectable({
  providedIn: 'root'
})
export class TokenService {
  private readonly stEthAddress = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';

  constructor(private ethService: EthService) {}

  private getStEthContract() {
    const provider = this.ethService.getProvider();
    return new ethers.Contract(this.stEthAddress, stethAbi, provider);
  }

  async getStEthBalance(address: string): Promise<string> {
    const contract = this.getStEthContract();
    const bal = await contract.balanceOf(address);
    return ethers.formatEther(bal);
  }
}
