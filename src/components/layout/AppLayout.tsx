
import React, { useState, useEffect } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooth, ClipboardList, LineChart, Menu, Moon, Sun, Users, History } from "lucide-react";
import PosTab from '@/components/pos/PosTab';
import InventoryTab from '@/components/inventory/InventoryTab';
import ReportsTab from '@/components/reports/ReportsTab';
import ClientsTab from '@/components/clients/ClientsTab';
import InvoiceHistoryTab from '@/components/history/InvoiceHistoryTab';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';

const AppLayout = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { theme, setTheme } = useTheme();

  return (
    <div className={`min-h-screen ${theme === 'dark' ? 'dark' : ''} bg-dental-light dark:bg-gray-900 flex flex-col`}>
      {/* Header */}
      <header className="bg-sky-500 dark:bg-sky-700 text-white p-4 shadow-md">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Tooth size={24} className="text-white" />
            <h1 className="text-xl font-bebas tracking-wider">HONEST DENTAL POS EGYPT</h1>
          </div>
          <div className="flex items-center space-x-2">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="text-white hover:bg-sky-600 dark:hover:bg-sky-800"
            >
              {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </Button>
            <button 
              className="md:hidden" 
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            >
              <Menu size={24} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto p-4">
        <Tabs defaultValue="pos" className="w-full">
          <div className={`${isMobileMenuOpen ? 'block' : 'hidden'} md:block`}>
            <TabsList className="mb-6 w-full md:w-auto grid grid-cols-5 bg-white dark:bg-gray-800 shadow-sm">
              <TabsTrigger 
                value="pos"
                className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <Tooth className="mr-2 h-4 w-4" />
                <span>Point of Sale</span>
              </TabsTrigger>
              <TabsTrigger 
                value="inventory"
                className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <ClipboardList className="mr-2 h-4 w-4" />
                <span>Inventory</span>
              </TabsTrigger>
              <TabsTrigger 
                value="reports"
                className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <LineChart className="mr-2 h-4 w-4" />
                <span>Reports</span>
              </TabsTrigger>
              <TabsTrigger 
                value="clients"
                className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <Users className="mr-2 h-4 w-4" />
                <span>Clients</span>
              </TabsTrigger>
              <TabsTrigger 
                value="history"
                className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <History className="mr-2 h-4 w-4" />
                <span>History</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="bg-white dark:bg-gray-800 dark:text-white rounded-lg shadow-sm p-6">
            <TabsContent value="pos" className="mt-0">
              <PosTab />
            </TabsContent>
            <TabsContent value="inventory" className="mt-0">
              <InventoryTab />
            </TabsContent>
            <TabsContent value="reports" className="mt-0">
              <ReportsTab />
            </TabsContent>
            <TabsContent value="clients" className="mt-0">
              <ClientsTab />
            </TabsContent>
            <TabsContent value="history" className="mt-0">
              <InvoiceHistoryTab />
            </TabsContent>
          </div>
        </Tabs>
      </main>

      <footer className="bg-sky-700 dark:bg-sky-900 text-white p-3 text-center text-sm">
        <div className="container mx-auto">
          &copy; {new Date().getFullYear()} Honest Dental POS Egypt - All rights reserved
        </div>
      </footer>
    </div>
  );
};

export default AppLayout;
