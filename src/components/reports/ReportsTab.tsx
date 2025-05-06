
import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import InventoryValueReport from './InventoryValueReport';
import LowStockReport from './LowStockReport';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileDown, Search } from 'lucide-react';
import { useAppContext } from '@/context/AppContext';
import { formatCurrency } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { usePDF } from 'react-to-pdf';

const ReportsTab = () => {
  const { inventory, invoices } = useAppContext();
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [reportLoading, setReportLoading] = useState(false);
  const { toPDF, targetRef } = usePDF({
    filename: 'sales-report.pdf',
  });
  
  // Calculate total inventory value
  const totalInventoryValue = inventory.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  
  // Filter invoices by date range
  const getFilteredInvoices = () => {
    if (!startDate && !endDate) return invoices;
    
    return invoices.filter(invoice => {
      const invoiceDate = new Date(invoice.date);
      const start = startDate ? new Date(startDate) : new Date(0);
      const end = endDate ? new Date(endDate) : new Date();
      
      // Set end date to end of day
      end.setHours(23, 59, 59, 999);
      
      return invoiceDate >= start && invoiceDate <= end;
    });
  };
  
  // Calculate total sales
  const filteredInvoices = getFilteredInvoices();
  const totalSales = filteredInvoices.reduce((sum, invoice) => sum + invoice.total, 0);
  
  // Generate and download report
  const handleGenerateReport = async () => {
    try {
      setReportLoading(true);
      await toPDF();
      toast({
        title: "Report Generated",
        description: "Sales report has been downloaded successfully."
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to generate report. Please try again.",
        variant: "destructive"
      });
      console.error("PDF generation error:", error);
    } finally {
      setReportLoading(false);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-dental-dark dark:text-white font-bebas tracking-wider mb-6">REPORTS & ANALYTICS</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <Card className="dark:bg-gray-800 dark:text-white dark:border-gray-700">
          <CardHeader>
            <CardTitle>Total Inventory Value</CardTitle>
            <CardDescription className="dark:text-gray-400">Current value of all stock</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-sky-500 dark:text-sky-400">{formatCurrency(totalInventoryValue)}</p>
          </CardContent>
        </Card>
        
        <Card className="dark:bg-gray-800 dark:text-white dark:border-gray-700">
          <CardHeader>
            <CardTitle>Low Stock Items</CardTitle>
            <CardDescription className="dark:text-gray-400">Items that need reordering</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-amber-500">
              {inventory.filter(item => item.quantity < 5).length} items
            </p>
          </CardContent>
        </Card>
      </div>
      
      <div ref={targetRef}>
        <Card className="mb-6 dark:bg-gray-800 dark:text-white dark:border-gray-700">
          <CardHeader>
            <CardTitle>Sales Report</CardTitle>
            <CardDescription className="dark:text-gray-400">
              {startDate && endDate ? 
                `Sales from ${new Date(startDate).toLocaleDateString()} to ${new Date(endDate).toLocaleDateString()}` : 
                'All time sales data'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
              <div className="space-y-2">
                <Label htmlFor="startDate" className="dark:text-gray-300">Start Date</Label>
                <Input 
                  id="startDate" 
                  type="date" 
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate" className="dark:text-gray-300">End Date</Label>
                <Input 
                  id="endDate" 
                  type="date" 
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
                />
              </div>
              <div className="flex items-end">
                <Button 
                  onClick={handleGenerateReport}
                  disabled={reportLoading}
                  className="bg-sky-500 hover:bg-sky-600 dark:bg-sky-600 dark:hover:bg-sky-700 w-full"
                >
                  <FileDown className="mr-2 h-4 w-4" />
                  {reportLoading ? "Generating..." : "Export Report"}
                </Button>
              </div>
            </div>
            
            <div className="bg-muted dark:bg-gray-700 p-6 rounded-lg">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h3 className="text-lg font-medium mb-1 dark:text-white">Total Sales</h3>
                  <p className="text-3xl font-bold text-sky-500 dark:text-sky-400">{formatCurrency(totalSales)}</p>
                </div>
                <div>
                  <h3 className="text-lg font-medium mb-1 dark:text-white">Invoices</h3>
                  <p className="text-3xl font-bold text-sky-500 dark:text-sky-400">{filteredInvoices.length}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      <Tabs defaultValue="inventory">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger 
            value="inventory"
            className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
          >
            Inventory Report
          </TabsTrigger>
          <TabsTrigger 
            value="low-stock"
            className="data-[state=active]:bg-sky-500 data-[state=active]:text-white"
          >
            Low Stock Report
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inventory">
          <InventoryValueReport />
        </TabsContent>
        <TabsContent value="low-stock">
          <LowStockReport />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ReportsTab;
