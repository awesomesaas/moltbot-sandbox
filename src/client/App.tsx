import { useState } from 'react'
import AdminPage from './pages/AdminPage'
import SalesPage from './pages/SalesPage'
import './App.css'

type Tab = 'sales' | 'admin'

export default function App() {
  const [tab, setTab] = useState<Tab>('sales')

  return (
    <div className="app">
      <header className="app-header">
        <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
        <h1>{tab === 'sales' ? 'Sales Coaching' : 'Moltbot Admin'}</h1>
        <nav className="app-nav">
          <button
            className={`app-tab ${tab === 'sales' ? 'app-tab-active' : ''}`}
            onClick={() => setTab('sales')}
          >
            Sales Coaching
          </button>
          <button
            className={`app-tab ${tab === 'admin' ? 'app-tab-active' : ''}`}
            onClick={() => setTab('admin')}
          >
            Admin
          </button>
        </nav>
      </header>
      <main className="app-main">{tab === 'sales' ? <SalesPage /> : <AdminPage />}</main>
    </div>
  )
}
