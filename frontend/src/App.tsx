import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { MapPage } from './pages/MapPage'
import { FireDetail } from './pages/FireDetail'
import { Reference } from './pages/Reference'
import './App.css'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="map" element={<MapPage />} />
          <Route path="fires/:id" element={<FireDetail />} />
          <Route path="reference" element={<Reference />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
