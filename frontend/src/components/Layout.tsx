import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../useTheme'

// Fire Detail is reached by selecting a fire from Dashboard/Map (route
// /fires/:id), not a standalone nav link with no fire selected - that would
// be a nav item with nowhere real to go, which is exactly the dead-end
// pattern this project deliberately avoids.
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/map', label: 'Map' },
  { to: '/reference', label: 'Reference' },
]

export function Layout() {
  const { theme, toggle } = useTheme()

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">WildfireDashboard</div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => 'nav-item' + (isActive ? ' nav-item--active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="eyebrow">Portfolio demo — not an operational tool</span>
          <button className="theme-toggle" onClick={toggle}>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-tabs">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => 'bottom-tab' + (isActive ? ' bottom-tab--active' : '')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
