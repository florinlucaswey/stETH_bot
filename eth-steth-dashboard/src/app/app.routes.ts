import { Routes } from '@angular/router';
import { LidoActionsComponent } from './features/lido-actions/lido-actions.component';
import { ValueSignalComponent } from './features/value-signal/value-signal.component';

export const routes: Routes = [
  { path: '', redirectTo: 'lido', pathMatch: 'full' },
  { path: 'lido', component: LidoActionsComponent },
  { path: 'value-signal', component: ValueSignalComponent },
  { path: '**', redirectTo: '' }
];
