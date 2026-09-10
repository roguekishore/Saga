import { WsServerMessageSchema } from '@saga/contracts';
import { useEffect } from 'react';
import { useLive } from './live-store';

/**
 * Reconnecting WebSocket → live store. Messages are zod-parsed; anything
 * malformed is dropped loudly in the console rather than corrupting state.
 */
export function useLiveSocket(): void {
  const applyEvent = useLive((s) => s.applyEvent);
  const setConnected = useLive((s) => s.setConnected);
  const setMetrics = useLive((s) => s.setMetrics);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;

    const connect = (): void => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        try {
          const msg = WsServerMessageSchema.parse(JSON.parse(String(e.data)));
          if (msg.type === 'event') applyEvent(msg.event);
          else if (msg.type === 'metrics') setMetrics(msg);
        } catch (err) {
          console.warn('[saga] dropped malformed ws message', err);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt++;
        setTimeout(connect, Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)));
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [applyEvent, setConnected, setMetrics]);
}
