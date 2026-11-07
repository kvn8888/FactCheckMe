import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate";
import { BottomNav } from "@/components/BottomNav";
import Monitor from "./pages/Monitor";
import History from "./pages/History";
import Stats from "./pages/Stats";
import NotFound from "./pages/NotFound";

const App = () => (
  <TooltipProvider>
    <Toaster />
    <Sonner />
    <AuthGate>
    <BrowserRouter>
      <div className="min-h-screen bg-background">
        <main className="h-[calc(100vh-64px)]">
          <Routes>
            <Route path="/" element={<Monitor />} />
            <Route path="/history" element={<History />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
        <BottomNav />
      </div>
    </BrowserRouter>
    </AuthGate>
  </TooltipProvider>
);

export default App;
