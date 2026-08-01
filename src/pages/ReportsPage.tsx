// Placeholder for the future reports/analytics section. No operational data,
// filters, or exports yet -- every authenticated role can see this screen
// (see navItems.tsx), so it must stay a pure, restrained "coming soon" empty
// state until the real feature ships.
import { IconChartBar } from '../components/icons';
import { Badge } from '../components/ui';

export default function ReportsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="surface flex flex-col items-center gap-3 px-6 py-16 text-center sm:py-20">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/60 dark:text-brand-300">
          <IconChartBar className="size-8" />
        </div>
        <h1 className="page-title mt-2">דוחות</h1>
        <Badge color="brand">
          <span dir="ltr">COMING SOON</span>
        </Badge>
        <p className="mt-1 max-w-sm text-sm text-muted">
          מרכז הדוחות והניתוחים של AVARIA יתווסף בגרסה עתידית.
        </p>
      </div>
    </div>
  );
}
