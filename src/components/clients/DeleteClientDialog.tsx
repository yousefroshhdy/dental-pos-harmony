
import React from 'react';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/context/AppContext';

interface DeleteClientDialogProps {
  client: any;
  onClose: () => void;
}

const DeleteClientDialog = ({ client, onClose }: DeleteClientDialogProps) => {
  const { removeClient } = useAppContext();

  const handleDelete = () => {
    removeClient(client.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="dark:bg-gray-800">
        <DialogHeader>
          <DialogTitle className="dark:text-white">Delete Client</DialogTitle>
          <DialogDescription className="dark:text-gray-400">
            Are you sure you want to delete the client "{client.name}"? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="dark:border-gray-600 dark:text-white">Cancel</Button>
          <Button 
            variant="destructive"
            onClick={handleDelete}
          >
            Delete Client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteClientDialog;
