
import React, { useState } from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Product } from '@/types';
import { useAppContext } from '@/context/AppContext';

interface QuantityDialogProps {
  product: Product;
  onClose: () => void;
}

const QuantityDialog = ({ product, onClose }: QuantityDialogProps) => {
  const { updateInventoryItem } = useAppContext();
  const [quantity, setQuantity] = useState(product.quantity);

  const handleSubmit = () => {
    updateInventoryItem({
      ...product,
      quantity
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Quantity</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <div className="mb-4">
            <h3 className="font-medium">{product.type} - {product.color}</h3>
            <p className="text-sm text-muted-foreground">Code: {product.code}</p>
            <p className="text-sm text-muted-foreground">Current quantity: {product.quantity}</p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="quantity">New Quantity</Label>
            <Input
              id="quantity"
              type="number"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit}>Update Quantity</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default QuantityDialog;
