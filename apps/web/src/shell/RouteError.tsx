import { Button, Card } from '@saga/ui';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, Link, useLocation, useRouteError } from 'react-router';

/**
 * Route-level error boundary. A thrown render error used to blank the whole
 * app; now it lands here, inside the shell, with the failure stated plainly
 * and a way back. The message is shown verbatim — hiding it would just be a
 * less useful kind of honesty.
 */
export function RouteError() {
  const error = useRouteError();
  const location = useLocation();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-lg border-err/30">
        <div className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-err/10 text-err">
              <TriangleAlert className="size-4" />
            </span>
            <div>
              <div className="text-[13px] font-semibold">This view crashed</div>
              <div className="text-[11.5px] text-ink-faint">
                the rest of SAGA is unaffected — capture never runs in this process
              </div>
            </div>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-canvas/60 px-3 py-2 font-mono text-[11.5px] leading-4 text-err">
            {message}
            {stack ? `\n\n${stack.split('\n').slice(1, 6).join('\n')}` : ''}
          </pre>
          <div className="flex items-center gap-2">
            <Button
              variant="solid"
              onClick={() => window.location.assign(location.pathname + location.search)}
            >
              <RotateCcw className="size-3.5" /> reload this view
            </Button>
            <Link
              to="/"
              className="text-[12px] font-medium text-accent hover:underline"
              onClick={() => {
                // A full navigation resets whatever state threw.
                window.location.assign('/');
              }}
            >
              back to overview
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
