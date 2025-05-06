
import React, { useState } from 'react';
import { 
  Table, 
  TableHeader, 
  TableBody, 
  TableRow, 
  TableHead, 
  TableCell 
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ShoppingCart as CartIcon, Trash2, FileText, RotateCcw } from "lucide-react";
import { useAppContext } from '@/context/AppContext';
import InvoiceDialog from './InvoiceDialog';
import ReturnDialog from './ReturnDialog';
import { Invoice } from '@/types';

const ShoppingCart = () => {
  const { cart, removeFromCart, clearCart, createInvoice } = useAppContext();
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [currentInvoice, setCurrentInvoice] = useState<Invoice | null>(null);

  const total = cart.reduce((sum, item) => sum + item.subtotal, 0);
  
  const handleCreateInvoice = () => {
    const invoice = createInvoice();
    if (invoice) {
      setCurrentInvoice(invoice);
      setShowInvoiceDialog(true);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
      <div className="p-4 border-b dark:border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-lg flex items-center dark:text-white">
            <CartIcon className="mr-2 h-4 w-4" />
            Shopping Cart
          </h3>
          {cart.length > 0 && (
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => clearCart()}
              className="dark:border-gray-600 dark:text-white"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clear Cart
            </Button>
          )}
        </div>
        
        <div className="rounded border mb-4 dark:border-gray-700">
          <div className="max-h-[300px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-muted dark:bg-gray-900">
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Subtotal</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cart.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center h-24 dark:text-gray-300">
                      Cart is empty
                    </TableCell>
                  </TableRow>
                ) : (
                  cart.map(item => (
                    <TableRow key={item.id} className="dark:border-gray-700">
                      <TableCell>
                        <div>
                          <div className="font-medium dark:text-white">{item.type}</div>
                          <div className="text-xs text-muted-foreground dark:text-gray-400">{item.code} - {item.color}</div>
                        </div>
                      </TableCell>
                      <TableCell className="dark:text-gray-300">ج.م {item.price.toFixed(2)}</TableCell>
                      <TableCell className="dark:text-gray-300">{item.cartQuantity}</TableCell>
                      <TableCell className="dark:text-gray-300">ج.م {item.subtotal.toFixed(2)}</TableCell>
                      <TableCell>
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => removeFromCart(item.id)}
                          className="dark:text-gray-300 dark:hover:text-white"
                        >
                          <Trash2 className="h-4 w-4 text-dental-danger" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
        
        <div className="flex flex-col gap-4">
          <div className="flex justify-between items-center p-3 bg-muted dark:bg-gray-700 rounded">
            <span className="font-medium dark:text-white">Total Amount:</span>
            <span className="text-xl font-bold dark:text-white">ج.م {total.toFixed(2)}</span>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Button 
              onClick={handleCreateInvoice}
              disabled={cart.length === 0}
              className="bg-sky-500 hover:bg-sky-600 dark:bg-sky-600 dark:hover:bg-sky-700 text-white"
            >
              <FileText className="mr-2 h-4 w-4" />
              Create Invoice
            </Button>
            
            <Button 
              variant="outline" 
              onClick={() => setShowReturnDialog(true)}
              className="dark:border-gray-600 dark:text-white"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Process Return
            </Button>
          </div>
        </div>
      </div>

      {showInvoiceDialog && currentInvoice && (
        <InvoiceDialog 
          invoice={currentInvoice}
          onClose={() => setShowInvoiceDialog(false)}
        />
      )}
      
      {showReturnDialog && (
        <ReturnDialog
          onClose={() => setShowReturnDialog(false)}
        />
      )}
    </div>
  );
};

export default ShoppingCart;
