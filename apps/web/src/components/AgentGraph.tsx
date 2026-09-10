import type { AgentSummary } from '@saga/contracts';
import { AggValue, fmtInt, InferredTag } from '@saga/ui';
import {
  Background,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { useEffect, useState } from 'react';
import '@xyflow/react/dist/style.css';

/**
 * Agent Graph on React Flow + ELK (pinned stack), lazy-loaded so neither
 * touches the initial bundle. Every edge is an inference — the graph header
 * and each node carry the inferred tag.
 */

type AgentNode = Node<{ agent: AgentSummary }, 'agent'>;

const elk = new ELK();

function AgentNodeView({ data }: NodeProps<AgentNode>) {
  const a = data.agent;
  return (
    <div className="min-w-[190px] rounded-lg border border-inferred/50 bg-surface px-3 py-2 shadow-md">
      <Handle type="target" position={Position.Top} className="!bg-inferred" />
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[12.5px] font-semibold text-ink">{a.label}</span>
        <InferredTag what="agent" />
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-ink-dim">
        <span>{fmtInt(a.requests)} req</span>
        <AggValue agg={a.outputTokens} />
        <span>{a.toolUseCount} tools</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-inferred" />
    </div>
  );
}

const nodeTypes = { agent: AgentNodeView };

export default function AgentGraph({ agents }: { agents: AgentSummary[] }) {
  const [layout, setLayout] = useState<{ nodes: AgentNode[]; edges: Edge[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const nodes = agents.map((a) => ({
      id: a.agentId,
      width: 210,
      height: 64,
    }));
    const edges = agents
      .filter((a) => a.parentAgentId)
      .map((a) => ({
        id: `${a.parentAgentId}->${a.agentId}`,
        sources: [a.parentAgentId!],
        targets: [a.agentId],
      }));

    elk
      .layout({
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'DOWN',
          'elk.spacing.nodeNode': '40',
          'elk.layered.spacing.nodeNodeBetweenLayers': '56',
        },
        children: nodes,
        edges,
      })
      .then((g) => {
        if (cancelled) return;
        setLayout({
          nodes: agents.map((a) => {
            const pos = g.children?.find((c) => c.id === a.agentId);
            return {
              id: a.agentId,
              type: 'agent' as const,
              position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
              data: { agent: a },
            };
          }),
          edges: agents
            .filter((a) => a.parentAgentId)
            .map((a) => ({
              id: `${a.parentAgentId}->${a.agentId}`,
              source: a.parentAgentId!,
              target: a.agentId,
              animated: true,
              style: { stroke: 'var(--saga-inferred)', strokeDasharray: '5 4' },
            })),
        });
      })
      .catch(() => setLayout({ nodes: [], edges: [] }));
    return () => {
      cancelled = true;
    };
  }, [agents]);

  if (!layout) return <div className="p-6 text-[12px] text-ink-faint">laying out…</div>;

  return (
    <ReactFlow
      nodes={layout.nodes}
      edges={layout.edges}
      nodeTypes={nodeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      colorMode="dark"
      className="!bg-transparent"
    >
      <Background gap={18} size={1} color="var(--saga-line)" />
    </ReactFlow>
  );
}
