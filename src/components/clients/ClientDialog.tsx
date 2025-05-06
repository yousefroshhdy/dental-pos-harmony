
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
import { v4 as uuidv4 } from 'uuid';

interface ClientDialogProps {
  client?: any;
  onClose: () => void;
}

const ClientDialog = ({ client, onClose }: ClientDialogProps) => {
  const isEditing = !!client;
  const { addClient, updateClient } = useAppContext();
  
  const [name, setName] = useState(client?.name || '');
  const [phone, setPhone] = useState(client?.phone || '');
  const [email, setEmail] = useState(client?.email || '');
  const [address, setAddress] = useState(client?.address || '');

  const handleSubmit = () => {
    const clientData = {
      id: client?.id || uuidv4(),
      name,
      phone,
      email,
      address,
    };

    if (isEditing) {
      updateClient(clientData);
    } else {
      addClient(clientData);
    }
    
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="dark:bg-gray-800">
        <DialogHeader>
          <DialogTitle className="dark:text-white">{isEditing ? 'Edit Client' : 'Add New Client'}</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="dark:text-gray-300">Name</Label>
            <Input
              id="name"
              placeholder="Client name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="phone" className="dark:text-gray-300">Phone</Label>
            <Input
              id="phone"
              placeholder="Phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="email" className="dark:text-gray-300">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="address" className="dark:text-gray-300">Address</Label>
            <Input
              id="address"
              placeholder="Client address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="dark:bg-gray-700 dark:text-white dark:border-gray-600"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="dark:border-gray-600 dark:text-white">Cancel</Button>
          <Button 
            onClick={handleSubmit}
            disabled={!name || !phone}
            className="bg-sky-500 hover:bg-sky-600 dark:bg-sky-600 dark:hover:bg-sky-700"
          >
            {isEditing ? 'Update Client' : 'Add Client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ClientDialog;
