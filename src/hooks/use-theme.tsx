
import { useState, useEffect, createContext, useContext } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Check if localStorage is available (for SSR compatibility)
  const isBrowser = typeof window !== 'undefined';
  
  // Check for saved theme or prefer color scheme
  const getSavedTheme = (): Theme => {
    if (!isBrowser) return 'light';
    
    const savedTheme = localStorage.getItem('theme') as Theme | null;
    if (savedTheme) return savedTheme;
    
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  };

  const [theme, setThemeState] = useState<Theme>(getSavedTheme());

  // Apply and save theme when it changes
  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    if (isBrowser) {
      localStorage.setItem('theme', newTheme);
    }
  };

  // Add dark class to document if theme is dark
  useEffect(() => {
    if (isBrowser) {
      const root = window.document.documentElement;
      if (theme === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }
  }, [theme, isBrowser]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
