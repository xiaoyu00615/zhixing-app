/**
 * P6-S2 · Editor Quiesce Foundation · App-level provider
 *
 * The coordinator lives at the App level, OUTSIDE the route tree, so it survives
 * route changes. NotesPage/DiaryPage register their editor participants here and
 * the coordinator keeps the unmounting-but-still-flushing editor tracked as
 * RETIRING across the navigation.
 *
 * Ownership rules (per the frozen architecture review):
 *   - SettingsPage does NOT own the coordinator.
 *   - NotesPage does NOT own a global coordinator.
 *   - No window global singleton, no localStorage lock.
 *
 * `instance` is an optional DI seam used only by tests so the test can hold the
 * exact coordinator instance the rendered page registers against. Production
 * always creates its own singleton.
 */

import { createContext, useContext, useState, type ReactNode } from 'react'

import { MaintenanceCoordinator } from './coordinator'
import { platformMaintenancePort } from '@/maintenance/platform'

const MaintenanceCoordinatorContext = createContext<MaintenanceCoordinator | null>(null)

export function MaintenanceCoordinatorProvider({
  children,
  instance,
}: {
  readonly children: ReactNode
  /** Test-only DI seam. When omitted, a single coordinator is created. */
  readonly instance?: MaintenanceCoordinator
}) {
  // Created once per provider mount; `useState` keeps the value stable without
  // reading a ref during render. Production injects the build-selected platform
  // persistence port; tests pass their own `instance`.
  const [coordinator] = useState<MaintenanceCoordinator>(
    () => instance ?? new MaintenanceCoordinator(platformMaintenancePort),
  )
  return (
    <MaintenanceCoordinatorContext.Provider value={coordinator}>
      {children}
    </MaintenanceCoordinatorContext.Provider>
  )
}

/**
 * Require the coordinator. Throws if rendered outside the provider. Used by
 * components that must have maintenance coordination available.
 */
export function useMaintenanceCoordinator(): MaintenanceCoordinator {
  const coordinator = useContext(MaintenanceCoordinatorContext)
  if (coordinator === null) {
    throw new Error(
      'useMaintenanceCoordinator must be used within a MaintenanceCoordinatorProvider',
    )
  }
  return coordinator
}

/**
 * Optional coordinator access. Returns null when no provider is present so that
 * pages (NotesPage/DiaryPage) degrade gracefully in unit tests that do not wrap
 * them with the provider. Production always provides one via App.tsx.
 */
export function useOptionalMaintenanceCoordinator(): MaintenanceCoordinator | null {
  return useContext(MaintenanceCoordinatorContext)
}
