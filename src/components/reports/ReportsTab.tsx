
import React, { useState, useRef } from 'react';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useAppContext } from '@/context/AppContext';
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FileDown, BarChart, Check } from "lucide-react";
import { formatDate } from '@/lib/utils';
import InventoryValueReport from './InventoryValueReport';
import LowStockReport from './LowStockReport';
import { toast } from '@/components/ui/use-toast';
import { usePDF } from 'react-to-pdf';

const ReportsTab = () => {
  const { inventory } = useAppContext();
  
  const [reportType, setReportType] = useState<string>("inventory-value");
  const [fromDate, setFromDate] = useState<Date>(new Date());
  const [toDate, setToDate] = useState<Date>(new Date());
  const [exporting, setExporting] = useState(false);
  const { toPDF, targetRef } = usePDF({
    filename: `${reportType}-report-${formatDate(new Date()).replace(/,/g, '')}.pdf`,
  });
  
  const handleExportReport = async () => {
    setExporting(true);
    toast({
      title: "Export initiated",
      description: "Exporting report to PDF..."
    });
    
    try {
      await toPDF();
      toast({
        title: "Export completed",
        description: "Report has been exported successfully",
        icon: <Check className="h-4 w-4 text-green-500" />
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: "There was an error exporting the report",
        variant: "destructive"
      });
      console.error("PDF export error:", error);
    } finally {
      setExporting(false);
    }
  };

  const getReportTitle = () => {
    return reportType === 'inventory-value' ? 'Inventory Value Report' : 'Low Stock Items Report';
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-dental-dark">Reports</h2>
        <Button 
          onClick={handleExportReport} 
          disabled={exporting}
          className={exporting ? "opacity-70" : ""}
        >
          {exporting ? (
            <>
              <span className="animate-spin mr-2">⏳</span>
              Exporting...
            </>
          ) : (
            <>
              <FileDown className="mr-2 h-4 w-4" />
              Export Report
            </>
          )}
        </Button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-6">
        <div className="md:col-span-4">
          <label className="block text-sm font-medium mb-1">Report Type</label>
          <Select value={reportType} onValueChange={setReportType}>
            <SelectTrigger>
              <SelectValue placeholder="Select report type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inventory-value">Inventory Value</SelectItem>
              <SelectItem value="low-stock">Low Stock Items</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        <div className="md:col-span-4">
          <label className="block text-sm font-medium mb-1">From Date</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-start text-left font-normal"
              >
                {formatDate(fromDate)}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={fromDate}
                onSelect={(date) => setFromDate(date || new Date())}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>
        
        <div className="md:col-span-4">
          <label className="block text-sm font-medium mb-1">To Date</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-start text-left font-normal"
              >
                {formatDate(toDate)}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={toDate}
                onSelect={(date) => setToDate(date || new Date())}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      
      <div ref={targetRef} className="bg-white p-6 rounded-lg shadow">
        <div className="flex items-center justify-center mb-6">
          <BarChart className="h-6 w-6 mr-2 text-dental-primary" />
          <h3 className="text-lg font-medium">
            {getReportTitle()} ({formatDate(fromDate)} - {formatDate(toDate)})
          </h3>
        </div>
        
        {reportType === 'inventory-value' ? (
          <InventoryValueReport inventory={inventory} />
        ) : (
          <LowStockReport inventory={inventory} />
        )}
      </div>
    </div>
  );
};

export default ReportsTab;
