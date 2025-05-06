
import React from 'react';
import { Product } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle } from 'lucide-react';

interface LowStockReportProps {
  inventory: Product[];
}

// Define threshold for low stock
const LOW_STOCK_THRESHOLD = 5;

const LowStockReport = ({ inventory }: LowStockReportProps) => {
  const lowStockItems = inventory.filter(item => item.quantity <= LOW_STOCK_THRESHOLD);
  const criticalItems = inventory.filter(item => item.quantity <= 2);
  const lowStockPercentage = inventory.length > 0 
    ? (lowStockItems.length / inventory.length * 100).toFixed(1) 
    : '0';
  
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Low Stock Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{lowStockItems.length}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Critical Stock Items (≤ 2)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-dental-danger">{criticalItems.length}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              % of Low Stock Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{lowStockPercentage}%</div>
          </CardContent>
        </Card>
      </div>
      
      <div className="border rounded-lg p-4">
        <h4 className="text-sm font-medium mb-4">Low Stock Items List</h4>
        
        {lowStockItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <p>No low stock items found!</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="py-2 px-4 text-left text-sm font-medium">Code</th>
                  <th className="py-2 px-4 text-left text-sm font-medium">Type</th>
                  <th className="py-2 px-4 text-left text-sm font-medium">Color</th>
                  <th className="py-2 px-4 text-left text-sm font-medium">Price</th>
                  <th className="py-2 px-4 text-left text-sm font-medium">Quantity</th>
                  <th className="py-2 px-4 text-left text-sm font-medium">Value</th>
                  <th className="py-2 px-4 text-left text-sm font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {lowStockItems
                  .sort((a, b) => a.quantity - b.quantity)
                  .map((item) => {
                    const value = item.price * item.quantity;
                    const isCritical = item.quantity <= 2;
                    
                    return (
                      <tr key={item.id} className="border-b">
                        <td className="py-2 px-4">{item.code}</td>
                        <td className="py-2 px-4">{item.type}</td>
                        <td className="py-2 px-4">{item.color}</td>
                        <td className="py-2 px-4">ج.م {item.price.toFixed(2)}</td>
                        <td className={`py-2 px-4 font-medium ${isCritical ? 'text-dental-danger' : ''}`}>
                          {item.quantity}
                        </td>
                        <td className="py-2 px-4">ج.م {value.toFixed(2)}</td>
                        <td className="py-2 px-4">
                          {isCritical ? (
                            <div className="flex items-center text-dental-danger font-medium">
                              <AlertTriangle className="h-4 w-4 mr-1" />
                              Critical
                            </div>
                          ) : (
                            <span className="text-orange-500">Low</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="text-sm font-medium text-dental-primary mb-2">Reorder Recommendations</h4>
        <p className="text-sm text-muted-foreground mb-4">
          Based on your inventory levels, we recommend reordering the following items:
        </p>
        
        <ul className="space-y-2">
          {criticalItems.map(item => (
            <li key={item.id} className="text-sm">
              • <span className="font-medium">{item.type} ({item.code})</span>: 
              Reorder at least {10 - item.quantity} units
            </li>
          ))}
          {criticalItems.length === 0 && (
            <li className="text-sm">No critical items to reorder at this time.</li>
          )}
        </ul>
      </div>
    </div>
  );
};

export default LowStockReport;
