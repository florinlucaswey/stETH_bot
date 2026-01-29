import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  inject,
  signal,
  PLATFORM_ID
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, of, switchMap, timer } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  Chart,
  ChartConfiguration,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  TooltipItem
} from 'chart.js';
import 'chartjs-adapter-date-fns';

import {
  ApiClientService,
  BotStatus,
  WithdrawalRequestInfo
} from '../../services/api-client.service';

const POLL_INTERVAL_MS = 15000;
const PRICE_POLL_MS = 15000;
const MAX_PRICE_POINTS = 240;
const CLOCK_TICK_MS = 1000;

type PricePoint = { x: Date; y: number };

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Legend);

@Component({
  selector: 'app-lido-actions',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './lido-actions.component.html',
  styleUrls: ['./lido-actions.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LidoActionsComponent implements AfterViewInit {
  @ViewChild('priceCanvas', { static: true })
  private readonly priceCanvas?: ElementRef<HTMLCanvasElement>;

  private readonly api = inject(ApiClientService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly status = signal<BotStatus | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly priceRatio = signal<number | null>(null);
  readonly discountPct = signal<number | null>(null);
  readonly premiumPct = signal<number | null>(null);
  readonly priceError = signal<string | null>(null);
  readonly priceUpdatedAt = signal<Date | null>(null);
  readonly now = signal<Date>(new Date());

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

  private readonly priceSeries: PricePoint[] = [];
  private priceChart?: Chart<'line', PricePoint[]>;

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

  ngAfterViewInit(): void {
    if (!this.isBrowser) {
      return;
    }

    this.initPriceChart();
    timer(0, CLOCK_TICK_MS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.now.set(new Date());
      });
    this.api
      .getStethEthPriceHistory()
      .pipe(
        catchError((error) => {
          this.priceError.set(formatError('Failed to load price history', error));
          return of([]);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((history) => {
        if (!history.length) {
          this.priceError.set(null);
          return;
        }
        const points = history
          .map((entry) => ({ x: new Date(entry.timestamp), y: entry.priceRatio }))
          .sort((a, b) => a.x.getTime() - b.x.getTime());
        this.priceSeries.splice(0, this.priceSeries.length, ...points.slice(-MAX_PRICE_POINTS));
        const latest = points[points.length - 1];
        const latestEntry = history.find(
          (entry) => new Date(entry.timestamp).getTime() === latest.x.getTime()
        );
        if (latestEntry) {
          this.priceRatio.set(latestEntry.priceRatio);
          this.discountPct.set(latestEntry.discountPct);
          this.premiumPct.set(latestEntry.premiumPct);
          this.priceUpdatedAt.set(new Date(latestEntry.timestamp));
        }
        this.priceError.set(null);
        this.updatePriceChart();
      });

    timer(0, PRICE_POLL_MS)
      .pipe(
        switchMap(() =>
          this.api.getStethEthPrice().pipe(
            catchError((error) => {
              this.priceError.set(formatError('Failed to load price', error));
              return of(null);
            })
          )
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((price) => {
        if (!price) {
          return;
        }
        this.priceRatio.set(price.priceRatio);
        this.discountPct.set(price.discountPct);
        this.premiumPct.set(price.premiumPct);
        this.priceUpdatedAt.set(new Date(price.timestamp));
        this.priceError.set(null);

        this.priceSeries.push({ x: new Date(price.timestamp), y: price.priceRatio });
        if (this.priceSeries.length > MAX_PRICE_POINTS) {
          this.priceSeries.shift();
        }
        this.updatePriceChart();
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

  formatRatio(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
      return '-';
    }
    return value.toFixed(5);
  }

  formatPercent(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
      return '-';
    }
    return `${value.toFixed(2)}%`;
  }

  formatTime(value: string | null | undefined): string {
    if (!value) {
      return '-';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return '-';
    }
    return parsed.toLocaleTimeString();
  }

  getNextLoopSeconds(): number | null {
    const status = this.status();
    const loopSeconds = status?.config?.loopSeconds;
    const lastTick = status?.lastTick ? new Date(status.lastTick) : null;
    if (!loopSeconds || !lastTick || Number.isNaN(lastTick.getTime())) {
      return null;
    }
    const nextAt = lastTick.getTime() + loopSeconds * 1000;
    const remainingMs = nextAt - this.now().getTime();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  getLockRemainingHours(): string {
    const status = this.status();
    const lastAction = status?.lastAction;
    const minHoldHours = status?.config?.minHoldHours;
    if (!lastAction || minHoldHours === undefined) {
      return '-';
    }
    const lastTime = new Date(lastAction.timestamp).getTime();
    if (Number.isNaN(lastTime)) {
      return '-';
    }
    const remainingMs = Math.max(0, minHoldHours * 3600 * 1000 - (this.now().getTime() - lastTime));
    return (remainingMs / 3600000).toFixed(1);
  }

  private initPriceChart(): void {
    if (!this.priceCanvas) {
      return;
    }
    const context = this.priceCanvas.nativeElement.getContext('2d');
    if (!context) {
      return;
    }

    const config: ChartConfiguration<'line', PricePoint[]> = {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'stETH / ETH',
            data: this.priceSeries,
            borderColor: '#0ea5e9',
            backgroundColor: 'rgba(14, 165, 233, 0.2)',
            pointRadius: 0,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'minute' },
            grid: { display: false }
          },
          y: {
            ticks: {
              callback: (value: string | number) => Number(value).toFixed(4)
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context: TooltipItem<'line'>) =>
                `stETH/ETH: ${context.parsed.y !== null ? context.parsed.y.toFixed(5) : '-'}`
            }
          }
        }
      }
    };

    this.priceChart = new Chart(context, config);
  }

  private updatePriceChart(): void {
    if (!this.priceChart) {
      return;
    }
    this.priceChart.update();
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
  if (error instanceof HttpErrorResponse) {
    const apiMessage = extractApiError(error.error);
    return `${context}: ${apiMessage}`;
  }
  if (error instanceof Error) {
    return `${context}: ${error.message}`;
  }
  return `${context}: ${String(error)}`;
}

function extractApiError(payload: unknown): string {
  if (!payload) {
    return 'Request failed.';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload === 'object' && payload !== null) {
    const maybeError = (payload as { error?: unknown }).error;
    if (typeof maybeError === 'string') {
      return maybeError;
    }
    if (maybeError) {
      return JSON.stringify(maybeError);
    }
    return JSON.stringify(payload);
  }
  return String(payload);
}
