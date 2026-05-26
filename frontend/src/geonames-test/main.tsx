import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import GeoNamesTest from './GeoNamesTest';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GeoNamesTest />
  </StrictMode>,
);
