import type { SVGProps } from 'react';
import type { Role } from '../domain/types';
import { IconAlertTriangle, IconArchive, IconPulse, IconShield, IconUsers } from './icons';

export interface NavItem {
  to: string;
  label: string;
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
}

/** Primary destinations, role-filtered. Shared by the desktop sidebar and the mobile
 *  bottom nav (which shows only the first 4 -- see Layout.tsx). העברת משמרת is
 *  deliberately not a primary destination here: the /handovers route, page, and all
 *  handover functionality are untouched, just not linked from primary navigation
 *  (users get there via in-context links, e.g. from an incident). Because כוח אדם is
 *  positioned right after ארכיון, an authorized role's mobile bottom nav naturally
 *  picks it up as its 4th slot; a role without personnel access simply gets 3 items,
 *  never a meaningless filler. */
export function navItems(role: Role): NavItem[] {
  const items: NavItem[] = [
    { to: '/', label: 'מצב נוכחי', icon: IconPulse },
    { to: '/incidents', label: 'תקלות', icon: IconAlertTriangle },
    { to: '/archive', label: 'ארכיון', icon: IconArchive },
  ];
  if (['shift_supervisor', 'professional_manager', 'system_admin'].includes(role)) {
    items.push({ to: '/personnel', label: 'כוח אדם', icon: IconUsers });
  }
  if (role === 'system_admin') items.push({ to: '/admin', label: 'ניהול', icon: IconShield });
  return items;
}
