import { Route, Routes } from 'react-router-dom'
import Home from './pages/Home.jsx'
import LoginPage from './pages/LoginPage.jsx'
import './App.css'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
    </Routes>
  )
}

export default App
