
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
  const [quantity, setQuantity] = useState(1);
  const { addToCart } = useAppContext();

  const handleSubmit = () => {
    addToCart(product, quantity);
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Cart</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <div className="mb-4">
            <h3 className="font-medium">{product.type} - {product.color}</h3>
            <p className="text-sm text-muted-foreground">Code: {product.code}</p>
            <p className="text-sm text-muted-foreground">Price: ${product.price.toFixed(2)}</p>
            <p className="text-sm text-muted-foreground">Available: {product.quantity}</p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Math.min(parseInt(e.target.value), product.quantity))}
              min={1}
              max={product.quantity}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit}>Add to Cart</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default QuantityDialog;
