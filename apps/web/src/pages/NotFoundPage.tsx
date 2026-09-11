import { Button } from '@saga/ui';
import { Compass } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Link, useLocation } from 'react-router';
import { webglAvailable } from '../lib/webgl';
import { Page } from '../shell/Page';

const AmbientField = lazy(() => import('../components/AmbientField'));

export function NotFoundPage() {
  const location = useLocation();
  return (
    <Page flush className="relative flex items-center justify-center overflow-hidden">
      {webglAvailable() ? (
        <Suspense fallback={null}>
          <div className="pointer-events-none absolute inset-0 opacity-50">
            <AmbientField />
          </div>
        </Suspense>
      ) : null}
      <div className="relative flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-full border border-line bg-raised/60 text-ink-faint">
          <Compass className="size-5" />
        </span>
        <div className="font-mono text-[28px] font-semibold tabular-nums tracking-tight">404</div>
        <div className="max-w-sm text-[12.5px] leading-5 text-ink-dim">
          Nothing lives at{' '}
          <code className="rounded bg-raised px-1 py-px font-mono text-[11.5px]">
            {location.pathname}
          </code>
          . If a link brought you here, the resource may predate the current database.
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Link to="/">
            <Button variant="solid">back to overview</Button>
          </Link>
          <Link to="/live">
            <Button>open live monitor</Button>
          </Link>
        </div>
      </div>
    </Page>
  );
}
