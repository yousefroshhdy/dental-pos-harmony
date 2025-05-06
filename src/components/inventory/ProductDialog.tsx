
import React, { useState, useEffect } from 'react';
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
import { v4 as uuidv4 } from 'uuid';

interface ProductDialogProps {
  product?: Product;
  onClose: () => void;
}

const ProductDialog = ({ product, onClose }: ProductDialogProps) => {
  const isEditing = !!product;
  const { addToInventory, updateInventoryItem } = useAppContext();
  
  const [formData, setFormData] = useState({
    code: '',
    type: '',
    color: '',
    price: 0,
    quantity: 0,
  });

  useEffect(() => {
    if (product) {
      setFormData({
        code: product.code,
        type: product.type,
        color: product.color,
        price: product.price,
        quantity: product.quantity
      });
    }
  }, [product]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    
    // Handle numeric fields
    if (name === 'price' || name === 'quantity') {
      setFormData({
        ...formData,
        [name]: value === '' ? 0 : Number(value)
      });
    } else {
      setFormData({
        ...formData,
        [name]: value
      });
    }
  };

  const handleSubmit = () => {
    if (isEditing && product) {
      updateInventoryItem({
        ...product,
        ...formData
      });
    } else {
      addToInventory({
        id: uuidv4(),
        ...formData
      });
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Product' : 'Add New Product'}</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">Product Code</Label>
            <Input
              id="code"
              name="code"
              placeholder="Enter product code"
              value={formData.code}
              onChange={handleChange}
              disabled={isEditing} // Don't allow editing code for existing products
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="type">Product Type</Label>
            <Input
              id="type"
              name="type"
              placeholder="Enter product type"
              value={formData.type}
              onChange={handleChange}
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="color">Color</Label>
            <Input
              id="color"
              name="color"
              placeholder="Enter product color"
              value={formData.color}
              onChange={handleChange}
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="price">Price (ج.م)</Label>
            <Input
              id="price"
              name="price"
              type="number"
              min="0"
              step="0.01"
              placeholder="Enter price"
              value={formData.price}
              onChange={handleChange}
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              name="quantity"
              type="number"
              min="0"
              placeholder="Enter quantity"
              value={formData.quantity}
              onChange={handleChange}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button 
            onClick={handleSubmit}
            disabled={!formData.code || !formData.type || !formData.color}
          >
            {isEditing ? 'Update' : 'Add'} Product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ProductDialog;
