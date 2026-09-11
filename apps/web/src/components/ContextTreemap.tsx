import { TreemapChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { type ECharts, init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import { useThemeColors } from '../lib/use-theme-colors';

use([TreemapChart, TooltipComponent, CanvasRenderer]);

/**
 * Lazy-loaded ECharts treemap (custom build: chart + tooltip + canvas only).
 * Canvas cannot resolve CSS variables, so callers pass resolved hex for cell
 * fills and this component resolves its own chrome colors per theme. Labels
 * are white with a dark text stroke — theme-invariant legibility on mid-tone
 * fills, which is why they are the one literal here.
 */
export default function ContextTreemap({
  items,
}: {
  items: Array<{ name: string; value: number; segment: string; color: string }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const [canvas, overlay, line, ink] = useThemeColors([
    '--saga-canvas',
    '--saga-overlay',
    '--saga-line',
    '--saga-ink',
  ]);

  useEffect(() => {
    if (!ref.current) return;
    const chart = init(ref.current);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption({
      tooltip: {
        backgroundColor: overlay,
        borderColor: line,
        textStyle: { color: ink, fontSize: 12 },
        valueFormatter: (v: unknown) => `${Number(v).toLocaleString()} chars`,
      },
      series: [
        {
          type: 'treemap',
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: canvas, borderWidth: 2, gapWidth: 2 },
          label: {
            show: true,
            fontSize: 11,
            color: '#ffffff',
            textBorderColor: 'rgba(0, 0, 0, 0.45)',
            textBorderWidth: 2,
            formatter: '{b}',
          },
          data: items.map((i) => ({
            name: i.name,
            value: i.value,
            itemStyle: { color: i.color, opacity: 0.9 },
          })),
        },
      ],
    });
  }, [items, canvas, overlay, line, ink]);

  return <div ref={ref} className="size-full" />;
}
