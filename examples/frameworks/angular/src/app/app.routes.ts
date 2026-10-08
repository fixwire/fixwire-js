import { Routes } from '@angular/router';
import { ShopPage } from './pages/shop';

export const routes: Routes = [
  { path: '', component: ShopPage },
  { path: 'users/:id', loadComponent: () => import('./pages/user').then((m) => m.UserPage) },
  {
    path: 'reports',
    loadComponent: () => import('./pages/user').then((m) => m.UserPage),
    // A guard that fails: the navigation errors, and Fixwire reports it.
    canActivate: [
      () => {
        throw new Error('Reports are unavailable: the reporting service timed out');
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
