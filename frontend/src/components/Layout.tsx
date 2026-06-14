import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

/** App shell: the lab-bench gradient, the left rail, and a scrolling main area. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-gradient min-h-screen">
      <div className="flex min-h-screen w-full">
        <Sidebar />
        <main className="min-w-0 flex-1 px-5 py-6 sm:px-8 lg:px-12 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
