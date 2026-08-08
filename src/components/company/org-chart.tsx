"use client";

import { useEffect, useMemo, useState } from "react";
import ReactFlow, {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "reactflow";
import "reactflow/dist/style.css";

import { PersonNode, type PersonNodeData } from "./person-node";

const TIER_ORDER = ["founder", "head", "lead", "ic", "intern"] as const;
const TIER_LABELS: Record<(typeof TIER_ORDER)[number], string> = {
  founder: "Founders",
  head: "Heads",
  lead: "Leads",
  ic: "ICs",
  intern: "Interns",
};

const COLUMN_WIDTH = 264;
const COLUMN_GAP = 32;
const CARD_HEIGHT = 130;
const CARD_GAP = 14;
const CELL_PADDING_Y = 14;
const CELL_MIN_HEIGHT = 60;
const ROW_LABEL_WIDTH = 96;
const COLUMN_HEADER_HEIGHT = 40;
const UNCLASSIFIED_TIER = "unclassified";
const UNCLASSIFIED_DEPT = "Unclassified";

export interface OrgChartPerson {
  id: string;
  name: string;
  title: string | null;
  department: string | null;
  seniority: string | null;
  linkedin_url: string | null;
  work_email: string | null;
  outreach_status: string | null;
  role_summary: string | null;
  enrichment_status: string | null;
}

export interface CellCoord {
  tier: (typeof TIER_ORDER)[number] | typeof UNCLASSIFIED_TIER;
  department: string;
}

interface CellRect {
  tier: CellCoord["tier"];
  department: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_TYPES: NodeTypes = {
  person: PersonNode,
  cell: CellNode,
  rowLabel: RowLabelNode,
  colLabel: ColLabelNode,
};

interface BuildResult {
  nodes: Node[];
  cells: CellRect[];
  totalWidth: number;
  totalHeight: number;
}

function tierFor(seniority: string | null): CellCoord["tier"] {
  if (!seniority) return UNCLASSIFIED_TIER;
  const t = TIER_ORDER.find((x) => x === seniority);
  return t ?? UNCLASSIFIED_TIER;
}

function deptFor(department: string | null): string {
  return department && department.trim().length > 0
    ? department
    : UNCLASSIFIED_DEPT;
}

export function buildLayout(
  people: OrgChartPerson[],
  onPersonRemove?: (personId: string) => void | Promise<void>,
): BuildResult {
  if (people.length === 0) {
    return { nodes: [], cells: [], totalWidth: 0, totalHeight: 0 };
  }

  // Bucket people into (tier, dept) cells.
  const byCell = new Map<string, OrgChartPerson[]>();
  const tierSet = new Set<CellCoord["tier"]>();
  const deptCount = new Map<string, number>();

  for (const p of people) {
    const tier = tierFor(p.seniority);
    const dept = deptFor(p.department);
    const key = `${tier}::${dept}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key)!.push(p);
    tierSet.add(tier);
    deptCount.set(dept, (deptCount.get(dept) ?? 0) + 1);
  }

  // Tier rows: standard order, plus Unclassified at the bottom if present.
  const rows: CellCoord["tier"][] = [
    ...TIER_ORDER.filter((t) => tierSet.has(t)),
    ...(tierSet.has(UNCLASSIFIED_TIER)
      ? [UNCLASSIFIED_TIER as typeof UNCLASSIFIED_TIER]
      : []),
  ];

  // Department columns: by total headcount desc, Unclassified pinned last.
  const columns: string[] = [...deptCount.entries()]
    .sort((a, b) => {
      if (a[0] === UNCLASSIFIED_DEPT) return 1;
      if (b[0] === UNCLASSIFIED_DEPT) return -1;
      return b[1] - a[1];
    })
    .map(([dept]) => dept);

  // Compute height for each row = max cell height across that row.
  const rowHeights: number[] = rows.map((tier) => {
    let max = CELL_MIN_HEIGHT;
    for (const dept of columns) {
      const members = byCell.get(`${tier}::${dept}`) ?? [];
      if (members.length === 0) continue;
      const h =
        CELL_PADDING_Y * 2 +
        members.length * CARD_HEIGHT +
        Math.max(0, members.length - 1) * CARD_GAP;
      if (h > max) max = h;
    }
    return max;
  });

  // Cumulative y offsets for each row.
  const rowTops: number[] = [];
  let cursor = COLUMN_HEADER_HEIGHT;
  for (let i = 0; i < rows.length; i++) {
    rowTops.push(cursor);
    cursor += rowHeights[i] + CARD_GAP;
  }
  const totalHeight = cursor;

  const totalWidth =
    ROW_LABEL_WIDTH + columns.length * (COLUMN_WIDTH + COLUMN_GAP) - COLUMN_GAP;

  const nodes: Node[] = [];
  const cells: CellRect[] = [];

  // Column header labels.
  columns.forEach((dept, ci) => {
    const x = ROW_LABEL_WIDTH + ci * (COLUMN_WIDTH + COLUMN_GAP);
    nodes.push({
      id: `col-${dept}`,
      type: "colLabel",
      position: { x, y: 0 },
      data: { label: dept, count: deptCount.get(dept) ?? 0 },
      draggable: false,
      selectable: false,
      style: { width: COLUMN_WIDTH, height: COLUMN_HEADER_HEIGHT, zIndex: -1 },
    });
  });

  // Row labels + cell backgrounds + cards.
  rows.forEach((tier, ri) => {
    const yTop = rowTops[ri];
    const rowH = rowHeights[ri];

    nodes.push({
      id: `row-${tier}`,
      type: "rowLabel",
      position: { x: 0, y: yTop },
      data: {
        label: tier === UNCLASSIFIED_TIER ? "Unclassified" : TIER_LABELS[tier],
      },
      draggable: false,
      selectable: false,
      style: { width: ROW_LABEL_WIDTH, height: rowH, zIndex: -1 },
    });

    columns.forEach((dept, ci) => {
      const xLeft = ROW_LABEL_WIDTH + ci * (COLUMN_WIDTH + COLUMN_GAP);
      const members = byCell.get(`${tier}::${dept}`) ?? [];

      cells.push({
        tier,
        department: dept,
        x: xLeft,
        y: yTop,
        width: COLUMN_WIDTH,
        height: rowH,
      });

      nodes.push({
        id: `cell-${tier}-${dept}`,
        type: "cell",
        position: { x: xLeft, y: yTop },
        data: { empty: members.length === 0 },
        draggable: false,
        selectable: false,
        style: { width: COLUMN_WIDTH, height: rowH, zIndex: -1 },
      });

      members.forEach((p, i) => {
        const cardX = xLeft + (COLUMN_WIDTH - 240) / 2;
        const cardY = yTop + CELL_PADDING_Y + i * (CARD_HEIGHT + CARD_GAP);
        nodes.push({
          id: p.id,
          type: "person",
          position: { x: cardX, y: cardY },
          data: {
            personId: p.id,
            name: p.name,
            title: p.title,
            department: p.department,
            seniority: p.seniority,
            linkedin_url: p.linkedin_url,
            work_email: p.work_email,
            outreach_status: p.outreach_status,
            role_summary: p.role_summary,
            enrichment_status: p.enrichment_status,
            onRemove: onPersonRemove,
          } satisfies PersonNodeData,
        });
      });
    });
  });

  return { nodes, cells, totalWidth, totalHeight };
}

function findCellAt(cells: CellRect[], x: number, y: number): CellRect | null {
  for (const c of cells) {
    if (x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height) {
      return c;
    }
  }
  return null;
}

interface OrgChartProps {
  people: OrgChartPerson[];
  onPersonClick?: (personId: string) => void;
  onPersonReclassify?: (
    personId: string,
    next: {
      department: string | null;
      seniority: (typeof TIER_ORDER)[number] | null;
    },
  ) => void;
  onPersonRemove?: (personId: string) => void | Promise<void>;
  /** When false, renders to fill its parent (h-full) instead of h-[70vh]. */
  fullHeight?: boolean;
}

export function OrgChart({
  people,
  onPersonClick,
  onPersonReclassify,
  onPersonRemove,
  fullHeight = true,
}: OrgChartProps) {
  const { nodes: layoutNodes, cells } = useMemo(
    () => buildLayout(people, onPersonRemove),
    [people, onPersonRemove],
  );

  // Controlled nodes NEED onNodesChange applied to state: without it,
  // ReactFlow discards every position change (it only applies them itself
  // when the nodes are uncontrolled), so dragged cards stayed frozen on
  // screen while the invisible drag position moved with the cursor, and
  // onNodeDragStop then reclassified people into cells the card was never
  // seen entering.
  const [nodes, setNodes] = useState<Node[]>(layoutNodes);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNodes(layoutNodes);
  }, [layoutNodes]);

  if (people.length === 0) {
    return (
      <div
        className={
          fullHeight
            ? "text-muted-foreground flex h-[60vh] items-center justify-center text-sm"
            : "text-muted-foreground flex h-full items-center justify-center text-sm"
        }
      >
        No people yet. Try &ldquo;Find more people&rdquo; to populate the chart.
      </div>
    );
  }

  return (
    <div
      className={
        fullHeight
          ? "border-border h-[70vh] w-full overflow-hidden rounded-lg border"
          : "h-full w-full overflow-hidden"
      }
    >
      <ReactFlow
        nodes={nodes}
        onNodesChange={(changes: NodeChange[]) =>
          setNodes((nds) => applyNodeChanges(changes, nds))
        }
        edges={[]}
        nodeTypes={NODE_TYPES}
        onNodeClick={(_, node) => {
          if (node.type === "person" && onPersonClick) {
            onPersonClick(node.id);
          }
        }}
        onNodeDragStop={(_, node) => {
          if (node.type !== "person" || !onPersonReclassify) return;
          // Use the card's center to find the target cell.
          const cx = node.position.x + 240 / 2;
          const cy = node.position.y + CARD_HEIGHT / 2;
          const target = findCellAt(cells, cx, cy);
          if (!target) return;

          const seniority =
            target.tier === UNCLASSIFIED_TIER ? null : target.tier;
          // Map the synthetic Unclassified column back to a real `null` so
          // we don't write the literal string "Unclassified" into the DB --
          // classify-departments only revisits rows where department IS NULL.
          const department =
            target.department === UNCLASSIFIED_DEPT ? null : target.department;
          const person = people.find((p) => p.id === node.id);
          if (!person) return;

          // No-op if dropped in the same cell.
          if (
            (person.seniority ?? null) === seniority &&
            (person.department ?? null) === department
          ) {
            return;
          }

          onPersonReclassify(node.id, { department, seniority });
        }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-muted/50" />
      </ReactFlow>
    </div>
  );
}

function CellNode({ data }: { data: { empty: boolean } }) {
  return (
    <div
      className={
        data.empty
          ? "border-border/40 h-full w-full rounded-md border border-dashed"
          : "border-border/30 bg-muted/10 h-full w-full rounded-md border"
      }
    />
  );
}

function RowLabelNode({ data }: { data: { label: string } }) {
  return (
    <div className="text-muted-foreground flex h-full w-full items-center pr-3 text-xs font-semibold uppercase tracking-wide">
      {data.label}
    </div>
  );
}

function ColLabelNode({ data }: { data: { label: string; count: number } }) {
  return (
    <div className="text-muted-foreground flex h-full w-full items-end pb-1 text-xs font-semibold uppercase tracking-wide">
      {data.label}
      <span className="text-muted-foreground/70 ml-1.5 font-normal">
        {data.count}
      </span>
    </div>
  );
}
