
import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, RefreshCw } from "lucide-react";
import ClientsList from './ClientsList';
import ClientDialog from './ClientDialog';
import { useAppContext } from '@/context/AppContext';

const ClientsTab = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const { clients } = useAppContext();

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold font-bebas tracking-wider text-dental-dark dark:text-white">CLIENT MANAGEMENT</h2>
        <Button 
          onClick={() => setShowAddDialog(true)}
          className="bg-sky-500 hover:bg-sky-600 dark:bg-sky-600 dark:hover:bg-sky-700"
        >
          <Plus className="mr-2 h-4 w-4" />
          Add New Client
        </Button>
      </div>
      
      <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow mb-6 grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="relative md:col-span-11">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search clients by name, phone or email..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 dark:bg-gray-700 dark:text-white dark:border-gray-600"
          />
        </div>
        
        <div className="md:col-span-1">
          <Button 
            variant="outline" 
            className="w-full h-10 dark:border-gray-600 dark:text-white"
            onClick={() => setSearchTerm('')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      <ClientsList searchTerm={searchTerm} />
      
      {showAddDialog && (
        <ClientDialog 
          onClose={() => setShowAddDialog(false)} 
        />
      )}
    </div>
  );
};

export default ClientsTab;
