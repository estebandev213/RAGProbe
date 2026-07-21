import type { ReactNode } from "react";
import { Footer } from "./Footer";
import { Sidebar } from "./Sidebar";

/** App shell: the lab-bench gradient, the left rail, and a scrolling main area. */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app-gradient min-h-screen">
      <div className="flex min-h-screen w-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-w-0 flex-1 px-5 pb-6 pt-10 sm:px-8 sm:pt-14 lg:px-12 lg:pb-8 lg:pt-20">
            {children}
          </main>
          <Footer />
        </div>
      </div>
    </div>
  );
}
