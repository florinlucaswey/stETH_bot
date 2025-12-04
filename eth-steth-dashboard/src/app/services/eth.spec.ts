import { TestBed } from '@angular/core/testing';

import { Eth } from './eth';

describe('Eth', () => {
  let service: Eth;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Eth);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
