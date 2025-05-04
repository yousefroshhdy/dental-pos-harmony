
import React from 'react';
import { Product } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';

interface InventoryValueReportProps {
  inventory: Product[];
}

// Group items by type and sum their values
const calculateInventoryByType = (inventory: Product[]) => {
  const groupedData: Record<string, number> = {};
  
  inventory.forEach(item => {
    const value = item.price * item.quantity;
    if (groupedData[item.type]) {
      groupedData[item.type] += value;
    } else {
      groupedData[item.type] = value;
    }
  });
  
  return Object.entries(groupedData).map(([type, value]) => ({
    name: type,
    value: Math.round(value * 100) / 100
  }));
};

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

const InventoryValueReport = ({ inventory }: InventoryValueReportProps) => {
  const totalItems = inventory.reduce((sum, item) => sum + item.quantity, 0);
  const totalValue = inventory.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const averageItemValue = totalItems > 0 ? totalValue / totalItems : 0;
  
  const chartData = calculateInventoryByType(inventory);
  
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalItems}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Inventory Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">ج.م {totalValue.toFixed(2)}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Average Item Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">ج.م {averageItemValue.toFixed(2)}</div>
          </CardContent>
        </Card>
      </div>
      
      <div className="border rounded-lg p-4">
        <h4 className="text-sm font-medium mb-4">Inventory Value by Product Type</h4>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                labelLine={false}
                outerRadius={100}
                fill="#8884d8"
                dataKey="value"
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `ج.م ${value}`} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-muted">
            <tr>
              <th className="py-2 px-4 text-left text-sm font-medium">Product Type</th>
              <th className="py-2 px-4 text-left text-sm font-medium">Items</th>
              <th className="py-2 px-4 text-left text-sm font-medium">Total Value</th>
              <th className="py-2 px-4 text-left text-sm font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((item, index) => {
              const itemCount = inventory
                .filter(product => product.type === item.name)
                .reduce((sum, product) => sum + product.quantity, 0);
                
              const percentage = (item.value / totalValue * 100).toFixed(1);
              
              return (
                <tr key={index} className="border-b">
                  <td className="py-2 px-4">{item.name}</td>
                  <td className="py-2 px-4">{itemCount}</td>
                  <td className="py-2 px-4">ج.م {item.value.toFixed(2)}</td>
                  <td className="py-2 px-4">{percentage}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default InventoryValueReport;
