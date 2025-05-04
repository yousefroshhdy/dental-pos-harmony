
import React from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { AppProvider } from '@/context/AppContext';

const Index = () => {
  return (
    <AppProvider>
      <AppLayout />
    </AppProvider>
  );
};

export default Index;
