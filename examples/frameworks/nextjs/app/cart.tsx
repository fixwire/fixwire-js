"use client";

import { useState } from "react";

/** An error in an event handler: no boundary sees it, the browser SDK does. */
export function CheckoutButton() {
  return (
    <button
      type="button"
      onClick={() => {
        throw new Error("Checkout failed: the card was declined");
      }}
    >
      Check out
    </button>
  );
}

/** An error while rendering: app/error.tsx shows it and reports it. */
export function BrokenCart() {
  const [items, setItems] = useState<string[] | undefined>(["socks"]);
  if (!items) throw new TypeError("Cannot read the cart: items is undefined");
  return (
    <button type="button" onClick={() => setItems(undefined)}>
      Empty the cart ({items.length})
    </button>
  );
}
