
import React, { useState } from 'react';
import { 
  Input 
} from "@/components/ui/input";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useAppContext } from '@/context/AppContext';
import { Search, Plus, RefreshCw } from 'lucide-react';
import InventoryTable from './InventoryTable';
import ProductDialog from './ProductDialog';

const InventoryTab = () => {
  const { inventory, filter, setFilter, resetFilter } = useAppContext();
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Get unique product types and colors for filters
  const productTypes = ['All', ...new Set(inventory.map(item => item.type))];
  const productColors = ['All', ...new Set(inventory.map(item => item.color))];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-dental-dark">Inventory Management</h2>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add New Product
        </Button>
      </div>
      
      <div className="bg-white p-4 rounded-lg shadow mb-6 grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="relative md:col-span-5">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search inventory..."
            value={filter.searchTerm}
            onChange={(e) => setFilter({ searchTerm: e.target.value })}
            className="pl-8"
          />
        </div>
        
        <div className="md:col-span-3">
          <Select 
            value={filter.type} 
            onValueChange={(value) => setFilter({ type: value })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Filter by Type" />
            </SelectTrigger>
            <SelectContent>
              {productTypes.map(type => (
                <SelectItem key={type} value={type}>{type}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="md:col-span-3">
          <Select 
            value={filter.color} 
            onValueChange={(value) => setFilter({ color: value })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Filter by Color" />
            </SelectTrigger>
            <SelectContent>
              {productColors.map(color => (
                <SelectItem key={color} value={color}>{color}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="md:col-span-1">
          <Button 
            variant="outline" 
            className="w-full h-10"
            onClick={resetFilter}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <InventoryTable />
      
      {showAddDialog && (
        <ProductDialog 
          onClose={() => setShowAddDialog(false)} 
        />
      )}
    </div>
  );
};

export default InventoryTab;
