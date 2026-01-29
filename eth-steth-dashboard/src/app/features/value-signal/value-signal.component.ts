import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { catchError, distinctUntilChanged, map, of, startWith, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  Chart,
  ChartConfiguration,
  ChartDataset,
  ChartOptions,
  LineElement,
  LineController,
  LinearScale,
  PointElement,
  TimeScale,
  Tooltip,
  Legend,
  Plugin,
  TooltipItem
} from 'chart.js';
import 'chartjs-adapter-date-fns';

import {
  ValueSignalPoint,
  ValueSignalQuery,
  ValueSignalSeries,
  ValueSignalService
} from '../../services/value-signal.service';

type DateRangePreset = '30d' | '90d' | '1y' | '3y' | 'custom';

type RangeOption = {
  value: DateRangePreset;
  label: string;
  days?: number;
};

type ValueSignalFormValue = {
  range: DateRangePreset;
  from: string;
  to: string;
  riskPremiumPct: number;
  waitingTimeDays: number;
  includeWaitingTimeCost: boolean;
};

type ValueSignalState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; series: ValueSignalSeries; params: ValueSignalQuery };

type ChartPoint = { x: Date; y: number | null };

type ValueZonePluginOptions = {
  discountDatasetIndex: number;
  hurdleDatasetIndex: number;
  color: string;
};

const rangeOptions: RangeOption[] = [
  { value: '30d', label: 'Last 30d', days: 30 },
  { value: '90d', label: 'Last 90d', days: 90 },
  { value: '1y', label: '1y', days: 365 },
  { value: '3y', label: '3y', days: 365 * 3 },
  { value: 'custom', label: 'Custom' }
];

const valueZonePlugin: Plugin<'line', ValueZonePluginOptions> = {
  id: 'valueZone',
  beforeDatasetsDraw(
    chart: Chart<'line'>,
    _args: { cancelable: boolean },
    options: ValueZonePluginOptions
  ) {
    const discountDataset = chart.data.datasets[options.discountDatasetIndex];
    const hurdleDataset = chart.data.datasets[options.hurdleDatasetIndex];
    if (!discountDataset || !hurdleDataset || !chart.chartArea) {
      return;
    }

    const discountData = coerceChartPoints(discountDataset.data);
    const hurdleData = coerceChartPoints(hurdleDataset.data);
    const xScale = chart.scales['x'];

    if (!xScale) {
      return;
    }

    const pixels = discountData.map((point) => xScale.getPixelForValue(point.x.getTime()));
    const segments: Array<[number, number]> = [];

    let start: number | null = null;
    let lastRight = 0;

    for (let i = 0; i < discountData.length; i += 1) {
      const discountValue = discountData[i]?.y ?? null;
      const hurdleValue = hurdleData[i]?.y ?? null;

      const current = pixels[i];
      const prev = pixels[i - 1] ?? current;
      const next = pixels[i + 1] ?? current;
      const left = current - (current - prev) / 2;
      const right = current + (next - current) / 2;

      if (discountValue === null || hurdleValue === null) {
        if (start !== null) {
          segments.push([start, lastRight]);
          start = null;
        }
        continue;
      }

      const inZone = discountValue > hurdleValue;
      if (inZone && start === null) {
        start = left;
      }
      if (!inZone && start !== null) {
        segments.push([start, lastRight]);
        start = null;
      }
      if (inZone) {
        lastRight = right;
      }
    }

    if (start !== null) {
      segments.push([start, lastRight]);
    }

    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = options.color;
    segments.forEach(([segmentStart, segmentEnd]) => {
      ctx.fillRect(
        segmentStart,
        chart.chartArea.top,
        segmentEnd - segmentStart,
        chart.chartArea.bottom - chart.chartArea.top
      );
    });
    ctx.restore();
  }
};

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  valueZonePlugin
);

@Component({
  selector: 'app-value-signal',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './value-signal.component.html',
  styleUrls: ['./value-signal.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ValueSignalComponent implements AfterViewInit, OnDestroy {
  @ViewChild('chartCanvas', { static: true })
  private readonly chartCanvas?: ElementRef<HTMLCanvasElement>;

  private readonly formBuilder = inject(FormBuilder);
  private readonly service = inject(ValueSignalService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rangeOptions = rangeOptions;
  readonly formatPercent = formatPercent;

  readonly filters = this.formBuilder.nonNullable.group({
    range: ['90d' as DateRangePreset],
    from: [formatDate(addDays(new Date(), -90))],
    to: [formatDate(new Date())],
    riskPremiumPct: [2],
    waitingTimeDays: [14],
    includeWaitingTimeCost: [true]
  });

  readonly state$ = this.filters.valueChanges.pipe(
    startWith(this.filters.getRawValue()),
    map((value) => this.normalizeForm({ ...this.filters.getRawValue(), ...value })),
    distinctUntilChanged((a, b) => sameQuery(a, b)),
    switchMap((params) =>
      this.service.getValueSignalSeries(params).pipe(
        map((series) =>
          series.points.length
            ? ({ status: 'ready', series, params } as ValueSignalState)
            : ({ status: 'empty' } as ValueSignalState)
        ),
        startWith({ status: 'loading' } as ValueSignalState),
        catchError((error) =>
          of({
            status: 'error',
            message: formatError('Failed to load series', error)
          } as ValueSignalState)
        )
      )
    )
  );

  private chart?: Chart<'line', ChartPoint[]>;

  ngAfterViewInit(): void {
    this.initChart();

    this.state$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state.status === 'ready') {
          this.updateChart(state.series);
        } else {
          this.updateChart(null);
        }
      });
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
    this.chart = undefined;
  }

  private initChart(): void {
    if (!this.chartCanvas) {
      return;
    }
    const context = this.chartCanvas.nativeElement.getContext('2d');
    if (!context) {
      return;
    }

    const options: ChartOptions<'line'> = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day' },
          grid: { display: false }
        },
        y: {
          ticks: {
            callback: (value: string | number) => `${Number(value).toFixed(2)}%`
          }
        }
      },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: (context: TooltipItem<'line'>) =>
              `${context.dataset.label}: ${formatPercent(context.parsed.y ?? null)}`
          }
        },
        valueZone: {
          discountDatasetIndex: 0,
          hurdleDatasetIndex: 2,
          color: 'rgba(34, 197, 94, 0.12)'
        } as ValueZonePluginOptions
      } as ChartOptions<'line'>['plugins'] & { valueZone: ValueZonePluginOptions }
    };

    const config: ChartConfiguration<'line', ChartPoint[]> = {
      type: 'line',
      data: { datasets: [] },
      options
    };

    this.chart = new Chart(context, config);
  }

  private updateChart(series: ValueSignalSeries | null): void {
    if (!this.chart) {
      return;
    }

    if (!series) {
      this.chart.data.datasets = [];
      this.chart.update();
      return;
    }

    const datasets = buildDatasets(series.points);
    this.chart.data.datasets = datasets;
    this.chart.update();
  }

  private normalizeForm(value: ValueSignalFormValue): ValueSignalQuery {
    const preset = rangeOptions.find((option) => option.value === value.range);
    const now = new Date();

    let from = value.from;
    let to = value.to;

    if (preset?.days) {
      to = formatDate(now);
      from = formatDate(addDays(now, -preset.days));
    }

    if (!from) {
      from = formatDate(addDays(now, -30));
    }

    if (!to) {
      to = formatDate(now);
    }

    if (parseDate(from).getTime() > parseDate(to).getTime()) {
      const swap = from;
      from = to;
      to = swap;
    }

    return {
      from,
      to,
      riskPremiumPct: value.riskPremiumPct,
      waitingTimeDays: value.waitingTimeDays,
      includeWaitingTimeCost: value.includeWaitingTimeCost
    };
  }
}

function buildDatasets(points: ValueSignalPoint[]): ChartDataset<'line', ChartPoint[]>[] {
  const discount = toChartPoints(points, (point) => point.discountPct);
  const apr = toChartPoints(points, (point) => point.aprPct);
  const hurdle = toChartPoints(points, (point) => point.hurdlePct);

  return [
    {
      label: 'Discount',
      data: discount,
      borderColor: '#2563eb',
      backgroundColor: '#2563eb',
      pointRadius: 0,
      tension: 0.35
    },
    {
      label: 'Lido APR',
      data: apr,
      borderColor: '#f97316',
      backgroundColor: '#f97316',
      pointRadius: 0,
      tension: 0.35
    },
    {
      label: 'Hurdle',
      data: hurdle,
      borderColor: '#0f766e',
      backgroundColor: '#0f766e',
      borderDash: [6, 4],
      pointRadius: 0,
      tension: 0.35
    }
  ];
}

function toChartPoints(
  points: ValueSignalPoint[],
  getter: (point: ValueSignalPoint) => number | null
): ChartPoint[] {
  return points.map((point) => ({
    x: parseDate(point.date),
    y: getter(point)
  }));
}

function coerceChartPoints(data: unknown): ChartPoint[] {
  return data as ChartPoint[];
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function sameQuery(a: ValueSignalQuery, b: ValueSignalQuery): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.riskPremiumPct === b.riskPremiumPct &&
    a.waitingTimeDays === b.waitingTimeDays &&
    a.includeWaitingTimeCost === b.includeWaitingTimeCost
  );
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '-';
  }
  return `${value.toFixed(2)}%`;
}

function formatError(context: string, error: unknown): string {
  if (error instanceof Error) {
    return `${context}: ${error.message}`;
  }
  return `${context}: ${String(error)}`;
}
