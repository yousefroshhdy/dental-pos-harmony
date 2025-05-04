
import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Stethoscope, ClipboardList, LineChart, Menu } from "lucide-react";
import PosTab from '@/components/pos/PosTab';
import InventoryTab from '@/components/inventory/InventoryTab';
import ReportsTab from '@/components/reports/ReportsTab';

const AppLayout = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-dental-light flex flex-col">
      {/* Header */}
      <header className="bg-dental-primary text-white p-4 shadow-md">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Stethoscope size={24} className="text-white" />
            <h1 className="text-xl font-bold">Dental POS Egypt</h1>
          </div>
          <button 
            className="md:hidden" 
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            <Menu size={24} />
          </button>
        </div>
      </header>

      <main className="flex-1 container mx-auto p-4">
        <Tabs defaultValue="pos" className="w-full">
          <div className={`${isMobileMenuOpen ? 'block' : 'hidden'} md:block`}>
            <TabsList className="mb-6 w-full md:w-auto grid grid-cols-3 bg-white shadow-sm">
              <TabsTrigger 
                value="pos"
                className="data-[state=active]:bg-dental-primary data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <Stethoscope className="mr-2 h-4 w-4" />
                <span>Point of Sale</span>
              </TabsTrigger>
              <TabsTrigger 
                value="inventory"
                className="data-[state=active]:bg-dental-primary data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <ClipboardList className="mr-2 h-4 w-4" />
                <span>Inventory</span>
              </TabsTrigger>
              <TabsTrigger 
                value="reports"
                className="data-[state=active]:bg-dental-primary data-[state=active]:text-white"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                <LineChart className="mr-2 h-4 w-4" />
                <span>Reports</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="bg-white rounded-lg shadow-sm p-6">
            <TabsContent value="pos" className="mt-0">
              <PosTab />
            </TabsContent>
            <TabsContent value="inventory" className="mt-0">
              <InventoryTab />
            </TabsContent>
            <TabsContent value="reports" className="mt-0">
              <ReportsTab />
            </TabsContent>
          </div>
        </Tabs>
      </main>

      <footer className="bg-dental-secondary text-white p-3 text-center text-sm">
        <div className="container mx-auto">
          &copy; {new Date().getFullYear()} Dental POS Egypt - All rights reserved
        </div>
      </footer>
    </div>
  );
};

export default AppLayout;
