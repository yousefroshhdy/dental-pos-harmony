
import React from 'react';
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Product } from '@/types';
import { useAppContext } from '@/context/AppContext';

interface DeleteConfirmDialogProps {
  product: Product;
  onClose: () => void;
}

const DeleteConfirmDialog = ({ product, onClose }: DeleteConfirmDialogProps) => {
  const { removeFromInventory } = useAppContext();

  const handleDelete = () => {
    removeFromInventory(product.id);
    onClose();
  };

  return (
    <AlertDialog open onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete <span className="font-medium">{product.type}</span> ({product.code}) 
            from your inventory. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction 
            onClick={handleDelete}
            className="bg-dental-danger hover:bg-dental-danger/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default DeleteConfirmDialog;
