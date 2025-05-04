
import React, { createContext, useState, useContext, ReactNode } from 'react';
import { Product, CartItem, Invoice, InventoryFilter } from '@/types';
import { toast } from '@/components/ui/use-toast';

interface AppContextType {
  inventory: Product[];
  cart: CartItem[];
  invoices: Invoice[];
  filter: InventoryFilter;
  setInventory: (inventory: Product[]) => void;
  addToInventory: (product: Product) => void;
  updateInventoryItem: (product: Product) => void;
  removeFromInventory: (id: string) => void;
  addToCart: (product: Product, quantity: number) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;
  updateCartItemQuantity: (id: string, quantity: number) => void;
  createInvoice: () => void;
  setFilter: (filter: Partial<InventoryFilter>) => void;
  resetFilter: () => void;
  processReturn: (code: string, quantity: number) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [inventory, setInventory] = useState<Product[]>([
    { id: '1', code: 'D001', type: 'Dental Chair', color: 'White', price: 2500, quantity: 5 },
    { id: '2', code: 'D002', type: 'Dental Light', color: 'Silver', price: 1200, quantity: 8 },
    { id: '3', code: 'D003', type: 'Dental Unit', color: 'White', price: 3500, quantity: 3 },
    { id: '4', code: 'D004', type: 'X-Ray Machine', color: 'White', price: 4500, quantity: 2 },
    { id: '5', code: 'D005', type: 'Autoclave', color: 'Silver', price: 1800, quantity: 6 },
    { id: '6', code: 'D006', type: 'Dental Stool', color: 'Black', price: 350, quantity: 10 },
  ]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [nextInvoiceNumber, setNextInvoiceNumber] = useState<number>(1000);
  const [filter, setFilterState] = useState<InventoryFilter>({
    searchTerm: '',
    type: 'All',
    color: 'All',
  });

  const addToInventory = (product: Product) => {
    setInventory([...inventory, product]);
    toast({
      title: "Product added",
      description: "New product has been added to inventory"
    });
  };

  const updateInventoryItem = (updatedProduct: Product) => {
    setInventory(
      inventory.map(item => 
        item.id === updatedProduct.id ? updatedProduct : item
      )
    );
    toast({
      title: "Product updated",
      description: "Product has been updated in inventory"
    });
  };

  const removeFromInventory = (id: string) => {
    setInventory(inventory.filter(item => item.id !== id));
    toast({
      title: "Product removed",
      description: "Product has been removed from inventory"
    });
  };

  const addToCart = (product: Product, quantity: number) => {
    if (quantity <= 0) {
      toast({
        title: "Invalid quantity",
        description: "Quantity must be greater than 0",
        variant: "destructive"
      });
      return;
    }

    if (quantity > product.quantity) {
      toast({
        title: "Insufficient stock",
        description: `Only ${product.quantity} items available`,
        variant: "destructive"
      });
      return;
    }

    const existingItem = cart.find(item => item.id === product.id);
    
    if (existingItem) {
      const newQuantity = existingItem.cartQuantity + quantity;
      
      if (newQuantity > product.quantity) {
        toast({
          title: "Insufficient stock",
          description: "Cannot add more of this item to cart",
          variant: "destructive"
        });
        return;
      }
      
      updateCartItemQuantity(product.id, newQuantity);
    } else {
      const cartItem: CartItem = {
        ...product,
        cartQuantity: quantity,
        subtotal: product.price * quantity
      };
      
      setCart([...cart, cartItem]);
      toast({
        title: "Item added to cart",
        description: `${quantity} x ${product.type} added to cart`
      });
    }
  };

  const removeFromCart = (id: string) => {
    setCart(cart.filter(item => item.id !== id));
    toast({
      title: "Item removed",
      description: "Item has been removed from cart"
    });
  };

  const clearCart = () => {
    setCart([]);
  };

  const updateCartItemQuantity = (id: string, quantity: number) => {
    const product = inventory.find(item => item.id === id);
    
    if (!product) {
      toast({
        title: "Error",
        description: "Product not found",
        variant: "destructive"
      });
      return;
    }
    
    if (quantity > product.quantity) {
      toast({
        title: "Insufficient stock",
        description: `Only ${product.quantity} items available`,
        variant: "destructive"
      });
      return;
    }
    
    setCart(
      cart.map(item => {
        if (item.id === id) {
          return {
            ...item,
            cartQuantity: quantity,
            subtotal: product.price * quantity
          };
        }
        return item;
      })
    );
    
    toast({
      title: "Cart updated",
      description: "Item quantity has been updated"
    });
  };

  const createInvoice = () => {
    if (cart.length === 0) {
      toast({
        title: "Empty cart",
        description: "Cannot create invoice with an empty cart",
        variant: "destructive"
      });
      return;
    }

    const invoice: Invoice = {
      invoiceNumber: `INV-${nextInvoiceNumber.toString().padStart(6, '0')}`,
      date: new Date().toISOString(),
      items: [...cart],
      total: cart.reduce((sum, item) => sum + item.subtotal, 0)
    };

    setInvoices([...invoices, invoice]);
    
    // Update inventory quantities
    const updatedInventory = inventory.map(item => {
      const cartItem = cart.find(cartItem => cartItem.id === item.id);
      if (cartItem) {
        return {
          ...item,
          quantity: item.quantity - cartItem.cartQuantity
        };
      }
      return item;
    });
    
    setInventory(updatedInventory);
    setNextInvoiceNumber(nextInvoiceNumber + 1);
    clearCart();
    
    toast({
      title: "Invoice created",
      description: `Invoice #${invoice.invoiceNumber} has been created`
    });

    return invoice;
  };

  const setFilter = (newFilter: Partial<InventoryFilter>) => {
    setFilterState({ ...filter, ...newFilter });
  };

  const resetFilter = () => {
    setFilterState({
      searchTerm: '',
      type: 'All',
      color: 'All',
    });
  };

  const processReturn = (code: string, quantity: number) => {
    const productIndex = inventory.findIndex(item => item.code === code);
    
    if (productIndex === -1) {
      toast({
        title: "Product not found",
        description: "The product code does not exist in inventory",
        variant: "destructive"
      });
      return;
    }
    
    const updatedInventory = [...inventory];
    updatedInventory[productIndex] = {
      ...updatedInventory[productIndex],
      quantity: updatedInventory[productIndex].quantity + quantity
    };
    
    setInventory(updatedInventory);
    
    toast({
      title: "Return processed",
      description: `${quantity} units of ${code} returned to inventory`
    });
  };

  return (
    <AppContext.Provider value={{
      inventory,
      cart,
      invoices,
      filter,
      setInventory,
      addToInventory,
      updateInventoryItem,
      removeFromInventory,
      addToCart,
      removeFromCart,
      clearCart,
      updateCartItemQuantity,
      createInvoice,
      setFilter,
      resetFilter,
      processReturn
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
