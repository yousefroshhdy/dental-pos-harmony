
import React, { useState } from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { 
  Table, 
  TableHeader, 
  TableBody, 
  TableRow, 
  TableHead, 
  TableCell 
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from '@/lib/utils';
import { useAppContext } from '@/context/AppContext';

interface RefundDialogProps {
  invoice: any;
  onClose: () => void;
}

const RefundDialog = ({ invoice, onClose }: RefundDialogProps) => {
  const { processReturn } = useAppContext();
  const [selectedItems, setSelectedItems] = useState<string[]>([]);

  const handleToggleItem = (id: string) => {
    setSelectedItems(prev => 
      prev.includes(id) 
        ? prev.filter(itemId => itemId !== id) 
        : [...prev, id]
    );
  };

  const handleRefund = () => {
    // Process each selected item as a return
    for (const id of selectedItems) {
      const item = invoice.items.find((i: any) => i.id === id);
      if (item) {
        processReturn(item.code, item.cartQuantity);
      }
    }
    onClose();
  };

  const selectedTotal = invoice.items
    .filter((item: any) => selectedItems.includes(item.id))
    .reduce((sum: number, item: any) => sum + item.subtotal, 0);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl dark:bg-gray-800">
        <DialogHeader>
          <DialogTitle className="dark:text-white">Process Refund for Invoice #{invoice.invoiceNumber}</DialogTitle>
          <DialogDescription className="dark:text-gray-400">
            Select items to refund. The items will be returned to inventory.
          </DialogDescription>
        </DialogHeader>
        
        <div className="py-4">
          <div className="rounded border dark:border-gray-700 mb-4">
            <div className="max-h-[300px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-muted dark:bg-gray-900">
                  <TableRow>
                    <TableHead className="w-[50px]"></TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>Subtotal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.items.map((item: any) => (
                    <TableRow key={item.id} className="dark:border-gray-700">
                      <TableCell>
                        <Checkbox 
                          checked={selectedItems.includes(item.id)}
                          onCheckedChange={() => handleToggleItem(item.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium dark:text-white">{item.type}</div>
                          <div className="text-xs text-muted-foreground dark:text-gray-400">{item.code} - {item.color}</div>
                        </div>
                      </TableCell>
                      <TableCell className="dark:text-gray-300">{formatCurrency(item.price)}</TableCell>
                      <TableCell className="dark:text-gray-300">{item.cartQuantity}</TableCell>
                      <TableCell className="dark:text-gray-300">{formatCurrency(item.subtotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
          
          <div className="flex justify-end">
            <div className="bg-muted dark:bg-gray-700 p-4 rounded w-64">
              <div className="flex justify-between font-bold text-lg dark:text-white">
                <span>Refund Total:</span>
                <span>{formatCurrency(selectedTotal)}</span>
              </div>
            </div>
          </div>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="dark:border-gray-600 dark:text-white">Cancel</Button>
          <Button 
            onClick={handleRefund}
            disabled={selectedItems.length === 0}
            variant="destructive"
          >
            Process Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RefundDialog;
