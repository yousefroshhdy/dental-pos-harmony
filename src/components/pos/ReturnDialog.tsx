
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
import { useAppContext } from '@/context/AppContext';

interface ReturnDialogProps {
  onClose: () => void;
}

const ReturnDialog = ({ onClose }: ReturnDialogProps) => {
  const [productCode, setProductCode] = useState('');
  const [quantity, setQuantity] = useState(1);
  const { processReturn } = useAppContext();

  const handleSubmit = () => {
    processReturn(productCode, quantity);
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Process Return</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="productCode">Product Code</Label>
            <Input
              id="productCode"
              placeholder="Enter product code"
              value={productCode}
              onChange={(e) => setProductCode(e.target.value)}
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="quantity">Return Quantity</Label>
            <Input
              id="quantity"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value))}
              min={1}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={handleSubmit}
            disabled={!productCode || quantity < 1}
          >
            Process Return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ReturnDialog;
