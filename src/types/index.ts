
export interface Product {
  id: string;
  code: string;
  type: string;
  color: string;
  price: number;
  quantity: number;
}

export interface CartItem extends Product {
  cartQuantity: number;
  subtotal: number;
}

export interface Invoice {
  invoiceNumber: string;
  date: string;
  items: CartItem[];
  total: number;
}

export interface InventoryFilter {
  searchTerm: string;
  type: string;
  color: string;
}
