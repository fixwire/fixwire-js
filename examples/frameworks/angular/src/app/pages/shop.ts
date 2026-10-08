import { Component, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/** Fails to render when the cart is gone. */
@Component({
  selector: 'app-cart-summary',
  template: `<p>{{ count() }} items in the cart</p>`,
})
export class CartSummary {
  readonly items = input<string[] | undefined>();

  count(): number {
    const items = this.items();
    if (!items) throw new TypeError('Cannot read the cart: items is undefined');
    return items.length;
  }
}

@Component({
  imports: [CartSummary],
  template: `
    <h1>Shop</h1>
    <p>Each of these fails in its own way; Fixwire gets every one.</p>
    <button type="button" (click)="checkout()">Check out</button>
    <button type="button" (click)="loadOrder()">Load order 7</button>
    <button type="button" (click)="items.set(undefined)">Empty the cart</button>
    @boundary {
      <app-cart-summary [items]="items()" />
    } @error {
      <p>The cart couldn't be shown.</p>
    }
  `,
})
export class ShopPage {
  private readonly http = inject(HttpClient);
  protected readonly items = signal<string[] | undefined>(['socks']);

  // An error in an event handler: Angular hands it to Fixwire's ErrorHandler.
  checkout(): void {
    throw new Error('Checkout failed: the card was declined');
  }

  // A failed request nobody handles: reported with its status and URL.
  loadOrder(): void {
    this.http.get('/api/orders/7').subscribe();
  }
}
