import type { SVGProps } from 'react';
import type { Role } from '../domain/types';
import { IconAlertTriangle, IconArchive, IconArrowsExchange, IconPulse, IconShield } from './icons';

export interface NavItem {
  to: string;
  label: string;
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
}

/** Primary destinations, role-filtered. Shared by the desktop sidebar and the mobile bottom nav. */
export function navItems(role: Role): NavItem[] {
  const items: NavItem[] = [
    { to: '/', label: 'מצב נוכחי', icon: IconPulse },
    { to: '/incidents', label: 'תקלות', icon: IconAlertTriangle },
    { to: '/handovers', label: 'העברת משמרת', icon: IconArrowsExchange },
    { to: '/archive', label: 'ארכיון', icon: IconArchive },
  ];
  if (role === 'system_admin') items.push({ to: '/admin', label: 'ניהול', icon: IconShield });
  return items;
}
