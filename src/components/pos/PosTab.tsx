
import React from 'react';
import ProductList from './ProductList';
import ShoppingCart from './ShoppingCart';

const PosTab = () => {
  return (
    <div>
      <h2 className="text-2xl font-bold text-dental-dark mb-6">Point of Sale</h2>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ProductList />
        <ShoppingCart />
      </div>
    </div>
  );
};

export default PosTab;
