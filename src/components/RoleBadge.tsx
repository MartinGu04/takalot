import type { Role } from '../domain/types';
import { roleLabels } from '../domain/labels';
import { IconBriefcase, IconEye, IconHeadset, IconShield, IconWrench } from './icons';

const roleIcon: Record<Role, (props: { className?: string }) => React.JSX.Element> = {
  system_admin: IconShield,
  professional_manager: IconBriefcase,
  shift_supervisor: IconHeadset,
  technician: IconWrench,
  viewer: IconEye,
};

/**
 * Restrained role identifier: an icon + label, not a fifth color competing
 * with the severity/status palette. system_admin gets a brand tint since
 * it's the elevated role; every other role stays neutral.
 */
export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  const Icon = roleIcon[role];
  const brand = role === 'system_admin';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium ${
        brand
          ? 'border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-200'
          : 'border-hairline bg-surface-active text-text-secondary'
      } ${className ?? ''}`}
    >
      <Icon className="size-3.5 shrink-0" />
      {roleLabels[role]}
    </span>
  );
}
