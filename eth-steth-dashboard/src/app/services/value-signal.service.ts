import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { combineLatest, map, Observable } from 'rxjs';

export type StethDiscountPoint = {
  date: string;
  stEthPriceEth: number;
};

export type LidoAprPoint = {
  date: string;
  aprPct: number;
};

export type ValueSignalQuery = {
  from: string;
  to: string;
  waitingTimeDays: number;
  riskPremiumPct: number;
  includeWaitingTimeCost: boolean;
};

export type ValueSignalPoint = {
  date: string;
  stEthPriceEth: number | null;
  aprPct: number | null;
  discountPct: number | null;
  waitingTimeCostPct: number | null;
  hurdlePct: number | null;
  valueSignal: number | null;
  inValueZone: boolean;
};

export type ValueSignalSummary = {
  date: string | null;
  discountPct: number | null;
  aprPct: number | null;
  hurdlePct: number | null;
  valueSignal: number | null;
  inValueZone: boolean;
};

export type ValueSignalSeries = {
  points: ValueSignalPoint[];
  summary: ValueSignalSummary;
};

type ValueSignalGlobals = {
  __BOT_API_BASE__?: string;
};

export function computeDiscountPct(stEthPriceEth: number): number {
  return (1 - stEthPriceEth) * 100;
}

export function computeWaitingTimeCostPct(aprPct: number, waitingTimeDays: number): number {
  return aprPct * (waitingTimeDays / 365);
}

export function computeHurdlePct(
  aprPct: number,
  waitingTimeDays: number,
  riskPremiumPct: number,
  includeWaitingTimeCost: boolean
): number {
  const waitingCost = includeWaitingTimeCost
    ? computeWaitingTimeCostPct(aprPct, waitingTimeDays)
    : 0;
  return waitingCost + riskPremiumPct;
}

export function computeValueSignal(discountPct: number, hurdlePct: number): number {
  return discountPct - hurdlePct;
}

@Injectable({
  providedIn: 'root'
})
export class ValueSignalService {
  private readonly baseUrl: string;

  constructor(private http: HttpClient) {
    const globalBase = (globalThis as ValueSignalGlobals).__BOT_API_BASE__;
    this.baseUrl = globalBase?.replace(/\/+$/, '') || 'http://localhost:3001';
  }

  getValueSignalSeries(query: ValueSignalQuery): Observable<ValueSignalSeries> {
    const params = { from: query.from, to: query.to };
    const discount$ = this.http.get<StethDiscountPoint[]>(
      `${this.baseUrl}/api/series/steth-discount`,
      { params }
    );
    const apr$ = this.http.get<LidoAprPoint[]>(`${this.baseUrl}/api/series/lido-apr`, {
      params
    });

    return combineLatest([discount$, apr$]).pipe(
      map(([discountSeries, aprSeries]) =>
        buildValueSignalSeries(discountSeries, aprSeries, query)
      )
    );
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function buildValueSignalSeries(
  discountSeries: StethDiscountPoint[],
  aprSeries: LidoAprPoint[],
  query: ValueSignalQuery
): ValueSignalSeries {
  const discountMap = new Map(
    discountSeries.map((point) => [point.date, point.stEthPriceEth])
  );
  const aprMap = new Map(aprSeries.map((point) => [point.date, point.aprPct]));
  const dates = buildDateRange(query.from, query.to);

  const points: ValueSignalPoint[] = [];
  let lastApr: number | null = null;

  for (const date of dates) {
    const apr = aprMap.get(date);
    if (apr !== undefined) {
      lastApr = apr;
    }

    const stEthPriceEth = discountMap.get(date) ?? null;
    const aprPct = lastApr ?? null;
    const discountPct = stEthPriceEth !== null ? computeDiscountPct(stEthPriceEth) : null;

    const waitingTimeCostPct = query.includeWaitingTimeCost
      ? aprPct !== null
        ? computeWaitingTimeCostPct(aprPct, query.waitingTimeDays)
        : null
      : 0;

    const hurdlePct = query.includeWaitingTimeCost
      ? waitingTimeCostPct !== null
        ? waitingTimeCostPct + query.riskPremiumPct
        : null
      : query.riskPremiumPct;

    const valueSignal =
      discountPct !== null && hurdlePct !== null
        ? computeValueSignal(discountPct, hurdlePct)
        : null;

    points.push({
      date,
      stEthPriceEth,
      aprPct,
      discountPct,
      waitingTimeCostPct,
      hurdlePct,
      valueSignal,
      inValueZone: valueSignal !== null && valueSignal > 0
    });
  }

  const latest = findLatestPoint(points);
  const summary: ValueSignalSummary = latest
    ? {
        date: latest.date,
        discountPct: latest.discountPct,
        aprPct: latest.aprPct,
        hurdlePct: latest.hurdlePct,
        valueSignal: latest.valueSignal,
        inValueZone: latest.inValueZone
      }
    : {
        date: null,
        discountPct: null,
        aprPct: null,
        hurdlePct: null,
        valueSignal: null,
        inValueZone: false
      };

  return { points, summary };
}

function buildDateRange(from: string, to: string): string[] {
  const start = parseDate(from);
  const end = parseDate(to);

  if (!start || !end || start.getTime() > end.getTime()) {
    return [];
  }

  const dates: string[] = [];
  for (let current = start; current.getTime() <= end.getTime(); current = new Date(current.getTime() + MS_PER_DAY)) {
    dates.push(formatDate(current));
  }

  return dates;
}

function parseDate(value: string): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function findLatestPoint(points: ValueSignalPoint[]): ValueSignalPoint | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (point.discountPct !== null && point.hurdlePct !== null) {
      return point;
    }
  }
  return null;
}
