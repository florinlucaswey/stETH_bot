import {
  computeDiscountPct,
  computeHurdlePct,
  computeValueSignal,
  computeWaitingTimeCostPct
} from './value-signal.service';

describe('value signal computations', () => {
  it('computes discount percentage from stETH price', () => {
    expect(computeDiscountPct(0.995)).toBeCloseTo(0.5, 6);
  });

  it('computes waiting time cost percentage', () => {
    const cost = computeWaitingTimeCostPct(3.65, 10);
    expect(cost).toBeCloseTo(0.1, 6);
  });

  it('computes hurdle with waiting time cost included', () => {
    const hurdle = computeHurdlePct(4, 14, 2, true);
    const expected = (4 * (14 / 365)) + 2;
    expect(hurdle).toBeCloseTo(expected, 6);
  });

  it('computes hurdle without waiting time cost', () => {
    const hurdle = computeHurdlePct(4, 14, 2, false);
    expect(hurdle).toBeCloseTo(2, 6);
  });

  it('computes value signal', () => {
    expect(computeValueSignal(1.2, 0.7)).toBeCloseTo(0.5, 6);
  });
});
