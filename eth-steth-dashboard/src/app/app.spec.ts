import { TestBed } from '@angular/core/testing';
import { ethers } from 'ethers';
import { AppComponent } from './app';
import { EthService } from './services/eth.service';

describe('AppComponent', () => {
  let ethServiceMock: jasmine.SpyObj<EthService>;
  let walletMock: { getBalance: jasmine.Spy<() => Promise<bigint>> };

  beforeEach(async () => {
    walletMock = {
      getBalance: jasmine.createSpy('getBalance').and.returnValue(
        Promise.resolve(ethers.parseEther('1'))
      )
    };
    ethServiceMock = jasmine.createSpyObj('EthService', ['getWallet']);
    ethServiceMock.getWallet.and.returnValue(walletMock as unknown as ethers.Wallet);

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: EthService, useValue: ethServiceMock }]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render ETH balance', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('ETH ↔ stETH bot');
    expect(compiled.querySelector('p')?.textContent).toContain('1.0');
  });
});
