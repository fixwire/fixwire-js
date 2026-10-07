import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fixwire with Next.js",
  description: "Errors from the server, the edge and the browser, reported to Fixwire",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Shop</Link>
          <Link href="/users/1">User 1</Link>
          <Link href="/users/crash">A page that fails</Link>
          <a href="/api/orders/7">An API route that fails</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
