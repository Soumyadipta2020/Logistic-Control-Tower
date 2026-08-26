import { useStore } from '../store/useStore'

export const PAGE_PERMISSIONS: Record<string, string[]> = {
  '/':               ['read:all', 'read:analytics', 'read:finance'],
  '/ai':             ['read:all', 'write:exception', 'write:po', 'read:field', 'read:suppliers', 'read:analytics'],
  '/agents':         ['read:all', 'write:exception', 'write:po', 'read:field', 'read:suppliers', 'read:analytics'],
  '/visibility':     ['read:all', 'read:field', 'read:own_van_stock'],
  '/transport':      ['read:all', 'read:field'],
  '/demand':         ['read:all', 'write:po'],
  '/iot':            ['read:all', 'read:field'],
  '/sustainability': ['read:all', 'read:sustainability', 'read:reverse'],
  '/exceptions':     ['read:all', 'write:exception', 'read:field'],
  '/simulator':      ['read:all', 'write:exception', 'read:field'],
  '/risk':           ['read:all', 'read:suppliers', 'write:supplier_review'],
}

// `<verb>:all` is a wildcard over its own verb: `read:all` holds every `read:*`,
// `export:all` every `export:*`. Verbs never cross — reading everything is not
// permission to write anything. This mirrors `satisfies()` in the backend's
// rbac module; both gates must read a permission set the same way, or the UI
// offers a button the API then refuses (or, worse, hides one it would allow).
export function permitted(held: string[], required: string): boolean {
  if (held.includes(required)) return true
  const verb = required.split(':')[0]
  return required.includes(':') && held.includes(`${verb}:all`)
}

export function usePermissions() {
  const user = useStore((s) => s.user)
  const permissions: string[] = user?.permissions ?? []

  function can(permission: string): boolean {
    return permitted(permissions, permission)
  }

  function canAny(...perms: string[]): boolean {
    return perms.some((p) => permitted(permissions, p))
  }

  function canAccessPage(path: string): boolean {
    const required = PAGE_PERMISSIONS[path]
    if (!required) return true
    return required.some((p) => permitted(permissions, p))
  }

  function firstAccessiblePage(): string {
    return Object.keys(PAGE_PERMISSIONS).find((r) => canAccessPage(r)) ?? '/login'
  }

  return { can, canAny, canAccessPage, firstAccessiblePage, permissions }
}
