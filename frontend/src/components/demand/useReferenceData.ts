import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchReferenceData } from '../../lib/api'

/**
 * Master data for the demand & inventory module — network topology, supplier
 * master and the category list — served by the state engine.
 *
 * These used to be hard-coded in the page, which meant the UI held its own copy
 * of the network and supplier list: a supplier added to the engine would never
 * appear in the raise-PO picker, and a new hub would be invisible to the scope
 * selector. Everything here is now whatever the engine says it is.
 */
export function useReferenceData() {
  const { data } = useQuery({
    queryKey: ['reference-data'],
    queryFn: fetchReferenceData,
    staleTime: 5 * 60_000,   // master data — rarely changes within a session
  })

  return useMemo(() => {
    const sites: any[] = data?.sites ?? []
    const suppliers: any[] = data?.suppliers ?? []
    const categories: any[] = data?.categories ?? []
    return {
      ready: !!data,
      sites,
      hubs: sites.filter(s => s.role === 'hub'),
      ndcCode: data?.ndc_code ?? 'LEI_COE',
      hubCodes: (data?.hub_codes ?? []) as string[],
      siteName: Object.fromEntries(sites.map(s => [s.code, s.name])) as Record<string, string>,
      siteShort: Object.fromEntries(sites.map(s => [s.code, s.short])) as Record<string, string>,
      siteLead: Object.fromEntries(sites.map(s => [s.code, s.transfer_lead_days])) as Record<string, number | null>,
      // Scope selector: whole network, then every site the engine knows about
      scopes: [{ code: 'NETWORK', label: 'Whole Network' },
               ...sites.map(s => ({ code: s.code, label: s.name }))],
      categories,
      catLabels: {
        all: 'All SKUs',
        ...Object.fromEntries(categories.map(c => [c.code, c.label])),
      } as Record<string, string>,
      suppliers,
      allSuppliers: suppliers.map(s => ({ code: s.code, name: s.name })),
      // Only the suppliers that actually source a category, from real SKU→supplier links
      suppliersByCategory: (data?.suppliers_by_category ?? {}) as Record<string, { code: string; name: string }[]>,
      catalogueSize: data?.catalogue_size ?? 0,
    }
  }, [data])
}
