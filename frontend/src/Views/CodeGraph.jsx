import React from 'react';
import { withRouter } from '@sfework/common';
import { Select, Typography, Tag,Button } from '@douyinfe/semi-ui';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
import { TablePage, SearchBox, ToastUI } from '../Common/Component';
import Net from '../Common/Net';

/**
 * CodeGraph 页（/api/codegraph，DESIGN §2.8、决策 54）：
 * 筛选区 = 项目下拉（默认最近活跃的项目）；下方为代码关系图（力导向布局，d3-force 计算 + SVG 自绘）。
 * 节点=符号（按 kind 着色），边=调用关系（calls）。切换项目即刷新图；索引未 ready 时提示并轮询。
 * 支持滚轮缩放（以鼠标位置为中心）与拖拽平移；后端按节点度数取 top 150 防大图爆炸。
 */
const KIND_COLOR = {
    function: '#4C6EF5',
    method: '#12B886',
    class: '#F59F00',
    interface: '#BE4BDB',
    type: '#97743C',
    enum: '#E8590C',
    variable: '#4DABF7',
    property: '#868E96',
    // vendored 库扩展 kind（决策 67）
    struct: '#F59F00',
    trait: '#BE4BDB',
    constant: '#4DABF7',
    field: '#868E96',
    route: '#D6336C',
    component: '#D6336C',
};
const STATUS_TAG = {
    ready: ['green', '索引就绪'],
    indexing: ['orange', '索引构建中'],
    pending: ['orange', '排队构建'],
    failed: ['red', '索引失败'],
    absent: ['grey', '尚未索引'],
};

/** 同步跑力导向布局（固定迭代次数，结果确定、无动画抖动）。 */
function layout(nodes, edges, width, height) {
    const ns = nodes.map(n => ({ ...n }));
    const ls = edges.map(e => ({ source: e.from, target: e.to }));
    const sim = forceSimulation(ns)
        .force('link', forceLink(ls).id(d => d.id).distance(70).strength(0.4))
        .force('charge', forceManyBody().strength(-160))
        .force('center', forceCenter(width / 2, height / 2))
        .force('collide', forceCollide(22))
        .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    return { nodes: ns, links: ls };
}

class CodeGraph extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            projects: [],
            projectId: null,
            graph: null,       // {status, nodes, edges, stats, message, progress}
            loading: false,
            rebuilding: false,
            view: { k: 1, x: 0, y: 0 },
        };
        this.pollTimer = null;
    }
    componentDidMount() {
        Net.api.projects.list({ page: 1, pageSize: 1000 }).then(result => {
            if (!result.success) return;
            const projects = result.data.list;
            // 默认最后活跃的项目
            const latest = projects.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0];
            this.setState({ projects, projectId: latest ? latest.id : null },
                () => { if (latest) this.loadGraph(latest.id); });
        });
    }
    componentWillUnmount() { this.stopPoll(); }
    stopPoll = () => { if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; } };
    loadGraph = (projectId) => {
        this.stopPoll();
        this.setState({ loading: true, view: { k: 1, x: 0, y: 0 } });
        Net.api.codegraph.graph({ id: projectId, maxNodes: 150 }).then(result => {
            if (result.success) {
                this.setState({ graph: result.data, loading: false });
                // 未 ready：5s 轮询刷新
                if (result.data.status === 'indexing' || result.data.status === 'pending') {
                    this.pollTimer = setInterval(() => this.loadGraph(projectId), 5000);
                }
            } else this.setState({ loading: false });
        });
    };
    onProjectChange = (v) => {
        this.setState({ projectId: v }, () => this.loadGraph(v));
    };
    rebuild = () => {
        const { projectId } = this.state;
        if (!projectId || this.state.rebuilding) return;
        this.setState({ rebuilding: true });
        Net.api.codegraph.rebuild({ id: projectId }).then(result => {
            if (result.success) {
                ToastUI.success('重建已排队，索引完成后自动刷新');
                this.loadGraph(projectId);
            }
            this.setState({ rebuilding: false });
        }).catch(() => this.setState({ rebuilding: false }));
    };
    onWheel = (e) => {
        // 滚轮缩放：以鼠标所在位置为中心（鼠标下的图元保持不动）。
        const { k, x, y } = this.state.view;
        const k2 = Math.min(8, Math.max(0.15, k * (e.deltaY < 0 ? 1.15 : 0.87)));
        if (k2 === k) return;
        // 鼠标 client 坐标 → SVG viewBox 用户坐标（getScreenCTM 已含 viewBox/preserveAspectRatio 映射）。
        let cx = 0, cy = 0;
        const svg = e.currentTarget.querySelector('svg');
        if (svg && svg.createSVGPoint) {
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const ctm = svg.getScreenCTM();
            if (ctm) {
                const u = pt.matrixTransform(ctm.inverse());
                cx = u.x;
                cy = u.y;
            }
        }
        const ratio = k2 / k;
        this.setState({ view: { k: k2, x: cx - (cx - x) * ratio, y: cy - (cy - y) * ratio } });
    };
    onMouseDown = (e) => {
        const start = { x: e.clientX, y: e.clientY, vx: this.state.view.x, vy: this.state.view.y };
        const move = (ev) => this.setState({ view: { ...this.state.view, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y } });
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    };
    render() {
        const { projects, projectId, graph, loading, view } = this.state;
        const st = graph ? (STATUS_TAG[graph.status] || STATUS_TAG.absent) : null;
        return <TablePage>
            <SearchBox onSearch={() => projectId && this.loadGraph(projectId)}>
                <Select style={{ width: 280,marginRight:8 }} optionList={projects.map(p => ({ label: p.name, value: p.id }))}
                    value={projectId ?? undefined} onChange={this.onProjectChange} placeholder='选择项目' filter />
                <div>
                    <Button loading={loading} theme='solid' type="warning" htmlType="submit" block>刷新</Button>
                </div>
                <div style={{ marginLeft: 8 }}>
                    <Button loading={this.state.rebuilding} disabled={!projectId} theme='solid' type='primary'
                        onClick={this.rebuild}>重建</Button>
                </div>
                <SearchBox.Actions>
                    {st && <Tag color={st[0]}>{st[1]}</Tag>}
                    {graph && graph.status === 'ready' && (
                        <Typography.Text type='tertiary' style={{ marginLeft: 12 }}>
                            符号 {graph.stats.totalSymbols} / 展示 {graph.stats.shownNodes} · 调用边 {graph.stats.totalEdges} / 展示 {graph.stats.shownEdges}
                        </Typography.Text>
                    )}
                </SearchBox.Actions>
            </SearchBox>
            <div className='cgCanvas' onWheel={this.onWheel} onMouseDown={this.onMouseDown}>
                {loading && <div className='cgHint'>加载中…</div>}
                {!loading && !projectId && <div className='cgHint'>暂无项目，先在网关发起一次请求登记项目</div>}
                {!loading && projectId && graph && graph.status !== 'ready' && (
                    <div className='cgHint'>
                        {graph.message || '索引不可用'}
                        {graph.progress ? `（${graph.progress.indexed}/${graph.progress.total}）` : ''}
                        {graph.status === 'indexing' || graph.status === 'pending' ? '，每 5 秒自动刷新' : ''}
                    </div>
                )}
                {!loading && projectId && graph && graph.status === 'ready' && graph.nodes.length === 0 && (
                    <div className='cgHint'>该项目没有符号节点</div>
                )}
                {!loading && projectId && graph && graph.status === 'ready' && graph.nodes.length > 0 &&
                    <GraphSvg graph={graph} view={view} />}
            </div>
        </TablePage>;
    }
}

/** SVG 绘制：先力导向布局，再画边（带箭头）与节点（按 kind 着色 + 名称标签）。 */
function GraphSvg({ graph, view }) {
    const W = 1400, H = 900;
    const { nodes, links } = React.useMemo(() => layout(graph.nodes, graph.edges, W, H), [graph]);
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    return <svg width='100%' height='100%' viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='xMidYMid meet'
        style={{ cursor: 'grab', display: 'block' }}>
        <defs>
            <marker id='cgArrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='5' markerHeight='5' orient='auto-start-reverse'>
                <path d='M 0 0 L 10 5 L 0 10 z' fill='var(--semi-color-text-2)' />
            </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {links.map((l, i) => {
                const s = typeof l.source === 'object' ? l.source : byId[l.source];
                const t = typeof l.target === 'object' ? l.target : byId[l.target];
                if (!s || !t) return null;
                return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                    stroke='var(--semi-color-border)' strokeWidth={1} markerEnd='url(#cgArrow)' opacity={0.7} />;
            })}
            {nodes.map(n => (
                <g key={n.id} transform={`translate(${n.x},${n.y})`}>
                    <circle r={9} fill={KIND_COLOR[n.kind] || '#868E96'} stroke='var(--semi-color-bg-1)' strokeWidth={1.5}>
                        <title>{`${n.kind} ${n.qualifiedName || n.name}${n.file ? `\n${n.file}` : ''}`}</title>
                    </circle>
                    <text y={22} textAnchor='middle' fontSize={11} fill='var(--semi-color-text-1)'
                        style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        {(() => { const l = n.qualifiedName || n.name; return l.length > 22 ? l.slice(0, 21) + '…' : l; })()}
                    </text>
                </g>
            ))}
        </g>
    </svg>;
}

export default withRouter(CodeGraph);
