
import React, { useState } from 'react';
import { 
  Table, 
  TableHeader, 
  TableBody, 
  TableRow, 
  TableHead, 
  TableCell 
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus } from "lucide-react";
import { useAppContext } from '@/context/AppContext';
import QuantityDialog from './QuantityDialog';

const ProductList = () => {
  const { inventory } = useAppContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [showDialog, setShowDialog] = useState(false);

  const filteredProducts = inventory.filter(product => 
    product.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
    product.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    product.color.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleAddToCart = (product: any) => {
    setSelectedProduct(product);
    setShowDialog(true);
  };

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-4 border-b">
        <h3 className="font-medium text-lg mb-4">Product Selection</h3>
        
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
        </div>
        
        <div className="rounded border">
          <div className="max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-muted">
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead className="w-[80px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center h-24">
                      No products found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProducts.map(product => (
                    <TableRow key={product.id}>
                      <TableCell>{product.code}</TableCell>
                      <TableCell>{product.type}</TableCell>
                      <TableCell>{product.color}</TableCell>
                      <TableCell>ج.م {product.price.toFixed(2)}</TableCell>
                      <TableCell className={product.quantity <= 0 ? "text-dental-danger" : ""}>
                        {product.quantity}
                      </TableCell>
                      <TableCell>
                        <Button 
                          size="sm"
                          onClick={() => handleAddToCart(product)}
                          disabled={product.quantity <= 0}
                        >
                          <Plus size={16} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {showDialog && selectedProduct && (
        <QuantityDialog
          product={selectedProduct}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
};

export default ProductList;
