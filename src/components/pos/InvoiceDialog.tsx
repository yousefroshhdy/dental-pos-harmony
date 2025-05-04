
import React from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Invoice } from '@/types';
import { formatDate } from '@/lib/utils';
import { Printer, FileDown, X } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';

interface InvoiceDialogProps {
  invoice: Invoice;
  onClose: () => void;
}

const InvoiceDialog = ({ invoice, onClose }: InvoiceDialogProps) => {
  const handlePrint = () => {
    toast({
      title: "Print initiated",
      description: "Sending invoice to printer..."
    });
    // In a real app, we would implement actual printing functionality here
  };

  const handleExport = () => {
    toast({
      title: "Export initiated",
      description: "Exporting invoice to PDF..."
    });
    // In a real app, we would implement PDF export functionality here
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Invoice #{invoice.invoiceNumber}</DialogTitle>
        </DialogHeader>
        
        <div className="bg-white p-6 rounded">
          <div className="flex justify-between items-start mb-8">
            <div>
              <h2 className="text-2xl font-bold text-dental-primary mb-1">DENTAL EQUIPMENT INVOICE</h2>
              <p className="text-sm text-muted-foreground">Your trusted dental equipment provider</p>
            </div>
            <div className="text-right">
              <p className="font-medium">Invoice #{invoice.invoiceNumber}</p>
              <p className="text-sm text-muted-foreground">
                Date: {formatDate(new Date(invoice.date))}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto mb-6">
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="border-b">
                  <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">CODE</th>
                  <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">PRODUCT</th>
                  <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">COLOR</th>
                  <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">PRICE</th>
                  <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">QTY</th>
                  <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">SUBTOTAL</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item, index) => (
                  <tr key={index} className="border-b">
                    <td className="py-3 px-3">{item.code}</td>
                    <td className="py-3 px-3">{item.type}</td>
                    <td className="py-3 px-3">{item.color}</td>
                    <td className="py-3 px-3 text-right">ج.م {item.price.toFixed(2)}</td>
                    <td className="py-3 px-3 text-right">{item.cartQuantity}</td>
                    <td className="py-3 px-3 text-right">ج.م {item.subtotal.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end mb-6">
            <div className="bg-muted p-4 rounded w-64">
              <div className="flex justify-between mb-2">
                <span className="font-medium">Subtotal:</span>
                <span>ج.م {invoice.total.toFixed(2)}</span>
              </div>
              <div className="flex justify-between mb-2">
                <span className="font-medium">Tax (0%):</span>
                <span>ج.م 0.00</span>
              </div>
              <div className="flex justify-between font-bold text-lg">
                <span>Total:</span>
                <span>ج.م {invoice.total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div className="text-sm text-muted-foreground text-center border-t pt-4">
            <p>Thank you for your business!</p>
          </div>
        </div>

        <DialogFooter>
          <div className="flex gap-2 w-full justify-between">
            <Button variant="outline" onClick={onClose}>
              <X className="mr-2 h-4 w-4" />
              Close
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handlePrint}>
                <Printer className="mr-2 h-4 w-4" />
                Print
              </Button>
              <Button onClick={handleExport}>
                <FileDown className="mr-2 h-4 w-4" />
                Export PDF
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default InvoiceDialog;
