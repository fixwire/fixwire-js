import { BrokenCart, CheckoutButton } from "./cart";

export default function Home() {
  return (
    <>
      <h1>Shop</h1>
      <p>Each of these fails in its own way; Fixwire gets every one.</p>
      <CheckoutButton />
      <BrokenCart />
    </>
  );
}
