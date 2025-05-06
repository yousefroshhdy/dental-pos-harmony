
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
import { Edit, Trash2 } from "lucide-react";
import { useAppContext } from '@/context/AppContext';
import ClientDialog from './ClientDialog';
import DeleteClientDialog from './DeleteClientDialog';

interface ClientsListProps {
  searchTerm: string;
}

const ClientsList = ({ searchTerm }: ClientsListProps) => {
  const { clients } = useAppContext();
  const [selectedClient, setSelectedClient] = useState<any>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const filteredClients = clients.filter(client => 
    client.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    client.phone.includes(searchTerm) ||
    client.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleEdit = (client: any) => {
    setSelectedClient(client);
    setShowEditDialog(true);
  };

  const handleDelete = (client: any) => {
    setSelectedClient(client);
    setShowDeleteDialog(true);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
      <div className="rounded border dark:border-gray-700">
        <div className="max-h-[500px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-muted dark:bg-gray-900">
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Address</TableHead>
                <TableHead className="w-[120px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredClients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center h-24 dark:text-gray-300">
                    No clients found
                  </TableCell>
                </TableRow>
              ) : (
                filteredClients.map(client => (
                  <TableRow key={client.id} className="dark:border-gray-700">
                    <TableCell className="font-medium dark:text-white">{client.name}</TableCell>
                    <TableCell className="dark:text-gray-300">{client.phone}</TableCell>
                    <TableCell className="dark:text-gray-300">{client.email}</TableCell>
                    <TableCell className="dark:text-gray-300">{client.address}</TableCell>
                    <TableCell>
                      <div className="flex space-x-2">
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => handleEdit(client)}
                          className="dark:text-gray-300 dark:hover:text-white"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => handleDelete(client)}
                          className="text-dental-danger"
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
      </div>
      
      {showEditDialog && selectedClient && (
        <ClientDialog 
          client={selectedClient}
          onClose={() => setShowEditDialog(false)}
        />
      )}
      
      {showDeleteDialog && selectedClient && (
        <DeleteClientDialog 
          client={selectedClient}
          onClose={() => setShowDeleteDialog(false)}
        />
      )}
    </div>
  );
};

export default ClientsList;
