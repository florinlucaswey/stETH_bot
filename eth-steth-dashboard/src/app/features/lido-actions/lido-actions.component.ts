import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { catchError, of, switchMap, timer } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  ApiClientService,
  BotStatus,
  WithdrawalRequestInfo
} from '../../services/api-client.service';

const POLL_INTERVAL_MS = 15000;

@Component({
  selector: 'app-lido-actions',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './lido-actions.component.html',
  styleUrls: ['./lido-actions.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LidoActionsComponent {
  private readonly api = inject(ApiClientService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  readonly status = signal<BotStatus | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly stakeForm = this.formBuilder.nonNullable.group({
    amountEth: ['']
  });

  readonly withdrawForm = this.formBuilder.nonNullable.group({
    amountSteth: ['']
  });

  readonly claimForm = this.formBuilder.nonNullable.group({
    requestIds: ['']
  });

  readonly stakePending = signal(false);
  readonly stakeError = signal<string | null>(null);
  readonly stakeSuccess = signal<string | null>(null);

  readonly withdrawPending = signal(false);
  readonly withdrawError = signal<string | null>(null);
  readonly withdrawSuccess = signal<string | null>(null);

  readonly claimPending = signal(false);
  readonly claimError = signal<string | null>(null);
  readonly claimSuccess = signal<string | null>(null);

  constructor() {
    timer(0, POLL_INTERVAL_MS)
      .pipe(
        switchMap(() =>
          this.api.getStatus().pipe(
            catchError((error) => {
              this.error.set(formatError('Failed to load status', error));
              return of(null);
            })
          )
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((status) => {
        if (status) {
          this.status.set(status);
          this.error.set(null);
        }
        this.loading.set(false);
      });
  }

  refreshStatus(): void {
    this.loading.set(true);
    this.api
      .getStatus()
      .pipe(
        catchError((error) => {
          this.error.set(formatError('Failed to refresh status', error));
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((status) => {
        if (status) {
          this.status.set(status);
          this.error.set(null);
        }
        this.loading.set(false);
      });
  }

  stake(): void {
    const amountEth = this.stakeForm.controls.amountEth.value.trim();
    if (!isPositiveNumber(amountEth)) {
      this.stakeError.set('Enter a valid ETH amount.');
      return;
    }

    this.stakePending.set(true);
    this.stakeError.set(null);
    this.stakeSuccess.set(null);

    this.api
      .stakeEth(amountEth)
      .pipe(
        catchError((error) => {
          this.stakeError.set(formatError('Stake failed', error));
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.stakePending.set(false);
        if (!result) {
          return;
        }
        this.stakeSuccess.set(`Tx sent: ${formatHash(result.txHash)}`);
        this.stakeForm.reset({ amountEth: '' });
        this.refreshStatus();
      });
  }

  requestWithdraw(): void {
    const amountSteth = this.withdrawForm.controls.amountSteth.value.trim();
    if (!isPositiveNumber(amountSteth)) {
      this.withdrawError.set('Enter a valid stETH amount.');
      return;
    }

    this.withdrawPending.set(true);
    this.withdrawError.set(null);
    this.withdrawSuccess.set(null);

    this.api
      .requestWithdrawal(amountSteth)
      .pipe(
        catchError((error) => {
          this.withdrawError.set(formatError('Request failed', error));
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.withdrawPending.set(false);
        if (!result) {
          return;
        }
        this.withdrawSuccess.set(
          `Requested ${result.requestIds.length} withdrawal(s): ${result.requestIds.join(', ')}`
        );
        this.withdrawForm.reset({ amountSteth: '' });
        this.refreshStatus();
      });
  }

  claimWithdrawals(): void {
    const idsRaw = this.claimForm.controls.requestIds.value;
    const requestIds = parseRequestIds(idsRaw);
    if (!requestIds.length) {
      this.claimError.set('Enter at least one request id.');
      return;
    }

    this.claimPending.set(true);
    this.claimError.set(null);
    this.claimSuccess.set(null);

    this.api
      .claimWithdrawals(requestIds)
      .pipe(
        catchError((error) => {
          this.claimError.set(formatError('Claim failed', error));
          return of(null);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((result) => {
        this.claimPending.set(false);
        if (!result) {
          return;
        }
        this.claimSuccess.set(`Claim tx: ${formatHash(result.txHash)}`);
        this.claimForm.reset({ requestIds: '' });
        this.refreshStatus();
      });
  }

  formatAddress(address?: string | null): string {
    if (!address) {
      return '-';
    }
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  formatRequestList(requests: WithdrawalRequestInfo[]): string {
    if (!requests.length) {
      return '-';
    }
    return requests.map((req) => req.requestId).join(', ');
  }
}

function isPositiveNumber(value: string): boolean {
  if (!value) {
    return false;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function parseRequestIds(input: string): string[] {
  return input
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function formatHash(hash: string): string {
  if (!hash) {
    return '';
  }
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function formatError(context: string, error: unknown): string {
  if (error instanceof Error) {
    return `${context}: ${error.message}`;
  }
  return `${context}: ${String(error)}`;
}
