import {
  LayoutDashboard, CheckSquare, Zap, Layers, ScrollText, MessageSquare, SlidersHorizontal,
} from 'lucide-react'

// The single user-facing identity of the agentic layer. The operator only ever sees
// and talks to ATLAS — the specialist capabilities it runs underneath stay internal
// (visible only as a breakdown under the "Capabilities" tab, never as separate agents).
export const MASTER_AGENT = {
  name: 'ATLAS',
  fullName: 'Autonomous Tower Logistics Agent System',
  role: 'Master Agent',
}

// Shared tab definitions for the AI-first experience. Used by both the AppShell
// sidebar (when AI mode is on) and the AI Command Center page, so the nav and
// the content stay in sync via the ?view= query param.
export interface AiTab {
  id: string
  label: string
  icon: React.ElementType
  badge?: 'approvals'   // which live metric drives a count badge, if any
}

export const AI_TABS: AiTab[] = [
  { id: 'overview',   label: 'Command Center', icon: LayoutDashboard },
  { id: 'approvals',  label: 'Approvals',      icon: CheckSquare, badge: 'approvals' },
  { id: 'automated',  label: 'Automated · 24h', icon: Zap },
  { id: 'agents',     label: 'Capabilities',   icon: Layers },
  { id: 'audit',      label: 'Audit Log',      icon: ScrollText },
  { id: 'ask',        label: `Ask ${MASTER_AGENT.name}`, icon: MessageSquare },
  { id: 'governance', label: 'Governance',     icon: SlidersHorizontal },
]

export const AI_TAB_IDS = AI_TABS.map(t => t.id)
export function aiTabLabel(id: string) {
  return AI_TABS.find(t => t.id === id)?.label ?? 'Command Center'
}
