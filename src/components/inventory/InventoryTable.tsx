
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
import { Pencil, Trash2, AlertTriangle } from "lucide-react";
import { useAppContext } from '@/context/AppContext';
import { Product } from '@/types';
import ProductDialog from './ProductDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import QuantityDialog from './QuantityDialog';

const InventoryTable = () => {
  const { inventory, filter } = useAppContext();
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [deleteProduct, setDeleteProduct] = useState<Product | null>(null);
  const [quantityProduct, setQuantityProduct] = useState<Product | null>(null);

  // Apply filters
  const filteredInventory = inventory.filter(product => {
    const matchesSearch = filter.searchTerm ? 
      product.code.toLowerCase().includes(filter.searchTerm.toLowerCase()) || 
      product.type.toLowerCase().includes(filter.searchTerm.toLowerCase()) || 
      product.color.toLowerCase().includes(filter.searchTerm.toLowerCase()) 
      : true;
      
    const matchesType = filter.type === 'All' ? true : product.type === filter.type;
    const matchesColor = filter.color === 'All' ? true : product.color === filter.color;
    
    return matchesSearch && matchesType && matchesColor;
  });

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      <div className="max-h-[600px] overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-muted z-10">
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Color</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredInventory.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center h-24">
                  No products found
                </TableCell>
              </TableRow>
            ) : (
              filteredInventory.map(product => (
                <TableRow key={product.id} className={product.quantity <= 3 ? "bg-red-50" : ""}>
                  <TableCell>{product.code}</TableCell>
                  <TableCell>{product.type}</TableCell>
                  <TableCell>{product.color}</TableCell>
                  <TableCell>ج.م {product.price.toFixed(2)}</TableCell>
                  <TableCell>
                    <div className="flex items-center">
                      <span className={product.quantity <= 3 ? "text-dental-danger font-medium" : ""}>
                        {product.quantity}
                      </span>
                      {product.quantity <= 3 && (
                        <AlertTriangle className="h-4 w-4 text-dental-danger ml-2" />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setEditProduct(product)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="outline"
                        size="sm"
                        onClick={() => setQuantityProduct(product)}
                      >
                        Update Qty
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setDeleteProduct(product)}
                        className="text-dental-danger border-dental-danger hover:bg-dental-danger/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      
      {editProduct && (
        <ProductDialog 
          product={editProduct}
          onClose={() => setEditProduct(null)}
        />
      )}
      
      {deleteProduct && (
        <DeleteConfirmDialog
          product={deleteProduct}
          onClose={() => setDeleteProduct(null)}
        />
      )}
      
      {quantityProduct && (
        <QuantityDialog
          product={quantityProduct}
          onClose={() => setQuantityProduct(null)}
        />
      )}
    </div>
  );
};

export default InventoryTable;
