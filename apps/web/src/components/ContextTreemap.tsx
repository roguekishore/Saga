import { TreemapChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { type ECharts, init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

use([TreemapChart, TooltipComponent, CanvasRenderer]);

/**
 * Lazy-loaded ECharts treemap (custom build: chart + tooltip + canvas only).
 * Loaded via React.lazy so echarts never lands in the initial bundle.
 */
export default function ContextTreemap({
  items,
}: {
  items: Array<{ name: string; value: number; segment: string; color: string }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);

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
        backgroundColor: 'var(--saga-overlay)',
        borderColor: 'var(--saga-line)',
        textStyle: { color: 'var(--saga-ink)', fontSize: 12 },
        valueFormatter: (v: unknown) => `${Number(v).toLocaleString()} chars`,
      },
      series: [
        {
          type: 'treemap',
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: 'var(--saga-canvas)', borderWidth: 2, gapWidth: 2 },
          label: {
            show: true,
            fontSize: 11,
            color: '#fff',
            formatter: '{b}',
          },
          data: items.map((i) => ({
            name: i.name,
            value: i.value,
            itemStyle: { color: i.color, opacity: 0.85 },
          })),
        },
      ],
    });
  }, [items]);

  return <div ref={ref} className="size-full" />;
}
