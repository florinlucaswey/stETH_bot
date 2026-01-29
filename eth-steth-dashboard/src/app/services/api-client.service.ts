import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type WithdrawalRequestInfo = {
  requestId: string;
  amountSteth?: string;
  status?: 'pending' | 'ready' | 'claimed';
};

export type BotStatus = {
  botAddress: string;
  ethBalance: string;
  stethBalance: string;
  pendingWithdrawals: WithdrawalRequestInfo[];
  readyToClaim: WithdrawalRequestInfo[];
};

export type StakeResponse = {
  txHash: string;
};

export type WithdrawRequestResponse = {
  txHash: string;
  requestIds: string[];
};

export type WithdrawClaimResponse = {
  txHash: string;
};

type ApiGlobals = {
  __BOT_API_BASE__?: string;
};

@Injectable({
  providedIn: 'root'
})
export class ApiClientService {
  private readonly baseUrl: string;

  constructor(private http: HttpClient) {
    const globalBase = (globalThis as ApiGlobals).__BOT_API_BASE__;
    this.baseUrl = globalBase?.replace(/\/+$/, '') || 'http://localhost:3001';
  }

  getStatus(): Observable<BotStatus> {
    return this.http.get<BotStatus>(`${this.baseUrl}/api/status`);
  }

  stakeEth(amountEth: string): Observable<StakeResponse> {
    return this.http.post<StakeResponse>(`${this.baseUrl}/api/lido/stake`, { amountEth });
  }

  requestWithdrawal(amountSteth: string): Observable<WithdrawRequestResponse> {
    return this.http.post<WithdrawRequestResponse>(`${this.baseUrl}/api/lido/withdraw/request`, {
      amountSteth
    });
  }

  claimWithdrawals(requestIds: string[]): Observable<WithdrawClaimResponse> {
    return this.http.post<WithdrawClaimResponse>(`${this.baseUrl}/api/lido/withdraw/claim`, {
      requestIds
    });
  }
}
