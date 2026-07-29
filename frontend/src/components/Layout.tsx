import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../useTheme'
import { useSidebarCollapsed } from '../useSidebarCollapsed'
import {
  DashboardIcon,
  MapIcon,
  ReferenceIcon,
  FlameIcon,
  SunIcon,
  MoonIcon,
  ChevronLeftIcon,
} from './icons'
import { StatusBadge } from './StatusBadge'
import { AdminKeyModal } from './AdminKeyModal'

// Fire Detail is reached by selecting a fire from Dashboard/Map (route
// /fires/:id), not a standalone nav link with no fire selected - that would
// be a nav item with nowhere real to go, which is exactly the dead-end
// pattern this project deliberately avoids.
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/map', label: 'Map', Icon: MapIcon },
  { to: '/reference', label: 'Reference', Icon: ReferenceIcon },
]

export function Layout() {
  const { theme, toggle } = useTheme()
  const { collapsed, toggle: toggleSidebar } = useSidebarCollapsed()

  return (
    <div className={'layout' + (collapsed ? ' layout--collapsed' : '')}>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="sidebar-logo-icon">
            <FlameIcon />
          </span>
          {!collapsed && 'WildfireDashboard'}
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              title={collapsed ? label : undefined}
              className={({ isActive }) => 'nav-item' + (isActive ? ' nav-item--active' : '')}
            >
              <Icon />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>
        <button
          className="sidebar-collapse-toggle"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className={collapsed ? 'sidebar-collapse-icon--flipped' : ''}>
            <ChevronLeftIcon />
          </span>
          {!collapsed && <span>Collapse</span>}
        </button>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="eyebrow">Wildfire exposure dashboard — portfolio demo, not an operational tool</span>
          <div className="topbar-utility">
            <StatusBadge />
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
              <span className={theme === 'light' ? 'theme-toggle-active' : ''}>
                <SunIcon />
              </span>
              <span className={theme === 'dark' ? 'theme-toggle-active' : ''}>
                <MoonIcon />
              </span>
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-tabs">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => 'bottom-tab' + (isActive ? ' bottom-tab--active' : '')}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <AdminKeyModal />
    </div>
  )
}
