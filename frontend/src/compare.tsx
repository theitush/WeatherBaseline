import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ComparePage from './pages/ComparePage'
import { UnitsContext, useUnitsState } from './hooks/useUnits'

function Root() {
  const units = useUnitsState()
  return (
    <UnitsContext.Provider value={units}>
      <ComparePage />
    </UnitsContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
