
import React, { createContext, useState, useContext, ReactNode, useEffect } from 'react';
import { Product, CartItem, Invoice, InventoryFilter, Client } from '@/types';
import { toast } from '@/components/ui/use-toast';
import { v4 as uuidv4 } from 'uuid';

interface AppContextType {
  inventory: Product[];
  cart: CartItem[];
  invoices: Invoice[];
  filter: InventoryFilter;
  clients: Client[];
  setInventory: (inventory: Product[]) => void;
  addToInventory: (product: Product) => void;
  updateInventoryItem: (product: Product) => void;
  removeFromInventory: (id: string) => void;
  addToCart: (product: Product, quantity: number) => void;
  removeFromCart: (id: string) => void;
  clearCart: () => void;
  updateCartItemQuantity: (id: string, quantity: number) => void;
  createInvoice: () => Invoice | undefined;
  setFilter: (filter: Partial<InventoryFilter>) => void;
  resetFilter: () => void;
  processReturn: (code: string, quantity: number) => void;
  addClient: (client: Client) => void;
  updateClient: (client: Client) => void;
  removeClient: (id: string) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const loadState = (key: string, defaultValue: any) => {
  try {
    const saved = localStorage.getItem(key);
    if (saved === null) {
      return defaultValue;
    }
    return JSON.parse(saved);
  } catch (err) {
    console.error("Failed to load state from localStorage:", err);
    return defaultValue;
  }
};

const saveState = (key: string, value: any) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error("Failed to save state to localStorage:", err);
  }
};

export function AppProvider({ children }: { children: ReactNode }) {
  // Default inventory with dental products
  const defaultInventory = [
    { id: '1', code: 'DC001', type: 'Dental Chair', color: 'White', price: 12500, quantity: 5 },
    { id: '2', code: 'DL001', type: 'LED Dental Light', color: 'Silver', price: 3200, quantity: 8 },
    { id: '3', code: 'DU001', type: 'Complete Dental Unit', color: 'White', price: 25000, quantity: 3 },
    { id: '4', code: 'XR001', type: 'Digital X-Ray Machine', color: 'White/Blue', price: 45000, quantity: 2 },
    { id: '5', code: 'AC001', type: 'Class B Autoclave 18L', color: 'Silver', price: 7800, quantity: 6 },
    { id: '6', code: 'DS001', type: 'Doctor Stool', color: 'Black', price: 1350, quantity: 10 },
    { id: '7', code: 'AS001', type: 'Assistant Stool', color: 'Blue', price: 1150, quantity: 8 },
    { id: '8', code: 'SC001', type: 'Dental Scaler', color: 'Silver', price: 850, quantity: 15 },
    { id: '9', code: 'CM001', type: 'Dental Compressor', color: 'White', price: 6500, quantity: 4 },
    { id: '10', code: 'SU001', type: 'Surgical Handpiece', color: 'Silver', price: 3500, quantity: 12 },
    { id: '11', code: 'HS001', type: 'High-Speed Handpiece', color: 'Silver/Gold', price: 2200, quantity: 20 },
    { id: '12', code: 'LS001', type: 'Low-Speed Handpiece', color: 'Silver', price: 1800, quantity: 15 },
    { id: '13', code: 'LC001', type: 'LED Curing Light', color: 'Blue', price: 950, quantity: 25 },
    { id: '14', code: 'AV001', type: 'Amalgamator', color: 'White', price: 1250, quantity: 7 },
    { id: '15', code: 'IM001', type: 'Intra-oral Camera', color: 'White', price: 3800, quantity: 5 },
    { id: '16', code: 'US001', type: 'Ultrasonic Cleaner', color: 'Silver', price: 2500, quantity: 6 },
    { id: '17', code: 'AP001', type: 'Apex Locator', color: 'Black', price: 1750, quantity: 8 },
    { id: '18', code: 'RU001', type: 'Root Canal Treatment Unit', color: 'White', price: 4500, quantity: 3 },
    { id: '19', code: 'CS001', type: 'Cabinet Set', color: 'White/Wood', price: 8500, quantity: 2 },
    { id: '20', code: 'OS001', type: 'Oral Suction Machine', color: 'White', price: 1950, quantity: 7 },
  ];
  
  // Sample clients
  const defaultClients = [
    { id: 'c1', name: 'Dr. Ahmed Hassan', phone: '01234567890', email: 'ahmed.hassan@example.com', address: 'Cairo, Egypt' },
    { id: 'c2', name: 'Dr. Fatma Khalid', phone: '01112345678', email: 'fatma.k@example.com', address: 'Alexandria, Egypt' },
    { id: 'c3', name: 'Dr. Mohamed Ali', phone: '01023456789', email: 'mohamed.ali@example.com', address: 'Giza, Egypt' },
  ];
  
  // Sample invoices
  const defaultInvoices = [
    {
      invoiceNumber: 'INV-000997',
      date: '2024-05-01T10:30:00.000Z',
      items: [
        {
          id: '1', 
          code: 'DC001', 
          type: 'Dental Chair', 
          color: 'White', 
          price: 12500, 
          quantity: 5, 
          cartQuantity: 1, 
          subtotal: 12500
        },
        {
          id: '5', 
          code: 'AC001', 
          type: 'Class B Autoclave 18L', 
          color: 'Silver', 
          price: 7800, 
          quantity: 6, 
          cartQuantity: 1, 
          subtotal: 7800
        }
      ],
      total: 20300
    },
    {
      invoiceNumber: 'INV-000998',
      date: '2024-05-02T14:15:00.000Z',
      items: [
        {
          id: '13', 
          code: 'LC001', 
          type: 'LED Curing Light', 
          color: 'Blue', 
          price: 950, 
          quantity: 25, 
          cartQuantity: 2, 
          subtotal: 1900
        }
      ],
      total: 1900
    },
    {
      invoiceNumber: 'INV-000999',
      date: '2024-05-03T11:45:00.000Z',
      items: [
        {
          id: '10', 
          code: 'SU001', 
          type: 'Surgical Handpiece', 
          color: 'Silver', 
          price: 3500, 
          quantity: 12, 
          cartQuantity: 1, 
          subtotal: 3500
        },
        {
          id: '11', 
          code: 'HS001', 
          type: 'High-Speed Handpiece', 
          color: 'Silver/Gold', 
          price: 2200, 
          quantity: 20, 
          cartQuantity: 2, 
          subtotal: 4400
        },
        {
          id: '12', 
          code: 'LS001', 
          type: 'Low-Speed Handpiece', 
          color: 'Silver', 
          price: 1800, 
          quantity: 15, 
          cartQuantity: 2, 
          subtotal: 3600
        }
      ],
      total: 11500
    }
  ];
  
  // Load state from localStorage or use defaults
  const [inventory, setInventoryState] = useState<Product[]>(loadState('inventory', defaultInventory));
  const [cart, setCart] = useState<CartItem[]>(loadState('cart', []));
  const [invoices, setInvoices] = useState<Invoice[]>(loadState('invoices', defaultInvoices));
  const [clients, setClients] = useState<Client[]>(loadState('clients', defaultClients));
  const [nextInvoiceNumber, setNextInvoiceNumber] = useState<number>(loadState('nextInvoiceNumber', 1000));
  const [filter, setFilterState] = useState<InventoryFilter>({
    searchTerm: '',
    type: 'All',
    color: 'All',
  });

  // Save to localStorage whenever state changes
  useEffect(() => {
    saveState('inventory', inventory);
  }, [inventory]);

  useEffect(() => {
    saveState('invoices', invoices);
  }, [invoices]);

  useEffect(() => {
    saveState('clients', clients);
  }, [clients]);

  useEffect(() => {
    saveState('cart', cart);
  }, [cart]);

  useEffect(() => {
    saveState('nextInvoiceNumber', nextInvoiceNumber);
  }, [nextInvoiceNumber]);

  const setInventory = (newInventory: Product[]) => {
    setInventoryState(newInventory);
  };

  const addToInventory = (product: Product) => {
    setInventoryState([...inventory, product]);
    toast({
      title: "Product added",
      description: "New product has been added to inventory"
    });
  };

  const updateInventoryItem = (updatedProduct: Product) => {
    setInventoryState(
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
    setInventoryState(inventory.filter(item => item.id !== id));
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
    
    setInventoryState(updatedInventory);
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
    
    setInventoryState(updatedInventory);
    
    toast({
      title: "Return processed",
      description: `${quantity} units of ${code} returned to inventory`
    });
  };

  // Client management functions
  const addClient = (client: Client) => {
    setClients([...clients, client]);
    toast({
      title: "Client added",
      description: "New client has been added"
    });
  };

  const updateClient = (updatedClient: Client) => {
    setClients(
      clients.map(client => 
        client.id === updatedClient.id ? updatedClient : client
      )
    );
    toast({
      title: "Client updated",
      description: "Client information has been updated"
    });
  };

  const removeClient = (id: string) => {
    setClients(clients.filter(client => client.id !== id));
    toast({
      title: "Client removed",
      description: "Client has been removed"
    });
  };

  return (
    <AppContext.Provider value={{
      inventory,
      cart,
      invoices,
      filter,
      clients,
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
      processReturn,
      addClient,
      updateClient,
      removeClient
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
