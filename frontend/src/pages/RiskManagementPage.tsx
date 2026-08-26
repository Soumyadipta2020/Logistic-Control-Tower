import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Clapperboard } from 'lucide-react'
import { PageHeader } from '../components/ui/PageHeader'
import { ExceptionsPage } from './ExceptionsPage'
import { SimulatorPage } from './SimulatorPage'
import { useStore } from '../store/useStore'

type Tab = 'exceptions' | 'simulator'

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'exceptions', label: 'Exceptions', icon: AlertTriangle },
  { key: 'simulator', label: 'Scenario Simulator', icon: Clapperboard },
]

/** Unified risk workspace: live exceptions (each carrying its own AI risk
 *  plan) and the scenario simulator. */
export function RiskManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const p1Count = useStore(s => s.p1Exceptions.length)

  const tabParam = searchParams.get('tab') as Tab | null
  const activeTab: Tab = tabParam && TABS.some(t => t.key === tabParam) ? tabParam : 'exceptions'

  const setTab = (tab: Tab) => setSearchParams(tab === 'exceptions' ? {} : { tab }, { replace: true })

  return (
    <>
      <PageHeader
        title="Risk Management"
        subtitle="Exceptions with AI risk plans · Scenario simulation"
      />
      <div className="page-body">
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={`btn ${activeTab === key ? 'btn-primary' : 'btn-secondary'} btn-sm`}
              onClick={() => setTab(key)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon size={16} /> {label}
                {key === 'exceptions' && p1Count > 0 && (
                  <span style={{
                    fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 10,
                    background: '#EF4444', color: '#fff',
                  }}>
                    {p1Count} P1
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        {activeTab === 'exceptions' && <ExceptionsPage embedded />}
        {activeTab === 'simulator' && <SimulatorPage embedded />}
      </div>
    </>
  )
}
