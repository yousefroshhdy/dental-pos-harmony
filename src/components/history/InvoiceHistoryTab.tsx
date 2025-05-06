
import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, RefreshCw, FileDown } from "lucide-react";
import { 
  Table, 
  TableHeader, 
  TableBody, 
  TableRow, 
  TableHead, 
  TableCell 
} from "@/components/ui/table";
import { useAppContext } from '@/context/AppContext';
import { formatDate, formatCurrency } from '@/lib/utils';
import InvoiceDialog from '../pos/InvoiceDialog';
import RefundDialog from './RefundDialog';

const InvoiceHistoryTab = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [showRefundDialog, setShowRefundDialog] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const { invoices } = useAppContext();

  const filteredInvoices = invoices.filter(invoice => 
    invoice.invoiceNumber.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleViewInvoice = (invoice: any) => {
    setSelectedInvoice(invoice);
    setShowInvoiceDialog(true);
  };
  
  const handleRefund = (invoice: any) => {
    setSelectedInvoice(invoice);
    setShowRefundDialog(true);
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold font-bebas tracking-wider text-dental-dark dark:text-white">INVOICE HISTORY</h2>
      </div>
      
      <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow mb-6 grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="relative md:col-span-11">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search invoices by number..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 dark:bg-gray-700 dark:text-white dark:border-gray-600"
          />
        </div>
        
        <div className="md:col-span-1">
          <Button 
            variant="outline" 
            className="w-full h-10 dark:border-gray-600 dark:text-white"
            onClick={() => setSearchTerm('')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
        <div className="rounded border dark:border-gray-700">
          <div className="max-h-[500px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-muted dark:bg-gray-900">
                <TableRow>
                  <TableHead>Invoice No.</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead className="w-[140px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInvoices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center h-24 dark:text-gray-300">
                      No invoices found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredInvoices.map(invoice => (
                    <TableRow key={invoice.invoiceNumber} className="dark:border-gray-700">
                      <TableCell className="font-medium dark:text-white">{invoice.invoiceNumber}</TableCell>
                      <TableCell className="dark:text-gray-300">{formatDate(new Date(invoice.date))}</TableCell>
                      <TableCell className="dark:text-gray-300">{invoice.items.length}</TableCell>
                      <TableCell className="dark:text-gray-300">{formatCurrency(invoice.total)}</TableCell>
                      <TableCell>
                        <div className="flex space-x-2">
                          <Button 
                            size="sm"
                            variant="outline"
                            onClick={() => handleViewInvoice(invoice)}
                            className="dark:border-gray-600 dark:text-white"
                          >
                            <FileDown className="mr-1 h-4 w-4" />
                            View
                          </Button>
                          <Button 
                            size="sm"
                            variant="outline"
                            onClick={() => handleRefund(invoice)}
                            className="dark:border-gray-600 dark:text-white"
                          >
                            Refund
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {showInvoiceDialog && selectedInvoice && (
        <InvoiceDialog 
          invoice={selectedInvoice}
          onClose={() => setShowInvoiceDialog(false)}
        />
      )}
      
      {showRefundDialog && selectedInvoice && (
        <RefundDialog 
          invoice={selectedInvoice}
          onClose={() => setShowRefundDialog(false)}
        />
      )}
    </div>
  );
};

export default InvoiceHistoryTab;
