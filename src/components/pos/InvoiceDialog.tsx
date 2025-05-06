
import React, { useRef, useState } from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Invoice } from '@/types';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Printer, FileDown, X } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import { usePDF } from 'react-to-pdf';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useAppContext } from '@/context/AppContext';

interface InvoiceDialogProps {
  invoice: Invoice;
  onClose: () => void;
}

const InvoiceDialog = ({ invoice, onClose }: InvoiceDialogProps) => {
  const invoiceRef = useRef<HTMLDivElement>(null);
  const { toPDF, targetRef } = usePDF({
    filename: `invoice-${invoice.invoiceNumber}.pdf`,
  });
  const { clients } = useAppContext();
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const selectedClient = clients.find(client => client.id === selectedClientId);

  const handlePrint = () => {
    toast({
      title: "Print initiated",
      description: "Sending invoice to printer..."
    });
    window.print();
  };

  const handleExport = () => {
    toast({
      title: "Export initiated",
      description: "Exporting invoice to PDF..."
    });
    toPDF();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Invoice #{invoice.invoiceNumber}</DialogTitle>
        </DialogHeader>
        
        <div className="mb-4">
          <Label htmlFor="client-select">Select Client</Label>
          <Select value={selectedClientId} onValueChange={setSelectedClientId}>
            <SelectTrigger id="client-select" className="w-full">
              <SelectValue placeholder="Select a client" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">No client selected</SelectItem>
              {clients.map((client) => (
                <SelectItem key={client.id} value={client.id}>
                  {client.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div ref={targetRef} className="bg-white p-6 rounded">
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

          {selectedClient && (
            <div className="mb-6 p-4 border rounded">
              <h3 className="font-medium mb-1">Client Information:</h3>
              <p><span className="font-medium">Name:</span> {selectedClient.name}</p>
              <p><span className="font-medium">Phone:</span> {selectedClient.phone}</p>
              {selectedClient.email && <p><span className="font-medium">Email:</span> {selectedClient.email}</p>}
              {selectedClient.address && <p><span className="font-medium">Address:</span> {selectedClient.address}</p>}
            </div>
          )}

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
                    <td className="py-3 px-3 text-right">{formatCurrency(item.price)}</td>
                    <td className="py-3 px-3 text-right">{item.cartQuantity}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(item.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end mb-6">
            <div className="bg-muted p-4 rounded w-64">
              <div className="flex justify-between mb-2">
                <span className="font-medium">Subtotal:</span>
                <span>{formatCurrency(invoice.total)}</span>
              </div>
              <div className="flex justify-between mb-2">
                <span className="font-medium">Tax (0%):</span>
                <span>{formatCurrency(0)}</span>
              </div>
              <div className="flex justify-between font-bold text-lg">
                <span>Total:</span>
                <span>{formatCurrency(invoice.total)}</span>
              </div>
            </div>
          </div>

          <div className="text-sm text-muted-foreground text-center border-t pt-4">
            <p>Thank you for your business!</p>
            {selectedClient && <p>We appreciate your patronage, {selectedClient.name}!</p>}
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
